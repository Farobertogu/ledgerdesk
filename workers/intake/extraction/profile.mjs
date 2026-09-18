export const PROFILE = Object.freeze({
  version: 'intake-trial/1',
  limits: { inputBytes: 1048576, expandedBytes: 8388608, members: 128, sheets: 8, cells: 10000, csvRecords: 1000, csvColumns: 64, csvRecordUnits: 65536, outputBytes: 8388608, wallMs: 10000, heapMiB: 128, concurrency: 1 },
  text: { encoding: 'utf-8', fatal: true, bom: 'strip from decoded view, retain original bytes and offset', normalize: false, markdown: 'inert source text', coordinates: 'zero-based half-open UTF-8 byte and Unicode code-point offsets' },
  csv: { encoding: 'utf8', bom: false, columns: false, cast: false, cast_date: false, delimiter: ',', quote: '"', escape: '"', record_delimiter: ['\r\n', '\n'], trim: false, skip_empty_lines: false, skip_records_with_error: false, relax_column_count: false, raw: true, info: true, max_record_size: 262144 },
  xlsx: { type: 'buffer', cellFormula: true, cellNF: true, cellStyles: true, cellText: false, cellHTML: false, cellDates: false, sheetStubs: true, xlfn: true, WTF: true, nodim: true, sheetRows: 0 },
  exclusions: ['PDF and OCR', 'DOCX', 'visual interpretation', 'macros or external retrieval', 'formula evaluation', 'semantic approval', 'product enablement'],
  limitMeaning: 'Provisional experiment bounds, not product limits. CSV record units are the sum of decoded field UTF-16 code units, excluding separators and quote syntax. A separate 262144 parser-buffer guard leaves room for multibyte characters; the adapter enforces 65536 explicitly. Heap is not an RSS cap. ZIP declared and observed expansion are both checked.'
});
