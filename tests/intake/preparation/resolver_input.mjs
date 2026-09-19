import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {encodePayload,artifactFor,sealDifference,sealPreparation,verifyPreparation} from '../../../src/server/intake/preparation/records.ts';
const control='/work/output/t04-resolver-input.json';
function configuration(reference,phase){
  if(!existsSync(control))return null;
  const c=JSON.parse(readFileSync(control,'utf8'));
  return c.phase===phase&&c.target.id===reference.id&&c.target.revision===reference.revision?c:null;
}
/** Post-admission seam in the captured service copy, not a production option. */
export function applyResolvedInput(retained,phase){
  const c=configuration(retained.record.reference,phase);if(!c)return;
  const original=retained.record, p=structuredClone(original.payload);
  if(c.kind==='replace-text')p.elements.find(e=>e.id==='exception').text='Under condition Z, receipt S replaces receipt Q.';
  else if(c.kind==='drop-context'){
    p.elements=p.elements.filter(e=>e.id!=='exception');p.relations=[];
    p.units=p.units.map(u=>({...u,elements:u.elements.filter(id=>id!=='exception')}));
  }else throw Error('RESOLVER_TEST_KIND');
  const payload=artifactFor(original.descriptor.payload.id,original.descriptor.payload.generation,encodePayload(p));
  const differences=original.differences.map(d=>sealDifference(d.reference.id,d.reference.revision,
    {...d.body,after:{id:original.reference.id,revision:original.reference.revision,payload}}));
  const sealed=sealPreparation({id:original.reference.id,revision:original.reference.revision,artifactId:payload.id,payload:p,
    differences,operation:original.descriptor.operation,actor:original.descriptor.actor,recordedAt:original.descriptor.recorded_at});
  if(!verifyPreparation(sealed.record,sealed.bytes))throw Error('RESOLVER_TEST_NOT_COHERENT');
  retained.record=sealed.record;retained.bytes=sealed.bytes;
  writeFileSync(c.observation,JSON.stringify({pid:process.pid,phase,kind:c.kind,original:original.reference,
    substituted:sealed.record.reference,integrityValid:true,elements:p.elements.map(e=>({id:e.id,text:e.text})),relations:p.relations}),{flag:'wx'});
}
export function applyStoredInput(row,reference){
  const c=configuration(reference,'storage');if(!c)return;
  const bytes=Buffer.from(row.payload);bytes[bytes.length-1]^=1;row.payload=bytes;
  writeFileSync(c.observation,JSON.stringify({pid:process.pid,phase:'storage',kind:'byte-corruption',reference,bytes:bytes.length}),{flag:'wx'});
}
