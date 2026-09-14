const tests=new Map([
  ['tests/intake/t02/test_minimum_form.mjs','minimum-form'],
  ['tests/intake/t02/test_contracts.mjs','reception-contracts'],
  ['tests/intake/t02/test_bridge.mjs','reception-bridge'],
  ['tests/intake/t02/test_request_observer.mjs','request-observer'],
]);
const references=new Set(tests.values());
const stages=new Set(['module-load','test-failed','unclassified']);
const codes=new Set(['ERR_MODULE_NOT_FOUND','ERR_TEST_FAILURE']);
/** Diagnostic classification, not authorization or a replacement for the actual exit. */
export function commandDiagnostic(args,result){
  const testFile=args.find(value=>tests.has(value));
  if(!args.includes('--test')||!testFile||result.code===0)return null;
  const text=(result.stdout??'')+'\n'+(result.stderr??'');
  // TAP escapes Windows separators; normalize only the known test-reference comparison.
  const fileFailure=text.split(/\r?\n/).some(line=>line.replace(/\\+/g,'/')===`not ok 1 - ${testFile}`);
  const missing=fileFailure&&/^# tests 1\r?$/m.test(text)&&/^# Error \[ERR_MODULE_NOT_FOUND\]:/m.test(text);
  return {profile:'intake-command-diagnostic/1',reference:tests.get(testFile),
    stage:missing?'module-load':fileFailure?'test-failed':'unclassified',
    code:missing?'ERR_MODULE_NOT_FOUND':fileFailure?'ERR_TEST_FAILURE':null};
}
/** Do not forward diagnostic strings, messages, paths, stacks or unknown fields. */
export function publicCommandDiagnostic(value){
  if(!value||value.profile!=='intake-command-diagnostic/1'||!references.has(value.reference)||
    !stages.has(value.stage)||!(value.code===null||codes.has(value.code)))return {profile:'intake-command-diagnostic/1',stage:'unclassified'};
  return {profile:value.profile,reference:value.reference,stage:value.stage,code:value.code};
}
