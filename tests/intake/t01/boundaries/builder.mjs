import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'outputs', `xlsx-boundaries-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`);
await fs.mkdir(directory, {recursive:true});
const write = (name, bytes) => fs.writeFile(path.join(directory,name), bytes, {flag:'wx'});
const cases = [
  {id:'XLS01', file:'sheets-at.xlsx', counts:Array(8).fill(1), expected:'completed'},
  {id:'XLS02', file:'sheets-over.xlsx', counts:Array(9).fill(1), expected:'sheet_limit'},
  {id:'XLS03', file:'cells-at.xlsx', counts:[10000], expected:'completed'},
  {id:'XLS04', file:'cells-over.xlsx', counts:[10001], expected:'cell_limit'},
  {id:'XLS05', file:'cells-distributed-at.xlsx', counts:[5000,5000], expected:'completed'},
  {id:'XLS06', file:'cells-distributed-over.xlsx', counts:[5000,5001], expected:'cell_limit'}
];
for (const item of cases) {
  const workbook = Workbook.create();
  for (const [i,count] of item.counts.entries()) {
    const sheetName = `Part${i+1}`;
    const sheet = workbook.worksheets.add(sheetName);
    // Exactly one physical numeric cell per row, no hidden header/total cells.
    sheet.getRange(`A1:A${count}`).values = Array.from({length:count},(_,row)=>[i*100000+row+1]);
    sheet.getUsedRange().format.font = {name:'Arial',size:11};
    sheet.getUsedRange().format.columnWidth = 18;
    sheet.getUsedRange().format.rowHeight = 22;
    sheet.getUsedRange().setNumberFormat('0');
    for (const [label,range] of [['start',`A1:A${Math.min(4,count)}`],...(count>4?[['end',`A${count-2}:A${count}`]]:[])]) {
      const inspection = await workbook.inspect({kind:'table',range:`${sheetName}!${range}`,include:'values,formulas',tableMaxRows:4,tableMaxCols:1});
      await write(`${item.id}-${sheetName}-${label}.ndjson`,inspection.ndjson);
      const preview = await workbook.render({sheetName,range,scale:1,format:'png'});
      await write(`${item.id}-${sheetName}-${label}.png`,new Uint8Array(await preview.arrayBuffer()));
    }
  }
  const errors = await workbook.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!',options:{useRegex:true,maxResults:10}});
  await write(`${item.id}-error-scan.ndjson`,errors.ndjson);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(path.join(directory,item.file));
  const bytes = await fs.readFile(path.join(directory,item.file));
  item.bytes=bytes.length;item.sha256=createHash('sha256').update(bytes).digest('hex');
  console.log(JSON.stringify({id:item.id,file:item.file,bytes:item.bytes}));
}
await write('expected.json',JSON.stringify({scope:'Exact physical sheet/cell boundary fixtures; no formulas, images or semantic dependencies',valueRule:'Part i (zero-based): A row has numeric value i*100000+row, one-based row',cases},null,2)+'\n');
await write('builder.mjs',await fs.readFile(fileURLToPath(import.meta.url)));
console.log(JSON.stringify({directory,cases:cases.length}));
