import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { minimumForm } from '../../../ci/intake/reception/minimum_form.mjs';
const fixture=name=>readFileSync(new URL('../t01/fixtures/'+name,import.meta.url));
for(const [name,format,bytes,sha256] of [
  ['bom.txt','text-utf8/1',17,'8ab8151d61e1d71204824d7cbc2cfa3f2718028368ac812a260bc86ea26b42f9'],
  ['table.csv','csv-utf8/1',117,'947da2ccc6b51f26df323a294f913b527393bfbec8c84e7349a3a407662b3be3'],
  ['baseline.xlsx','xlsx-cells/1',4564,'41667ef76c98f71f8add0d4058c287b6a8b3965b87b3f23904c455cbd6410093'],
  ['cache-discrepant.xlsx','xlsx-cells/1',4564,'069e6f5817c12c780c6013207b7d23e351cfc6cb0b7b6a8540a21522ef9c2136'],
])test(name+': minimal recognition preserves measured bytes without claiming extraction',async()=>{
  const input=fixture(name);
  assert.deepEqual({bytes:input.length,sha256:createHash('sha256').update(input).digest('hex')},{bytes,sha256});
  assert.deepEqual(await minimumForm(input,format),{ok:true,outcome:'recognized',format,bytes,sha256,scope:'minimum-form-only'});
});
test('UTF-8 error and actual size negatives reach their own controls',async()=>{
  assert.equal((await minimumForm(fixture('invalid-utf8.txt'),'text-utf8/1')).ok,false);
  assert.equal((await minimumForm(fixture('at-byte-limit.txt'),'text-utf8/1')).ok,true);
  assert.deepEqual(await minimumForm(fixture('over-byte-limit.txt'),'text-utf8/1'),{ok:false,outcome:'limit'});
});
test('a broken CSV grammar is not mislabelled as a completed CSV extraction',async()=>{
  const result=await minimumForm(fixture('broken-quotes.csv'),'csv-utf8/1');
  assert.equal(result.ok,true);assert.equal(result.scope,'minimum-form-only');
  assert.equal(Object.hasOwn(result,'coverage'),false);assert.equal(Object.hasOwn(result,'rows'),false);
});
test('a renamed arbitrary ZIP/text is not a recognized workbook',async()=>{
  assert.equal((await minimumForm(fixture('text.txt'),'xlsx-cells/1')).ok,false);
});
