import test from 'node:test';
import assert from 'node:assert/strict';
import { INTAKE_RESPONSE, PROFILE_REGISTRY, INTAKE_ROUTES } from '../../../src/contracts/intake.ts';
import { RECEPTION_RESPONSE, AVAILABILITY_RESPONSE, RECEPTION_PROBLEM, receptionProblem,
  RECEPTION_ROUTES, resolveReceptionPath } from '../../../src/contracts/intake_reception.ts';
import { receptionEnvelope, receptionCommand, receptionCanonical } from '../../../src/server/intake/protocol.ts';
import { intakeConfig } from '../../../src/server/intake/config.ts';
import { intakeViolations } from '../../../ci/intake_boundary_check.mjs';

const exact = { id: 'configuration-1', revision: 1, sha256: 'a'.repeat(64) };
const original = { id: 'original-1', generation: 1, bytes: 17, sha256: '8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9' };
const response = { profile: 'intake/1', representation: 'intake-reception/1', operation_id: 'operation-1',
  reception_id: 'reception-1', revision: 1, state: 'reserved', original, availability: 'not_observed',
  format_profile: 'text-utf8/1', configuration: exact, attempt_expires_at: 2000000000000, effect: null, work: null };
const transport = { profile: 'session/1', uiOrigin: 'https://ui.inc02.test:8443', terminalOrigin: 'https://api.inc02.test:9443' };
const command = { profile: 'intake/1', original: { name: 'bom.txt', bytes: 17, sha256: original.sha256, declared_media_type: 'text/plain' },
  format_profile: 'text-utf8/1', receiving_context: { scope_id: 'scope-1', purpose_id: 'purpose-1', treatment_revision: exact } };
