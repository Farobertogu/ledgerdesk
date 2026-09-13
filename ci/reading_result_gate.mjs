import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const readingDependencies=Object.freeze(['reading-foundations','intake-reception-behavior','intake-reception-recovery','intake-reception-mutations']);
export function readingPassed(needs,cancelled){
  return cancelled===false&&needs!==null&&typeof needs==='object'&&!Array.isArray(needs)&&
    Object.keys(needs).sort().join('|')===[...readingDependencies].sort().join('|')&&
    readingDependencies.every(name=>Object.hasOwn(needs,name)&&needs[name]?.result==='success');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let ok=false;try{ok=readingPassed(JSON.parse(process.env.READING_NEEDS??''),process.env.READING_CANCELLED==='false'?false:true);}catch{}
  console.log(ok?'All four mandatory reading producers succeeded.':'Reading verification is incomplete, failed or cancelled.');
  if(!ok)process.exitCode=1;
}
