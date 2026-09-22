import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {projectMemoryProof} from './intake/extraction/memory_qualification.mjs';
import {readWorkspaceDiagnostic} from './intake/workspace_diagnostic.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const runPattern=/^intake-extraction-[0-9]{4}-[0-9]{2}-[0-9]{2}[tT][0-9-]+[zZ]-[a-f0-9]{8}$/;
const commandPattern=/^[0-9]{3,6}-command\.json$/;
const groups=new Set(['units','schema','worker','extraction','composition']);
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const bootstrapCodes=new Set(['ERR_TEST_FAILURE','ERR_ASSERTION','ETIMEDOUT','ECONNREFUSED','ECONNRESET','EPIPE','ENOENT','EACCES','EADDRINUSE','ERR_IPC_CHANNEL_CLOSED']);
const bootstrapReasons=new Map([
  ...['APPLICATION_CLOSED_BEFORE_READY','APPLICATION_NOT_READY','APPLICATION_OBSERVATIONS_UNCONFIRMED',
    'APPLICATION_CHILD_FAILED','APPLICATION_START_TICKS','APPLICATION_CLOSED','APPLICATION_CLOSE_UNCONFIRMED','APPLICATION_CLOSE_FAILED',
    'APPLICATION_NOT_TERMINATED'].map(value=>[value,value]),
  ['T02 bounded HTTPS timeout','T02_HTTPS_TIMEOUT'],
]);
const failureTypes=new Set(['testTimeoutFailure','cancelledByParent','testCodeFailure','subtestsFailed','hookFailed']);
const bootstrapSources=new Map([
  ['tests/access/runtime_environment.mjs','runtime-environment'],['tests/access/journey_environment.mjs','journey-environment'],
  ['tests/intake/t02/test_runtime.mjs','runtime-test'],['tests/intake/t02/application_process.mjs','application-process'],
  ['tests/intake/t02/application_child.mjs','application-child'],
]);
// Select the attached execution by its owned resource, never docker logs or a
// later failed bridge poll. Keep only closed fields from the first TAP failure.
function runtimeFirstFailure(m,observations){
  if(m.group!=='extraction')return undefined;
  const owned=m.resources.filter(r=>r&&r.type==='container'&&typeof r.name==='string'&&/^ld-i03-t02-[a-f0-9]{8}-runtime$/.test(r.name)&&
    typeof r.id==='string'&&/^[a-f0-9]{64}$/.test(r.id));
  if(owned.length!==1)return undefined;
  const selected=observations.flatMap((o,index)=>o&&['docker','docker.exe'].includes(o.program)&&Array.isArray(o.args)&&
    o.args.length===3&&o.args[0]==='start'&&o.args[1]==='-a'&&o.args[2]===owned[0].name?[{o,index}]:[]);
  if(selected.length!==1)return {status:'invalid',capture:'invalid'};
  const {o,index}=selected[0],record=m.commands[index];
  if(!record||record.code!==o.code||(record.reason??null)!==(o.reason??null))return {status:'invalid',capture:'invalid'};
  const result={commandOrdinal:index+1,observation:index+1,status:'unavailable',capture:'invalid'};
  for(const stream of ['stdout','stderr']){
    if(typeof o[stream]!=='string'||integer(o[stream+'Bytes'])===null||integer(o[stream+'RetainedBytes'])===null||
      o[stream+'EncodingError']!==false||Buffer.byteLength(o[stream])!==o[stream+'RetainedBytes']||
      o[stream+'Bytes']<o[stream+'RetainedBytes'])return result;
  }
  if(typeof o.stderrTruncated!=='boolean')return result;
  result.capture=o.stdoutBytes!==o.stdoutRetainedBytes||o.stderrBytes!==o.stderrRetainedBytes||o.stderrTruncated?'truncated':'present';
  if(result.capture!=='present'||o.reason)return result;
  const lines=o.stdout.split(/\r?\n/);
  if(lines.filter(line=>line==='TAP version 13').length!==1)return {...result,status:'invalid'};
  for(let i=0;i<lines.length;i++){
    const record=/^( *)((?:not ok|ok)) [1-9][0-9]* - [^\r\n]*$/.exec(lines[i]);
    if(!record)continue;
    const indent=record[1]+'  ',values={code:[],failureType:[],error:[]},frames=[];
    let ended=false,stack=false,j=i+1;
    if(lines[j]===indent+'---')for(j++;j<lines.length;j++){
      if(lines[j]===indent+'...'){ended=true;break;}
      if(lines[j].trim()&&!lines[j].startsWith(indent))break;
      const field=new RegExp('^'+indent+"(code|failureType|error): '([^']*)'$").exec(lines[j]);
      if(field)values[field[1]].push(field[2]);
      if(lines[j]===indent+'stack: |-'){stack=true;continue;}
      if(stack&&!lines[j].startsWith(indent+'  '))stack=false;
      if(stack&&frames.length<2){
        const frame=new RegExp('^'+indent+'  (?:at )?(?:async )?(?:[A-Za-z0-9_.<>]+ \\()?file:///work/([^ :()]+):([1-9][0-9]{0,5}):([1-9][0-9]{0,5})\\)?$').exec(lines[j]);
        if(frame&&bootstrapSources.has(frame[1]))frames.push({source:bootstrapSources.get(frame[1]),line:Number(frame[2]),column:Number(frame[3])});
      }
    }
    if(record[2]==='not ok'){
      if(!ended)return {...result,status:'invalid'};
      return {...result,status:'observed',code:values.code.length===1&&bootstrapCodes.has(values.code[0])?values.code[0]:null,
        failureType:values.failureType.length===1&&failureTypes.has(values.failureType[0])?values.failureType[0]:null,
        errorReason:values.error.length===1?bootstrapReasons.get(values.error[0])??null:null,frames};
    }
    // Literal messages inside a diagnostic are data, including TAP lookalikes.
    if(lines[i+1]===indent+'---'&&!ended)return {...result,status:'invalid'};
    if(ended)i=j;
  }
  return {...result,status:o.code===0?'absent':'unavailable'};
}
async function boundedJson(file){
  const s=await fs.lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||s.size>33554432)throw Error('PUBLIC_INPUT_INVALID');
  const bytes=await fs.readFile(file);return {value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),sha256:digest(bytes)};
}
// Construct every public member. Never recursively redact an arbitrary worker,
// original, manifest, command line, database record or error object.
export function extractionPublicSummary(m,manifestSha256,observations=[],memoryProof){
  if(!runPattern.test(m.runId)||!groups.has(m.group)||!Array.isArray(m.commands)||!Array.isArray(m.resources)||
    !/^[a-f0-9]{64}$/.test(manifestSha256))throw Error('PUBLIC_MANIFEST_INVALID');
  const completed=typeof m.completed==='boolean'?m.completed:m.outcome==='passed'?true:m.outcome==='failed'?false:null;
  if(completed===null)throw Error('PUBLIC_MANIFEST_UNFINISHED');
  const commands=m.commands.map((c,index)=>{
    if(!commandPattern.test(c.file))throw Error('PUBLIC_COMMAND_REFERENCE');
    return {ordinal:index+1,exitCode:Number.isSafeInteger(c.code)?c.code:null,interrupted:c.reason!==null&&c.reason!==undefined};
  });
  const counts=[];
  for(const [index,o]of observations.entries()){
    const row={observation:index+1};
    for(const field of ['tests','pass','fail','cancelled','skipped','todo']){
      const lines=typeof o.stdout==='string'?o.stdout.split(/\r?\n/):[];
      const values=lines.flatMap(line=>{const match=new RegExp('^# '+field+' ([0-9]+)$').exec(line);return match?[Number(match[1])]:[];});
      if(values.length)row[field]=integer(values.at(-1));
    }
    if(Object.keys(row).length>1)counts.push(row);
  }
  let memory;
  if(m.memory!==undefined){
    assert.equal(typeof m.memory.required,'boolean','PUBLIC_MEMORY_REQUIREMENT');
    memory={required:m.memory.required,qualified:false};
    if(memory.required){
      assert.equal(m.group,'worker','PUBLIC_MEMORY_GROUP');
      if(memoryProof){
        const proof=projectMemoryProof(memoryProof);assert.equal(proof.image,m.memory.image,'PUBLIC_MEMORY_IMAGE');
        assert.equal(m.memory.qualified,true,'PUBLIC_MEMORY_STATUS');assert.equal(completed,true,'PUBLIC_MEMORY_FAILED_RUN');
        memory={required:true,qualified:true,image:proof.image,proofSha256:digest(Buffer.from(JSON.stringify(proof,null,2)+'\n'))};
      }
    }else assert.equal(m.memory.qualified,false,'PUBLIC_UNREQUESTED_MEMORY');
  }else assert.equal(memoryProof,undefined,'PUBLIC_UNREQUESTED_MEMORY');
  const firstFailure=runtimeFirstFailure(m,observations);
  return {profile:'intake-extraction-public/1',runId:m.runId,group:m.group,manifestSha256,completed:memory?.required&&!memory.qualified?false:completed,commands,
    ...(memory?{memory}:{}),
    ...(firstFailure?{firstFailure}:{}),
    resources:{recorded:m.resources.length,cleaned:m.resources.filter(r=>r.cleaned===true||r.removed===true).length},counts};
}
export async function exportExtractionEvidence(input,output){
  await fs.mkdir(output,{recursive:true});
  const rows=[];let complete=true;
  const entries=await fs.readdir(input,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
    if(!runPattern.test(entry.name))continue;
    const directory=path.join(input,entry.name);
    try{
      if(!entry.isDirectory()||entry.isSymbolicLink())throw Error('PUBLIC_RUN_INVALID');
      const {value:m,sha256}=await boundedJson(path.join(directory,'manifest.json'));
      if(m.runId!==entry.name)throw Error('PUBLIC_RUN_ASSOCIATION');
      const observations=[];
      if(!Array.isArray(m.commands))throw Error('PUBLIC_COMMANDS_MISSING');
      for(const c of m.commands){
        if(!commandPattern.test(c.file))throw Error('PUBLIC_COMMAND_REFERENCE');
        observations.push((await boundedJson(path.join(directory,c.file))).value);
      }
      if(m.group==='units')observations.push((await boundedJson(path.join(directory,'unit-result.json'))).value);
      let memoryProof,memoryIncomplete=false;
      if(m.memory?.required===true)try{
        assert.equal(m.memory.proofFile,'memory-proof.json','PUBLIC_MEMORY_PROOF_FILE');
        memoryProof=projectMemoryProof((await boundedJson(path.join(directory,'memory-proof.json'))).value);
      }catch{memoryIncomplete=true;complete=false;}
      const summary=extractionPublicSummary(m,sha256,observations,memoryProof);
      await fs.writeFile(path.join(output,entry.name+'.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
      if(memoryProof)await fs.writeFile(path.join(output,entry.name+'-memory.json'),JSON.stringify(memoryProof,null,2)+'\n',{flag:'wx'});
      const workspace=await readWorkspaceDiagnostic(directory,m,sha256,observations);
      if(workspace)await fs.writeFile(path.join(output,entry.name+'-workspace-diagnostic.json'),JSON.stringify(workspace,null,2)+'\n',{flag:'wx'});
      rows.push({runId:entry.name,exported:!memoryIncomplete});
    }catch{complete=false;rows.push({runId:entry.name,exported:false});}
  }
  if(rows.length===0)complete=false;
  await fs.writeFile(path.join(output,'PUBLIC-MANIFEST.json'),JSON.stringify({profile:'intake-extraction-export/1',complete,rows},null,2)+'\n',{flag:'wx'});
  return complete;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('../',import.meta.url));
  const output=path.join(root,'test-results/intake-extraction-public',randomUUID());
  const complete=await exportExtractionEvidence(path.join(root,'test-results/intake-extraction'),output);
  console.log(JSON.stringify({profile:'intake-extraction-export/1',complete,output}));if(!complete)process.exitCode=1;
}
