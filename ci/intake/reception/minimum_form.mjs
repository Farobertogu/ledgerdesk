import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const fail = code => { throw Object.assign(Error(code), { code }); };
export function strictUtf8(bytes) {
  if (bytes.subarray(0,2).equals(Buffer.from([255,254])) || bytes.subarray(0,2).equals(Buffer.from([254,255]))) fail('invalid');
  return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
}
/** Only framing, bounded expansion and workbook identity; no cells or extraction result. */
async function workbookIdentity(bytes) {
  const zip = await new Promise((resolve,reject)=>yauzl.fromBuffer(bytes,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(e,z)=>e?reject(e):resolve(z)));
  const selected=new Map(),names=new Set();let declared=0,observed=0;
  try {
    await new Promise((resolve,reject)=>{
      zip.once('error',reject);zip.once('end',resolve);
      zip.on('entry',entry=>{(async()=>{
        const name=entry.fileName;
        if(names.has(name)||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||/^[A-Za-z]:/.test(name)||entry.generalPurposeBitFlag&1)fail('invalid');
        names.add(name);
        if(names.size>128||(declared+=entry.uncompressedSize)>8388608)fail('limit');
        if(![0,8].includes(entry.compressionMethod))fail('invalid');
        if(name.endsWith('/')) {if(entry.uncompressedSize!==0)fail('invalid');zip.readEntry();return;}
        const stream=await new Promise((resolve,reject)=>zip.openReadStream(entry,(error,value)=>error?reject(error):resolve(value)));
        const chunks=[];let memberBytes=0;
        for await(const chunk of stream){observed+=chunk.length;memberBytes+=chunk.length;
          if(observed>8388608){stream.destroy();fail('limit');}
          if(['[Content_Types].xml','xl/workbook.xml','xl/_rels/workbook.xml.rels'].includes(name))chunks.push(chunk);
        }
        if(memberBytes!==entry.uncompressedSize)fail('invalid');
        if(chunks.length)selected.set(name,Buffer.concat(chunks));
        zip.readEntry();
      })().catch(reject);});zip.readEntry();
    });
  }finally{zip.close();}
  const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,removeNSPrefix:true,trimValues:false,processEntities:false});
  const xml=name=>{const content=selected.get(name);if(!content)fail('invalid');const text=strictUtf8(content);
    if(/<!DOCTYPE|<!ENTITY/i.test(text)||XMLValidator.validate(text)!==true)fail('invalid');return parser.parse(text);};
  const types=xml('[Content_Types].xml'),book=xml('xl/workbook.xml'),relations=xml('xl/_rels/workbook.xml.rels');
  const overrides=types.Types?.Override;
  const entries=overrides===undefined?[]:Array.isArray(overrides)?overrides:[overrides];
  const workbook=entries.filter(row=>row['@_PartName']==='/xl/workbook.xml');
  const defaults=types.Types?.Default===undefined?[]:Array.isArray(types.Types.Default)?types.Types.Default:[types.Types.Default];
  const xmlDefaults=defaults.filter(row=>row['@_Extension']==='xml');
  const workbookType=workbook.length===1?workbook[0]['@_ContentType']:xmlDefaults.length===1?xmlDefaults[0]['@_ContentType']:null;
  if(workbook.length>1||workbookType!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'||
    !book.workbook||!relations.Relationships)fail('invalid');
  return {members:names.size,declaredExpandedBytes:declared,observedExpandedBytes:observed};
}
export async function minimumForm(bytes,format) {
  if(!Buffer.isBuffer(bytes)||bytes.length>1048576)return {ok:false,outcome:'limit'};
  if(!['text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1'].includes(format))return {ok:false,outcome:'invalid'};
  try {
    if(format==='xlsx-cells/1')await workbookIdentity(bytes);else strictUtf8(bytes);
    // CSV grammar, XLSX cells, semantic coverage and fidelity are not claimed here.
    return {ok:true,outcome:'recognized',format,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),scope:'minimum-form-only'};
  }catch(error){return {ok:false,outcome:error.code==='limit'?'limit':'invalid',format,bytes:bytes.length,
    sha256:createHash('sha256').update(bytes).digest('hex'),scope:'minimum-form-only'};}
}
