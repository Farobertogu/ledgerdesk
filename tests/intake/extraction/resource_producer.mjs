import fs from 'node:fs';
// Test-only metadata producer, run as a separate process. It receives a fixed
// operation and existing resource metadata, not an expected assertion or oracle.
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks));
const choice=input.choice==='B'?1:0,resource=input.resources[choice];
const result={original:input.original,selections:[{element_id:'selected-resource',resource}],
  relations:[{id:'required-exception',from:'line-1',to:'line-2',role:'indispensable',scope:'AZ-17 under condition Z',origin:'proposed'}],
  resources:[resource]};
// It does not read the resource bodies. The admitted consumer does so later.
fs.writeFileSync(input.output,JSON.stringify(result),{flag:'wx'});
