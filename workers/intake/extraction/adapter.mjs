import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse } from 'csv-parse/sync';
import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { PROFILE } from './profile.mjs';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
if (XLSX.version !== '0.20.3') throw new Error('Unexpected loaded SheetJS version');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const scalar = value => value === undefined ? undefined : typeof value === 'object' ? value['#text'] ?? '' : String(value);
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, removeNSPrefix: true, trimValues: false, processEntities: true });

export function strictText(bytes) {
  if (bytes.subarray(0, 2).equals(Buffer.from([255, 254])) || bytes.subarray(0, 2).equals(Buffer.from([254, 255]))) fail('unsupported_encoding');
  const bomBytes = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) ? 3 : 0;
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bomBytes)), bomBytes }; }
  catch { fail('invalid_utf8'); }
}

async function zipParts(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  const parts = new Map();
  let declared = 0;
  let observed = 0;
  let count = 0;
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (++count > PROFILE.limits.members) fail('member_limit');
          const name = entry.fileName;
          if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || /^[A-Za-z]:/.test(name) || parts.has(name)) fail('unsafe_zip_entry');
          if (entry.generalPurposeBitFlag & 1) fail('encrypted_input');
          declared += entry.uncompressedSize;
          if (declared > PROFILE.limits.expandedBytes) fail('expanded_limit');
          if (name.endsWith('/')) { parts.set(name, Buffer.alloc(0)); zip.readEntry(); return; }
          const stream = await new Promise((res, rej) => zip.openReadStream(entry, (error, value) => error ? rej(error) : res(value)));
          const chunks = [];
          for await (const chunk of stream) {
            observed += chunk.length;
            if (observed > PROFILE.limits.expandedBytes) { stream.destroy(); fail('expanded_limit'); }
            chunks.push(chunk);
          }
          parts.set(name, Buffer.concat(chunks));
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
  return { parts, inventory: { members: count, declaredExpandedBytes: declared, observedExpandedBytes: observed } };
}

function xml(bytes) {
  const { text } = strictText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('xml_declaration_forbidden');
  if (XMLValidator.validate(text) !== true) fail('invalid_xml');
  return parser.parse(text);
}

