import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {moduleReferences} from './reading_boundary_check.mjs';
export function intakeViolations(file,source){
  const inside=/^src\/contracts\/intake(?:_artifact|_bindings|_mapping)?\.ts$/.test(file);
  const {references,computed}=moduleReferences(source,{jsx:/[jt]sx$/.test(file)});
  const errors=[];
  if(inside&&computed.length)errors.push('Computed intake import');
  for(const {specifier} of references){
    let target=specifier.startsWith('@/')?'src/'+specifier.slice(2):specifier.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier)):null;
    if(target&&!/\.[cm]?[jt]sx?$/.test(target))target+='.ts';
    if(inside && (!target || !/^src\/contracts\/intake(?:_artifact|_bindings|_mapping)?\.ts$/.test(target)))errors.push('Intake contract imports implementation: '+specifier);
    if(!inside&&target&&(/^src\/contracts\/intake/.test(target)||target.startsWith('tests/intake/')))errors.push('Intake is not operational: '+specifier);
    if(/tests\/intake|intake_profile_trial|csv-parse|fast-xml-parser|yauzl|(^|\/)xlsx($|\/)/.test(specifier))errors.push('Experimental dependency in production source');
  }
  return errors;
}
export function checkIntake(root){
  const errors=[];let count=0;
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.[cm]?[jt]sx?$/.test(p)){count++;const name=path.relative(root,p).split(path.sep).join('/');errors.push(...intakeViolations(name,fs.readFileSync(p,'utf8')).map(x=>name+': '+x));}}}
  walk(path.join(root,'src'));return {count,errors};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=checkIntake(fileURLToPath(new URL('../',import.meta.url)));
  console.log(JSON.stringify(result));if(result.errors.length)process.exitCode=1;
}
