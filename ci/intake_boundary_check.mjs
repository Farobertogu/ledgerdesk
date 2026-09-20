import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {moduleReferences} from './reading_boundary_check.mjs';
const contract = name => /^src\/contracts\/intake(?:_artifact|_bindings|_mapping|_reception|_reception_v2|_extraction|_extraction_view|_preparation|_preparation_bindings|_preparation_response|_workspace)?\.ts$/.test(name);
const server = name => name.startsWith('src/server/intake/');
const presentation = name => name.startsWith('src/components/intake/') || name === 'src/app/access/intake/page.tsx';
const shared = new Map([
  ['src/app/access/intake/page.tsx', new Set(['src/contracts/access_transport.ts'])],
  ['src/components/intake/IntakeWorkspace.tsx', new Set(['src/contracts/access_transport.ts'])],
  ['src/components/intake/controller.ts', new Set(['src/contracts/access_transport.ts','src/contracts/access_canonical.ts','src/components/access/view_lifecycle.ts'])],
  ['src/components/intake/client.ts', new Set(['src/contracts/access.ts','src/contracts/access_transport.ts','src/components/access/view_lifecycle.ts'])],
  ['src/server/intake/workspace/protocol.ts', new Set(['src/contracts/access_transport.ts'])],
  ['src/server/intake/workspace/terminal.ts', new Set(['src/server/access/transport.ts','src/server/access/config.ts'])],
  ['src/contracts/intake_preparation_bindings.ts', new Set(['src/contracts/access_canonical.ts'])],
  ...['authority','proposals','records','service'].map(name=>['src/server/intake/preparation/'+name+'.ts',new Set(['src/contracts/access_canonical.ts'])]),
  ['src/server/intake/preparation/terminal.ts',new Set(['src/server/access/transport.ts','src/server/access/config.ts'])],
  ['src/server/intake/protocol.ts', new Set(['src/contracts/access_transport.ts','src/contracts/access_canonical.ts'])],
  ['src/server/intake/reception.ts', new Set(['src/contracts/access_canonical.ts'])],
  ['src/server/intake/authority.ts', new Set(['src/server/access/invitation_authority.ts','src/server/access/postgres/store.ts','src/server/access/service.ts','src/server/access/transport.ts','src/server/access/config.ts','src/contracts/access_canonical.ts'])],
  ['src/server/intake/extraction_authority.ts', new Set(['src/server/access/invitation_authority.ts','src/contracts/access_canonical.ts'])],
  ['src/server/intake/postgres/store.ts', new Set(['src/server/access/postgres/store.ts'])],
  ['src/server/intake/terminal.ts', new Set(['src/server/access/transport.ts','src/server/access/config.ts','src/contracts/access_transport.ts'])],
  ['src/server/access/terminal.ts', new Set(['src/server/intake/terminal.ts','src/server/intake/config.ts'])],
]);
export function intakeViolations(file,source){
  const inside=contract(file);
  const {references,computed}=moduleReferences(source,{jsx:/[jt]sx$/.test(file)});
  const errors=[];
  if((inside||server(file)||presentation(file))&&computed.length)errors.push('Computed intake import');
  for(const {specifier} of references){
    let target=specifier.startsWith('@/')?'src/'+specifier.slice(2):specifier.startsWith('.')?path.posix.normalize(path.posix.join(path.posix.dirname(file),specifier)):null;
    if(target&&!/\.[cm]?[jt]sx?$/.test(target))target+='.ts';
    if(inside && (!target || !contract(target)&&!shared.get(file)?.has(target)))errors.push('Intake contract imports implementation: '+specifier);
    if(server(file)) {
      const builtins = new Set(['node:crypto','node:buffer','node:http','node:net']);
      if (!(target ? contract(target)||server(target)||shared.get(file)?.has(target) : builtins.has(specifier))) errors.push('Forbidden intake runtime import: '+specifier);
    }
    if(presentation(file) && !(target ? contract(target)||target.startsWith('src/components/intake/')||shared.get(file)?.has(target) : specifier==='react'))
      errors.push('Forbidden intake presentation import: '+specifier);
    if(!inside&&!server(file)&&!presentation(file)&&target&&(contract(target)||server(target)||target.startsWith('src/components/intake/'))&&!shared.get(file)?.has(target))errors.push('Intake is not operational outside its admitted composition: '+specifier);
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