// Process the exact buffer whose identity the entry point checked; never reopen a path.
export async function extract(bytes, profile) {
  if (!Buffer.isBuffer(bytes)) fail('invalid_input_buffer');
  if (bytes.length > PROFILE.limits.inputBytes) fail('input_limit');
  const original = { name: 'original', bytes: bytes.length, sha256: digest(bytes) };
  let raw;
  let elements = [];
  let inventory;
  let unsupported = [];
  if (profile === 'text' || profile === 'csv') {
    const decoded = strictText(bytes);
    if (profile === 'text') {
      raw = decoded;
      let byte = decoded.bomBytes; let point = 0;
      elements = (decoded.text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) || []).filter(Boolean).map((value, index) => {
        const size = Buffer.byteLength(value); const points = [...value].length;
        const element = { id: `line-${index + 1}`, type: 'text', text: value, locator: { original: original.sha256, byteRange: [byte, byte + size], codePointRange: [point, point + points] } };
        byte += size; point += points; return element;
      });
      inventory = { bytes: bytes.length, decodedCodePoints: [...decoded.text].length, elements: elements.length, bomBytes: decoded.bomBytes };
    } else {
      const options = { ...PROFILE.csv };
      raw = parse(decoded.text, options);
      if (raw.length > PROFILE.limits.csvRecords) fail('record_limit');
      let previousBytes = 0;
      const rows = raw.map((record, i) => {
        const values = Array.isArray(record.record) ? record.record : Object.values(record.record);
        if (values.length > PROFILE.limits.csvColumns) fail('column_limit');
        if (values.reduce((sum, value) => sum + value.length, 0) > PROFILE.limits.csvRecordUnits) fail('csv_record_limit');
        const range = [decoded.bomBytes + previousBytes, decoded.bomBytes + record.info.bytes];
        if (range[0] > range[1] || range[1] > bytes.length) fail('invalid_csv_locator');
        const row = { index: i, fields: values, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(...range)), originalByteRange: range };
        previousBytes = record.info.bytes; return row;
      });
      elements = [{ id: 'table-1', type: 'table', headers: rows[0]?.fields ?? [], rows, locator: { original: original.sha256, coordinate: 'record/field indexes; record ranges in original UTF-8 bytes' } }];
      inventory = { records: rows.length, bomBytes: decoded.bomBytes, headerMode: 'first record retained; labels do not replace column positions' };
    }
  } else if (profile === 'xlsx') {
    const { parts, inventory: zipInventory } = await zipParts(bytes);
    if (!parts.has('[Content_Types].xml') || !parts.has('xl/workbook.xml') || !parts.has('xl/_rels/workbook.xml.rels')) fail('unsupported_container');
    const documents = new Map();
    for (const [name, body] of parts) {
      if (name.endsWith('.xml') || name.endsWith('.rels')) {
        const value = xml(body); documents.set(name, value);
        if (name.endsWith('.rels') && array(value.Relationships?.Relationship).some(r => r['@_TargetMode'] === 'External')) fail('external_relationship');
      }
    }
    const contentTypes = documents.get('[Content_Types].xml');
    const workbookOverride = array(contentTypes.Types?.Override).find(t => t['@_PartName'] === '/xl/workbook.xml');
    const workbookType = workbookOverride?.['@_ContentType'] ?? array(contentTypes.Types?.Default).find(t => t['@_Extension'] === 'xml')?.['@_ContentType'];
    if (workbookType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') fail('unsupported_workbook_type');
    const meta = documents.get('xl/workbook.xml').workbook;
    const sheets = array(meta?.sheets?.sheet);
    if (sheets.length > PROFILE.limits.sheets) fail('sheet_limit');
    const rels = array(documents.get('xl/_rels/workbook.xml.rels').Relationships?.Relationship);
    const supportedPart = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/[^/]+\.xml|xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|calcChain\.xml|_rels\/workbook\.xml\.rels|theme\/[^/]+\.xml|worksheets\/sheet\d+\.xml))$/;
    unsupported = [...parts.keys()].filter(name => !name.endsWith('/') && !supportedPart.test(name));
    const book = XLSX.read(bytes, PROFILE.xlsx);
    raw = { sheetjs: XLSX.version, workbook: book };
    let totalCells = 0;
    for (const [index, sheet] of sheets.entries()) {
      const relation = rels.find(r => r['@_Id'] === sheet['@_id']);
      if (!relation) fail('missing_sheet_relation');
      const target = relation['@_Target'];
      const part = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
      if (!part.startsWith('xl/worksheets/') || !documents.has(part)) fail('missing_sheet');
      const worksheet = documents.get(part).worksheet;
      if (!worksheet) fail('invalid_sheet');
      const structuralKeys = new Set(['dimension','sheetFormatPr','sheetViews','cols','sheetData','mergeCells','pageMargins']);
      for (const key of Object.keys(worksheet)) if (!key.startsWith('@_') && !structuralKeys.has(key)) unsupported.push(`${part}#${key}`);
      const rows = array(worksheet.sheetData?.row);
      const parsedSheet = book.Sheets[sheet['@_name']];
      if (!parsedSheet) fail('missing_adapter_sheet');
      const cells = [];
      for (const row of rows) for (const cell of array(row.c)) {
        if (++totalCells > PROFILE.limits.cells) fail('cell_limit');
        const address = cell['@_r'];
        if (!/^[A-Z]+[1-9][0-9]*$/.test(address) || cells.some(c => c.address === address)) fail('invalid_cell_address');
        const parsed = parsedSheet[address];
        const stored = Object.hasOwn(cell, 'v');
        const formula = Object.hasOwn(cell, 'f');
        if (formula && typeof cell.f === 'object' && cell.f['@_t'] && cell.f['@_t'] !== 'normal') unsupported.push(`${part}#${address}:formula-${cell.f['@_t']}`);
        const formulaValue = formula ? { storedExpression: scalar(cell.f), attributes: typeof cell.f === 'object' ? Object.fromEntries(Object.entries(cell.f).filter(([k]) => k.startsWith('@_'))) : {}, cached: { availability: stored ? 'observed' : 'not_available', ...(stored ? { lexical: scalar(cell.v), sourceType: cell['@_t'] ?? 'n' } : {}) } } : undefined;
        if (!parsed && (stored || formula || cell.is)) fail('adapter_omitted_cell');
        cells.push({ address, sourceType: cell['@_t'] ?? 'n', ...(stored ? { storedLexical: scalar(cell.v) } : {}), availability: stored || cell.is ? 'present' : 'no_stored_value', ...(parsed ? { adapterType: parsed.t, ...(parsed.v !== undefined ? { value: parsed.v } : {}), ...(parsed.z !== undefined ? { numberFormat: parsed.z } : {}) } : {}), ...(formula ? { formula: formulaValue } : {}), locator: { original: original.sha256, part, sheetId: sheet['@_sheetId'], cell: address } });
      }
      elements.push({ id: `sheet-${index + 1}`, type: 'sheet', name: sheet['@_name'], sourceSheetId: sheet['@_sheetId'], visibility: sheet['@_state'] ?? 'visible', cells, merged: array(worksheet.mergeCells?.mergeCell).map(m => m['@_ref']), hiddenRows: rows.filter(row => row['@_hidden'] === '1').map(row => row['@_r']), columns: array(worksheet.cols?.col), autoFilter: worksheet.autoFilter ?? null, declaredDimension: worksheet.dimension?.['@_ref'] ?? null, locator: { original: original.sha256, part } });
    }
    inventory = { ...zipInventory, parts: [...parts.keys()], sheets: sheets.length, cells: totalCells, dateSystem: meta.workbookPr?.['@_date1904'] === '1' ? '1904' : '1900', semantics: 'Package structure only; not a proof of all workbook meaning or dependencies.' };
  } else fail('unsupported_profile');
  return { raw, extraction: { schema: 'extraction-trial/1', profile, original, outcome: unsupported.length ? 'partial' : 'completed', coverage: { claim: 'declared syntactic profile only', unsupported }, inventory, elements, relations: [], resources: [] }, runtime: { node: process.version, sheetjs: XLSX.version, rssBytes: process.memoryUsage().rss } };
}
