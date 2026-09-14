import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccessConfig } from '../access/config.ts';
import { sessionToken, corsHeaders, preflightHeaders } from '../access/transport.ts';
import { receptionProblem, resolveReceptionPath } from '../../contracts/intake_reception.ts';
import { intakeConfig, type IntakeConfig } from './config.ts';
import { ReceptionService, type IntakeHooks, type PreparedIntake } from './service.ts';
import { IntakeFailure, receptionCommand, receptionEnvelope } from './protocol.ts';
import { PrivateIntakePort } from './ports.ts';
import { collectCommand, uploadOriginal } from './stream.ts';

export function createIntakeTerminal(access:AccessConfig,input:IntakeConfig,digest:(value:string)=>string,hooks:IntakeHooks={}) {
  const config=intakeConfig(input);
  const service=new ReceptionService(config,digest,new PrivateIntakePort(config.brokerSocket,1500000,1000,config.namespace),new PrivateIntakePort(config.verifierSocket,1500000,10000,config.namespace),hooks);
  function diagnostic(error:unknown) {
    // Expose controlled source locations, never exception messages or SQL values.
    const code=typeof (error as any)?.code==='string' && /^[A-Z0-9_]{1,40}$/.test((error as any).code)?(error as any).code:null;
    const locations=error instanceof Error?(error.stack??'').split('\n').slice(1).flatMap(line=>{
      const match=line.match(/src\/server\/(?:intake|access)\/[A-Za-z0-9_./-]+:\d+:\d+/);
      return match?[match[0]]:[];
    }).slice(0,8):[];
    return {status:error instanceof IntakeFailure?error.status:503,code,locations};
  }
  async function observe(prepared:PreparedIntake,outcome:'handed_off'|'interrupted',bytes:number) {
    try {await prepared.observe(outcome,bytes);}
    catch(error) {
      const event={...diagnostic(error),phase:'transport_observation' as const,evidenceId:prepared.evidenceId,
        outcome,bytes,responseStatus:prepared.status};
      let receiver:'absent'|'failed'='absent';
      try {if(hooks.failure){hooks.failure(event);return;}}
      catch {receiver='failed';}
      // Independent of the failed SQL statement. A failed sink must not prevent release.
      // This is a technical signal, not another response or durable transport evidence.
      try {console.error('INTAKE_OBSERVATION_FAILURE '+JSON.stringify({...event,receiver}));}catch { /* Sink unavailable; admission still closes. */ }
    }
  }
  function problem(res:ServerResponse,status:400|403|404|409|413|415|429|503) {
    if(res.headersSent||res.destroyed){res.destroy();return;}
    const bytes=Buffer.from(JSON.stringify(receptionProblem(status)));
    res.sendDate=false;res.writeHead(status,{...corsHeaders(access.transport),'content-type':'application/problem+json',
      'content-length':String(bytes.length),'cache-control':'private, no-store'});res.end(bytes);
  }
  async function handle(req:IncomingMessage,res:ServerResponse) {
    req.pause();let prepared:PreparedIntake|undefined;
    try {
      if(req.method==='OPTIONS') {
        const path=resolveReceptionPath(String(req.headers['access-control-request-method']??''),req.url??'');
        const headers=String(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(s=>s.trim()).sort().join(',');
        if(!path||req.headers.origin!==access.transport.uiOrigin||req.headers.host!==new URL(access.transport.terminalOrigin).host||
          !['content-type,x-ledgerdesk-csrf','content-type,x-ledgerdesk-csrf,x-ledgerdesk-intent'].includes(headers))throw new IntakeFailure(403);
        res.sendDate=false;res.writeHead(204,preflightHeaders(access.transport));res.end();return;
      }
      const request=receptionEnvelope(req,access.transport),token=sessionToken(req.headers.cookie),onLoss=()=>res.destroy();
      if(request.route==='upload_original')prepared=await uploadOriginal(service,request,req,token,onLoss);
      else {
        const bytes=request.method==='POST'?await collectCommand(service,request,req,token,onLoss):Buffer.alloc(0);
        prepared=await service.command(request,receptionCommand(request,bytes),token,onLoss);
      }
      const bytes=prepared.originalBytes??Buffer.from(JSON.stringify(prepared.body));
      await service.clock(prepared.admission,'response-handoff',request.route);
      if(res.destroyed){await observe(prepared,'interrupted',0);return;}
      res.sendDate=false;res.writeHead(prepared.status,{...corsHeaders(access.transport),'content-type':'application/json',
        ...prepared.headers,'content-length':String(bytes.length),'cache-control':'private, no-store'});
      res.end(bytes);
      await observe(prepared,'handed_off',bytes.length);
    }catch(error){
      const event=diagnostic(error);
      hooks.failure?.(event);problem(res,event.status);
    }
    finally{await prepared?.close();}
  }
  return {handle,service};
}