function envelope(route = 'reserve_reception', extra = {}, raw = []) {
  const bytes = Buffer.from(JSON.stringify(command));
  const headers = { host: 'api.inc02.test:9443', origin: transport.uiOrigin, 'content-type': 'application/json',
    'content-length': String(bytes.length), 'x-ledgerdesk-csrf': 'A'.repeat(43), 'x-ledgerdesk-intent': 'client-key-1', ...extra };
  return { method: INTAKE_ROUTES[route].method, url: INTAKE_ROUTES[route].path,
    headers, rawHeaders: [...Object.entries(headers).filter(([,v])=>v!==undefined).flat(), ...raw] };
}
test('new representation preserves the closed foundation envelope', () => {
  assert.equal(RECEPTION_RESPONSE(response), true);
  assert.equal(INTAKE_RESPONSE(response), false);
  assert.equal(RECEPTION_RESPONSE({ ...response, hidden_count: 1 }), false);
  const receipt = { ...response, state: 'received', effect: exact, work: { id: 'work-1', state: 'not_started', dispatchable: false } };
  assert.equal(RECEPTION_RESPONSE(receipt), true);
  for (const mutation of [{ effect: null }, { work: null }, { state: 'staged' }, { work: { ...receipt.work, dispatchable: true } }])
    assert.equal(RECEPTION_RESPONSE({ ...receipt, ...mutation }), false);
  assert.equal(RECEPTION_RESPONSE({ ...response, availability: 'available' }), false);
});
test('availability says reception, not implemented processing or hidden rows', () => {
  const value = { profile: 'intake/1', representation: 'intake-availability/1', profiles: [{ format_profile: 'text-utf8/1',
    configuration: exact, original_bytes: 1048576, reception_available: true, processing_available: false }] };
  assert.equal(AVAILABILITY_RESPONSE(value), true);
  assert.equal(PROFILE_REGISTRY(value), false);
  for (const mutation of [{ revealable: false }, { processing_available: true }, { original_bytes: 1048577 }])
    assert.equal(AVAILABILITY_RESPONSE({ ...value, profiles: [{ ...value.profiles[0], ...mutation }] }), false);
  assert.equal(AVAILABILITY_RESPONSE({ ...value, profiles: [...value.profiles, ...value.profiles] }), false);
  assert.equal(AVAILABILITY_RESPONSE({ ...value, profiles: [] }), true);
});
for (const status of [400,403,404,409,413,415,429,503]) test(`problem ${status} is closed and internally consistent`, () => {
  const body = receptionProblem(status);
  assert.equal(RECEPTION_PROBLEM(body), true);
  assert.equal(RECEPTION_PROBLEM({ ...body, detail: 'protected' }), false);
  assert.equal(RECEPTION_PROBLEM({ ...body, title: 'Internal reason' }), false);
});
test('exactly nine consumer routes, no aliases or future ports', () => {
  assert.equal(RECEPTION_ROUTES.length, 9);
  for (const key of RECEPTION_ROUTES) {
    const path = INTAKE_ROUTES[key].path.replace(':id','selected-id').replace(':generation','1');
    assert.equal(resolveReceptionPath(INTAKE_ROUTES[key].method,path)?.route,key);
    for (const suffix of ['/', '?x=1', '#x', '%00']) assert.equal(resolveReceptionPath(INTAKE_ROUTES[key].method,path+suffix),null);
  }
  for (const [key, definition] of Object.entries(INTAKE_ROUTES).filter(([key])=>!RECEPTION_ROUTES.includes(key)))
    assert.equal(resolveReceptionPath(definition.method,definition.path.replace(/:[a-z_]+/g,'selected')),null);
  for (const generation of ['0','01','-1','9007199254740992'])
    assert.equal(resolveReceptionPath('POST',`/api/intake/receptions/r/attempts/${generation}/original`),null);
});
test('framing and transport negatives retain the valid command positive', () => {
  assert.equal(receptionEnvelope(envelope(),transport).route,'reserve_reception');
  for (const [change,status] of [[{origin:'https://unrelated.test'},403],[{'transfer-encoding':'chunked'},400],
    [{'content-encoding':'gzip'},400],[{'content-length':'01'},400],[{'content-length':'1048577'},413],
    [{'content-type':'application/octet-stream'},415],[{'x-ledgerdesk-csrf':'bad'},403],[{'x-ledgerdesk-intent':undefined},400],
    [{range:'bytes=0-1'},400],[{'if-none-match':'*'},400]])
    assert.throws(()=>receptionEnvelope(envelope('reserve_reception',change),transport),{status});
  assert.throws(()=>receptionEnvelope(envelope('reserve_reception',{},['Origin',transport.uiOrigin]),transport),{status:400});
});
test('binary media is limited to the original continuation; access JSON policy is unchanged', () => {
  const request = envelope('upload_original',{'content-type':'application/octet-stream','content-length':'17','x-ledgerdesk-intent':undefined});
  request.url='/api/intake/receptions/r/attempts/1/original';
  assert.equal(receptionEnvelope(request,transport).contentLength,17);
  request.headers['content-length']='1048577'; request.rawHeaders=[];
  assert.throws(()=>receptionEnvelope(request,transport),{status:413});
});
test('canonical target belongs to compared payload, not a new intention namespace', () => {
  const request=receptionEnvelope(envelope(),transport);
  const body=receptionCommand(request,Buffer.from(JSON.stringify(command)));
  const canonical=receptionCanonical(request,body);
  assert.equal(canonical,receptionCanonical(request,{receiving_context:command.receiving_context,format_profile:command.format_profile,original:command.original,profile:'intake/1'}));
  assert.notEqual(canonical,receptionCanonical(request,{...command,original:{...command.original,name:'other.txt'}}));
  assert.throws(()=>receptionCommand(request,Buffer.from('{"profile":"intake/1","profile":"intake/1"}')),{status:400});
});
test('configuration is explicit, synthetic, scoped and immutable', () => {
  const value={profile:'intake-runtime/1',synthetic:true,enabled:true,connectionString:'postgresql://inc03_intake_runtime:x@127.0.0.1:55432/inc02_synthetic',
    readerConnectionString:'postgresql://inc03_intake_reader:x@127.0.0.1:55432/inc02_synthetic',expectedPort:55432,
    deployment:'inc02-synthetic',namespace:'intake_trial',controlSource:'live-control',incarnation:'incarnation-1',generation:1,
    catalog:exact,configuration:exact,limits:exact,brokerSocket:'/run/intake-t02/objects/channel.sock',verifierSocket:'/run/intake-t02/verifier/channel.sock',digestKeyVersion:1};
  const result=intakeConfig(value);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.catalog));
  for(const change of [{enabled:false},{synthetic:false},{namespace:'access_trial'},{generation:0},{brokerSocket:'/tmp/objects.sock'},
    {readerConnectionString:value.connectionString},{connectionString:value.connectionString.replace('127.0.0.1','localhost')}])
    assert.throws(()=>intakeConfig({...value,...change}));
});
test('only explicit intake composition edges are admitted', () => {
  assert.deepEqual(intakeViolations('src/server/intake/protocol.ts',"import {canonicalValue} from '../../contracts/access_canonical.ts'"),[]);
  for(const [file,source] of [
    ['src/contracts/intake_reception.ts',"import x from '../server/intake/config.ts'"],
    ['src/server/intake/config.ts',"import x from '../access/service.ts'"],
    ['src/server/intake/terminal.ts',"import x from 'xlsx'"],
    ['src/server/intake/terminal.ts',"import x from '../../../tests/intake/t01/test.mjs'"],
    ['src/app/page.tsx',"import x from '@/server/intake/service'"],
    ['src/server/intake/service.ts','import(process.env.MODULE)'],
  ]) assert.ok(intakeViolations(file,source).length>0,file);
});
