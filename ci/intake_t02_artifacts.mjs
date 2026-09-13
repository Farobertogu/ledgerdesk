import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url));
const secretKey=/^(?:cookie|cookies|set-cookie|csrf(?:_token)?|authorization|token|password|verifier|connectionString|digestKey|ca|cert|key|privateKey|tls|headers|body|payload|declaration|Env|Config|Mounts|HostConfig|GraphDriver|args|stderr|original_value|original_text|text|proof|challenge|sessionToken)$/i;
const redactString=value=>value.replace(/-----BEGIN [\s\S]*?-----END [^-]+-----/g,'[certificate-or-key]')
  .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi,'[database-connection]')
  .replace(/[A-Za-z]:[\\/][^\r\n"']+/g,'[local-path]')
  .replace(/\?[^\s"']*/g,'[query-omitted]');
export function publicEvidence(value,key=''){
  if(secretKey.test(key))return '[omitted]';
  if(key==='code'&&typeof value==='string'&&!/^(?:[0-9A-Z]{5}|ERR_[A-Z_]+)$/.test(value))return '[omitted]';
  if(key==='stdout')return typeof value==='string'?value.split('\n').filter(l=>/^\s*(?:not ok \d+ - |# (?:tests|pass|fail|cancelled|skipped|todo|duration_ms) )/.test(l)).map(redactString):'[omitted]';
  if(Array.isArray(value))return value.map(v=>publicEvidence(v,key));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,publicEvidence(v,k)]));
  return typeof value==='string'?redactString(value):value;
}
export function eligibleEvidence(relative){return !relative.split('/').some(p=>p==='source'||p==='control'||p.startsWith('.'))&&
  !/(?:backup|restore|cut)-data|admin-(?:request|response)|launch-config|credentials|certificates/i.test(relative)&&
  (/\.json$/.test(relative)||/(?:^|\/)(?:coupled-(?:runtime|invitations|reading|administration|journey)|browser)\/[^/]+\.png$/.test(relative));}
export async function collectPublicEvidence(input,output,job){
  await fs.mkdir(output,{recursive:true});const files=[],omitted=[],failures=[];
  async function visit(relative=''){
    let entries;try{entries=await fs.readdir(path.join(input,relative),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
    for(const e of entries){const name=path.posix.join(relative,e.name);if(e.isSymbolicLink())throw Error('EVIDENCE_LINK');
      if(e.isDirectory()){if(!['source','control'].includes(e.name)&&!e.name.startsWith('.'))await visit(name);else omitted.push({path:name,reason:'source-or-private-control'});continue;}
      if(!eligibleEvidence(name)){omitted.push({path:name,reason:'not-public-json'});continue;}
      const stat=await fs.stat(path.join(input,name));if(stat.size>8388608){failures.push({path:name,reason:'public-evidence-size'});continue;}
      try{const raw=await fs.readFile(path.join(input,name));let bytes,kind='sanitized-json';
        if(name.endsWith('.png')){
          if(!raw.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('PUBLIC_PNG_SIGNATURE');
          bytes=raw;kind='synthetic-browser-png-unchanged';
        }else bytes=Buffer.from(JSON.stringify(publicEvidence(JSON.parse(raw)),null,2)+'\n');
        const target=path.join(output,name);
        await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});
        files.push({path:name,kind,rawBytes:raw.length,rawSha256:createHash('sha256').update(raw).digest('hex'),publicBytes:bytes.length,publicSha256:createHash('sha256').update(bytes).digest('hex')});
      }catch(e){failures.push({path:name,reason:e.code??'public-evidence-invalid-json'});}
    }
  }
  await visit();await fs.writeFile(path.join(output,'PUBLIC-MANIFEST.json'),JSON.stringify({profile:'intake-public-evidence/1',job,
    boundary:'Sanitized structural JSON, not byte-identical raw observations; existing synthetic browser PNGs retained unchanged. Raw files remain in the owned run; original fixtures and source are repository inputs.',
    files,omitted,failures,complete:failures.length===0&&files.length>0},null,2),{flag:'wx'});
  return failures.length===0&&files.length>0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const job=process.argv[process.argv.indexOf('--job')+1];if(!['behavior','recovery','mutations'].includes(job))throw Error('PUBLIC_EVIDENCE_JOB');
  const input=path.join(root,'test-results/intake-t02'),output=path.join(root,'test-results/intake-t02-public',job);
  if(!await collectPublicEvidence(input,output,job))process.exitCode=1;
}
