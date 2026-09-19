import {writeFileSync} from 'node:fs';
// Separate test-only metadata producer. It receives the operation selection,
// never the assertion module. It neither reads nor renders resource bodies.
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks));
const selected=input.resources[input.choice==='B'?1:0];
const result={original:input.original,selections:[{element_id:'figure-original',resource:selected}],
  relations:[{id:'figure-caption',from:'figure-original',to:'line-1',role:'indispensable',
    scope:input.choice==='B'?'AZ-18 under condition Z':'AZ-17 under condition Z',origin:'proposed'}],resources:[selected]};
writeFileSync(input.output,JSON.stringify(result),{flag:'wx'});
