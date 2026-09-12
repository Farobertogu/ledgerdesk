/** Accepts the flat Node TAP report used by the intake contract suites, not arbitrary TAP. */
export function summarizeNodeTests(result, commandRecord) {
 const report={code:result.code,commandRecord,reporter:'node-flat-tap/1',status:'invalid',summary:null,errors:[]};
 const errors=report.errors;
 if(typeof commandRecord!=='string'||!/^\d+\.json$/.test(commandRecord))errors.push('missing_command_record');
 if(result.reason||result.stdoutEncodingError||result.stdoutRetainedBytes!==result.stdoutBytes)errors.push('incomplete_capture');
 const lines=(result.stdout??'').split(/\r?\n/);
 if(lines.filter(line=>line==='TAP version 13').length!==1)errors.push('invalid_reporter_header');
 const summary={};
 for(const field of ['tests','suites','pass','fail','cancelled','skipped','todo']){
  const candidates=lines.filter(line=>line.startsWith('# '+field+' '));
  const match=candidates.length===1&&new RegExp('^# '+field+' (0|[1-9][0-9]*)$').exec(candidates[0]);
  if(!match||!Number.isSafeInteger(Number(match[1])))errors.push('invalid_'+field);
  else summary[field]=Number(match[1]);
 }
 if(Object.keys(summary).length===7)report.summary=summary;
 const plans=lines.filter(line=>/^1\.\./.test(line));
 const plan=plans.length===1&&/^1\.\.(0|[1-9][0-9]*)$/.exec(plans[0]);
 const records=lines.filter(line=>/^(?:not ok|ok)\b/.test(line));
 if(!plan||!Number.isSafeInteger(Number(plan[1])))errors.push('invalid_plan');
 if(report.summary){
  if(summary.tests===0)errors.push('no_tests');
  if(summary.suites!==0)errors.push('unsupported_nested_suite');
  if(plan&&Number(plan[1])!==summary.tests)errors.push('plan_count_mismatch');
  if(records.length!==summary.tests)errors.push('record_count_mismatch');
  for(let i=0;i<records.length;i++){
   const match=/^(ok|not ok) ([1-9][0-9]*)(?: - .*)?$/.exec(records[i]);
   if(!match||Number(match[2])!==i+1)errors.push('invalid_test_sequence');
  }
  if(summary.pass!==summary.tests||['fail','cancelled','skipped','todo'].some(field=>summary[field]!==0))errors.push('tests_not_all_passed');
  if(records.some(line=>/^not ok\b/.test(line)||/ # (?:SKIP|TODO)\b/i.test(line)))errors.push('nonpassing_test_record');
 }
 if(result.code!==0)errors.push('nonzero_exit');
 report.status=errors.length?'invalid':'passed';
 return report;
}
