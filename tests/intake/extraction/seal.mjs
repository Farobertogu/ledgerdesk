import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sealOutput} from '../../../ci/intake/extraction/seal.mjs';
import {durable,hash} from '../../../ci/intake/extraction/storage.mjs';

// Exercise the Linux durability implementation in the clean verification
// package. These are storage-component checks, not authorization evidence.
assert.equal(process.platform,'linux');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'intake-seal-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('intake-seal-'));fs.rmSync(root,{recursive:true});});
  const raw=Buffer.from('retained producer bytes'),normal=Buffer.from('independently normalized bytes');
  const reference=bytes=>({id:randomUUID(),generation:1,bytes:bytes.length,sha256:hash(bytes)});
  const bundle={id:randomUUID(),raw:reference(raw),normalized:reference(normal),namespace:'intake_trial'};
  return {root,directory:path.join(root,'bundle'),raw,normal,bundle};
}
function partial(f){fs.mkdirSync(f.directory);durable(f.directory+'/seal-intent.json',Buffer.from(JSON.stringify(f.bundle)));}
const state=d=>Object.fromEntries(fs.readdirSync(d).sort().map(name=>[name,hash(fs.readFileSync(d+'/'+name))]));

test('new seal and identical reconciliation retain both exact files and publish the manifest last',t=>{
  const f=fixture(t);sealOutput(f.directory,f.bundle,f.raw,f.normal);const before=state(f.directory);
  assert.deepEqual(before,{'manifest.json':hash(Buffer.from(JSON.stringify(f.bundle))),
    'normalized.bin':hash(f.normal),'raw.bin':hash(f.raw),'seal-intent.json':hash(Buffer.from(JSON.stringify(f.bundle)))});
  sealOutput(f.directory,f.bundle,f.raw,f.normal);assert.deepEqual(state(f.directory),before);
});
test('raw-only interrupted seal resumes the exact retained intention without overwriting raw bytes',t=>{
  const f=fixture(t);partial(f);durable(f.directory+'/raw.bin',f.raw);const inode=fs.statSync(f.directory+'/raw.bin').ino;
  sealOutput(f.directory,f.bundle,f.raw,f.normal);
  assert.equal(fs.statSync(f.directory+'/raw.bin').ino,inode);
  assert.deepEqual(fs.readFileSync(f.directory+'/normalized.bin'),f.normal);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.directory+'/manifest.json')),f.bundle);
});
test('intact raw from a different retained seal intention cannot be relabeled',t=>{
  const f=fixture(t);partial(f);durable(f.directory+'/raw.bin',f.raw);const before=state(f.directory);
  const other={...f.bundle,normalized:{...f.bundle.normalized,id:randomUUID()}};
  assert.throws(()=>sealOutput(f.directory,other,f.raw,f.normal),/EXTRACTION_OUTPUT_CONFLICT/);
  assert.deepEqual(state(f.directory),before);assert.equal(fs.existsSync(f.directory+'/manifest.json'),false);
});
test('a directory without its durable intention is retained unavailable, not guessed complete',t=>{
  const f=fixture(t);fs.mkdirSync(f.directory);durable(f.directory+'/raw.bin',f.raw);const before=state(f.directory);
  assert.throws(()=>sealOutput(f.directory,f.bundle,f.raw,f.normal),e=>e.code==='ENOENT');
  assert.deepEqual(state(f.directory),before);assert.equal(fs.existsSync(f.directory+'/manifest.json'),false);
});
for(const target of ['raw.bin','normalized.bin'])test('a corrupt partial '+target+' is not replaced by supplied bytes',t=>{
  const f=fixture(t);partial(f);durable(f.directory+'/raw.bin',target==='raw.bin'?Buffer.from('wrong raw'):f.raw);
  if(target==='normalized.bin')durable(f.directory+'/normalized.bin',Buffer.from('wrong normalized'));
  const before=state(f.directory);
  assert.throws(()=>sealOutput(f.directory,f.bundle,f.raw,f.normal),/EXTRACTION_OUTPUT_INTEGRITY/);
  assert.deepEqual(state(f.directory),before);assert.equal(fs.existsSync(f.directory+'/manifest.json'),false);
});
