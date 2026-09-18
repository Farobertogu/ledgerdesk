import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const readingDependencies=Object.freeze(['reading-foundations','intake-reception-behavior','intake-reception-recovery','intake-reception-mutations','intake-extraction','intake-extraction-recovery','intake-extraction-admission','intake-extraction-boundaries','intake-extraction-resource-guards','intake-extraction-format-guards']);
export function readingPassed(needs,jobStatus){
  // The current job status is independent of the producer results.
  // Unknown or absent status must not become an implicit non-cancellation.
  return jobStatus==='success'&&needs!==null&&typeof needs==='object'&&!Array.isArray(needs)&&
    Object.keys(needs).sort().join('|')===[...readingDependencies].sort().join('|')&&
    readingDependencies.every(name=>Object.hasOwn(needs,name)&&needs[name]?.result==='success');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let ok=false;try{ok=readingPassed(JSON.parse(process.env.READING_NEEDS??''),process.env.READING_JOB_STATUS);}catch{}
  console.log(ok?'All mandatory reading producers succeeded.':'Reading verification is incomplete, failed or cancelled.');
  if(!ok)process.exitCode=1;
}
