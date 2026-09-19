import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {processingTreatment} from './runtime_control.mjs';

/** Creates only real reception effects, with independently supplied original bytes. */
export async function receivedOriginal(request,client,bytes,{name='synthetic.txt',format='text-utf8/1',media='text/plain',treatmentRevision=processingTreatment}={}){
  const declaration={profile:'intake/1',original:{name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),declared_media_type:media},
    format_profile:format,receiving_context:{scope_id:'organisation',purpose_id:'synthetic-reading-trial',treatment_revision:treatmentRevision}};
  const reserved=await request('/api/intake/receptions',{client,body:declaration,key:randomUUID()});assert.equal(reserved.status,202,JSON.stringify(reserved.body));
  const uploaded=await request(`/api/intake/receptions/${reserved.body.reception_id}/attempts/1/original`,{client,bytes});assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));
  const received=await request(`/api/intake/receptions/${reserved.body.reception_id}/finalize`,{client,key:randomUUID(),
    body:{profile:'intake/1',expected_revision:uploaded.body.revision,original:uploaded.body.original,format_profile:format}});
  assert.equal(received.status,200,JSON.stringify(received.body));return received.body;
}
