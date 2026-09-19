import {randomUUID,createHash} from 'node:crypto';
import {ExtractionAuthority,type ExtractionAdmission} from './extraction_authority.ts';
import {admitJob,claimJob,extractionRequest,extractionEvent,advanceJob} from './extraction_store.ts';
import {PrivateExtractionPort,extractionSubject,type CompletedWorker,type SealedExtraction} from './extraction_ports.ts';
import {materializeExtraction,materializeSupervisorFailure} from './extraction_output.ts';
import {integrateResourceBoundary,type ResourceBoundaryPort} from './extraction_resources.ts';
import {extractionPhase} from './extraction_phase.ts';
import {finishClosedExtractionStop} from './extraction_stop_completion.ts';
import {recordUncertainDispatch} from './extraction_uncertain.ts';
import {PrivateIntakePort} from './ports.ts';
import {IntakeFailure} from './protocol.ts';
import {type IntakeConfig,intakeConfig} from './config.ts';
import {EXTRACTION_BOUNDS,type WorkerBinding,type WorkerRequest,type Artifact} from '../../contracts/intake_extraction.ts';

type Hooks={observe?:(event:Record<string,unknown>)=>void;barrier?:(label:string,event:Record<string,unknown>)=>Promise<void>;
  instrumentedResources?:ResourceBoundaryPort};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
/** An internal controlled consumer. No public dispatch or approval endpoint. */
export class ExtractionService {
  readonly config:IntakeConfig;readonly authority:ExtractionAuthority;
  readonly objects:PrivateIntakePort;readonly extraction=new PrivateExtractionPort('extraction');readonly outputs=new PrivateExtractionPort('outputs');
  readonly hooks:Hooks;
  constructor(config:IntakeConfig,hooks:Hooks={}){
    this.hooks=hooks;
    this.config=intakeConfig(config);this.authority=new ExtractionAuthority(this.config,hooks.observe);
    this.objects=new PrivateIntakePort(this.config.brokerSocket,1500000,1000,this.config.namespace);
  }
  async clock(a:ExtractionAdmission,label:string){
    const now=await a.db.now();
    if(!a.db.healthy||now>=a.deadline)throw new IntakeFailure(404);
    // Observation follows the actual evaluation, without adding a later check
    // that would hide the writer-free interval before the protected effect.
    await this.hooks.barrier?.(label,{jobId:a.work.id,backendPid:a.db.backendPid,deadlineMs:a.deadline,lastEvaluationMs:now});
  }
  async phase<T>(a:ExtractionAdmission,request:WorkerRequest,evidenceId:string,plan:Record<string,string[]>,
    work:(phaseId:string)=>Promise<T>):Promise<{value:T;phaseId:string}>{
    return extractionPhase({db:a.db,config:this.config,deadline:a.deadline,binding:request.binding,
      jobId:a.work.id,evidenceId,plan,releaseAdmission:true,ports:{objects:this.objects,extraction:this.extraction,outputs:this.outputs},
      clock:label=>this.clock(a,label),barrier:this.hooks.barrier},work);
  }
  command(a:ExtractionAdmission,request:WorkerRequest,phaseId:string,evidenceId:string){
    return{profile:'intake-extraction-private/1' as const,phaseId,incarnation:this.config.incarnation,namespace:this.config.namespace,
      original:request.binding.original,evidenceId,subject:extractionSubject(request.binding)};
  }
  async recordLaunch(a:ExtractionAdmission,m:Pick<CompletedWorker,'container_id'|'image'|'pid'|'started_at'|'channel_id'>){
    const previous=(await a.db.query("SELECT observation FROM $INTAKE.extraction_event WHERE job_id=$1 AND attempt_generation=$2 AND kind='launch'",
      [a.work.id,a.job?.attempt_generation])).rows[0]?.observation;
    const observation={containerId:m.container_id,image:m.image,pid:m.pid,startedAt:m.started_at,channelId:m.channel_id};
    if(previous){
      if(Object.keys(observation).some(k=>previous[k]!==observation[k as keyof typeof observation]))throw new IntakeFailure(503);
    }else await extractionEvent(a,'launch',observation);
    if(a.job?.state==='claimed')await advanceJob(a,'running');
  }
  async dispatch(jobId:string):Promise<{binding:WorkerBinding;metadata:CompletedWorker}>{
    return this.execute(jobId);
  }
  /** Retry one known, closed transport interruption, never reconcile by rerunning.
   * The exact predecessor generation prevents a delayed retry from advancing twice. */
  async retry(jobId:string,predecessorGeneration:number):Promise<{binding:WorkerBinding;metadata:CompletedWorker}>{
    if(!Number.isSafeInteger(predecessorGeneration)||predecessorGeneration<1)throw new IntakeFailure(409);
    return this.execute(jobId,predecessorGeneration);
  }
  private async execute(jobId:string,retryGeneration?:number):Promise<{binding:WorkerBinding;metadata:CompletedWorker}>{
    const a=await this.authority.open(jobId,'dispatch_extraction',()=>{});
    let claimed:WorkerBinding|undefined;
    try{
      if(retryGeneration!==undefined){
        if(!a.job||!['running','uncertain'].includes(a.job.state)||a.job.attempt_generation!==retryGeneration||
          retryGeneration>=EXTRACTION_BOUNDS.maximumAttempts||a.job.accepted_result)throw new IntakeFailure(409);
        const prior=(await a.db.query(`SELECT a.binding,e.observation FROM $INTAKE.extraction_attempt a
          JOIN $INTAKE.extraction_event e ON e.job_id=a.job_id AND e.attempt_generation=a.attempt_generation AND e.kind='termination'
          WHERE a.job_id=$1 AND a.attempt_generation=$2`,[jobId,retryGeneration])).rows[0];
        // Closure is recorded only from the assigned channel and real process.
        // Input transport interruption is the only enabled retry class here.
        if(!prior||prior.observation.observed!=='closed'||prior.observation.reason!=='input_failure'||
          prior.observation.channelId!==prior.binding.channel_id||
          (await a.db.query('SELECT 1 FROM $INTAKE.extraction_output WHERE job_id=$1',[jobId])).rowCount||
          (await a.db.query('SELECT active_phase FROM intake_control.fence_head')).rows[0]?.active_phase)throw new IntakeFailure(409);
        this.authority.resolveBinding(a,'dispatch_extraction',prior.binding);
        const evidence=await this.authority.evidence(a,'dispatch_extraction','read_admission');
        await extractionEvent(a,'reconciled',{decision:'retry-closed-input-interruption',predecessorGeneration:retryGeneration,
          channelId:prior.binding.channel_id},evidence);
        await advanceJob(a,'eligible');
      }
      await admitJob(a);const request=extractionRequest(a);
      this.authority.resolveBinding(a,'dispatch_extraction',request.binding);
      const evidenceId=await this.authority.evidence(a,'dispatch_extraction','read_admission');
      await claimJob(a,request,evidenceId);
      claimed=request.binding;
      const completed=await this.phase(a,request,evidenceId,{objects:['read'],extraction:['run']},async phaseId=>{
        await this.clock(a,'before_extraction_original_read');
        const read=await this.objects.call({action:'read',phaseId,original:request.binding.original,incarnation:this.config.incarnation,evidenceId});
        const bytes=read.ok&&typeof read.data==='string'?Buffer.from(read.data,'base64'):null;
        if(!bytes||bytes.length!==request.binding.original.bytes||hash(bytes)!==request.binding.original.sha256)throw new IntakeFailure(503);
        await this.clock(a,'before_extraction_input_dispatch');
        let settled=false,reply:any,runFailure:unknown,launched=false;
        const running=this.extraction.call({...this.command(a,request,phaseId,evidenceId),action:'run',request,image:a.declaration.image,data:bytes.toString('base64')})
          .then(value=>{reply=value;settled=true;},error=>{runFailure=error;settled=true;});
        while(!settled){
          const launch=await this.extraction.observeLaunch(phaseId,extractionSubject(request.binding));
          if(launch&&!launched){
            if(launch.channel_id!==request.binding.channel_id||launch.image!==a.declaration.image||!Number.isSafeInteger(launch.pid)||launch.pid<=0||
              !/^[a-f0-9]{64}$/.test(launch.container_id)||typeof launch.started_at!=='string')throw new IntakeFailure(503);
            await a.db.begin([]);
            a.job=(await a.db.query('SELECT * FROM $INTAKE.extraction_job WHERE id=$1',[jobId])).rows[0];
            await this.recordLaunch(a,launch);await a.db.commit();launched=true;
            await this.hooks.barrier?.('after_extraction_launch',{jobId,phaseId,containerId:launch.container_id});
          }
          if(!settled)await new Promise(resolve=>setTimeout(resolve,25));
        }
        await running;if(runFailure)throw runFailure;
        const m=reply.metadata;
        if(!reply.ok||!m||m.channel_id!==request.binding.channel_id||m.image!==a.declaration.image||m.raw?.id!==request.binding.channel_id||
          m.raw?.generation!==request.binding.attempt_generation||!Array.isArray(m.observations)||
          !m.observations.some((x:any)=>x.kind==='closed'&&x.id===m.container_id&&x.channel_id===m.channel_id))throw new IntakeFailure(503);
        return m as CompletedWorker;
      });
      a.job=(await a.db.query('SELECT * FROM $INTAKE.extraction_job WHERE id=$1',[jobId])).rows[0];
      await this.recordLaunch(a,completed.value);
      await extractionEvent(a,'termination',{observed:'closed',containerId:completed.value.container_id,closedAt:completed.value.closed_at,
        exitCode:completed.value.exit_code,reason:completed.value.reason,channelId:completed.value.channel_id,raw:completed.value.raw});
      if(a.job?.state==='stopping')await finishClosedExtractionStop(a.db,a.job);
      else if(a.job?.state!=='running')throw new IntakeFailure(503);
      await a.db.commit();
      return{binding:request.binding,metadata:completed.value};
    }catch(error){
      await a.db.close();
      if(claimed)try{await recordUncertainDispatch(this.config,claimed);}
      catch{this.hooks.observe?.({origin:'dispatch-bookkeeping',jobId,recorded:false,unresolved:true});}
      throw error;
    }finally{await a.db.close();}
  }
  async accept(jobId:string):Promise<{resultId:string;effectId:string}> {
    // A query of an already accepted effect uses the separate query path, not this new-effect entry.
    const a=await this.authority.open(jobId,'accept_extraction_result',()=>{});
    if(a.job?.state==='result_staged'){
      await a.db.close();return this.commitStaged(jobId);
    }
    try{
      if(!a.job||a.job.state!=='running')throw new IntakeFailure(409);
      const attempt=(await a.db.query('SELECT * FROM $INTAKE.extraction_attempt WHERE job_id=$1 AND attempt_generation=$2',[jobId,a.job.attempt_generation])).rows[0];
      const ended=(await a.db.query("SELECT observation FROM $INTAKE.extraction_event WHERE job_id=$1 AND attempt_generation=$2 AND kind='termination'",[jobId,a.job.attempt_generation])).rows[0]?.observation;
      if(!attempt||ended?.observed!=='closed'||!ended.raw)throw new IntakeFailure(503);
      const binding:WorkerBinding=attempt.binding;
      this.authority.resolveBinding(a,'accept_extraction_result',binding,ended.raw);
      const request:WorkerRequest={profile:'intake-worker/3',kind:'extract',binding,input_path:'/input/original',limits:EXTRACTION_BOUNDS};
      const evidenceId=await this.authority.evidence(a,'accept_extraction_result','read_admission');
      const sealed=await this.phase(a,request,evidenceId,{extraction:['read'],outputs:['seal']},async phaseId=>{
        const base=this.command(a,request,phaseId,evidenceId);
        await this.clock(a,'before_extraction_result_read');
        const reply=await this.extraction.call({...base,action:'read',raw:ended.raw});
        if(!reply.ok||typeof reply.data!=='string')throw new IntakeFailure(503);
        const raw=Buffer.from(reply.data,'base64');
        if(raw.length!==ended.raw.bytes||hash(raw)!==ended.raw.sha256)throw new IntakeFailure(503);
        let material=ended.reason===null?materializeExtraction(raw,binding,ended.channelId):
          materializeSupervisorFailure(raw,binding,ended.channelId,ended.reason);
        if(this.hooks.instrumentedResources)material=await integrateResourceBoundary(material,binding,this.hooks.instrumentedResources,
          ()=>this.clock(a,'before_extraction_resource_read'));
        // Identity was committed with the attempt, before reading or sealing an
        // output. A lost seal/SQL reply must not allocate another artifact.
        const normalized:Artifact={id:attempt.normalized_id,generation:binding.attempt_generation,bytes:material.normalized.length,sha256:material.normalizedSha256};
        await this.clock(a,'before_extraction_output_seal');
        const output=await this.outputs.call({...base,action:'seal',raw:ended.raw,normalized,data:material.raw.toString('base64'),normalizedData:material.normalized.toString('base64')});
        if(!output.ok||JSON.stringify(output.bundle)!==JSON.stringify({id:binding.channel_id,raw:ended.raw,normalized,namespace:this.config.namespace,subject:base.subject}))throw new IntakeFailure(503);
        return{bundle:output.bundle as SealedExtraction,outcome:material.outcome};
      });
      const bundle=sealed.value.bundle,outcome=sealed.value.outcome;
      await this.hooks.barrier?.('after_extraction_seal_before_sql',{jobId,outputId:bundle.id});
      await a.db.query(`INSERT INTO $INTAKE.extraction_output(id,job_id,attempt_generation,channel_id,raw_id,raw_bytes,raw_sha256,
        normalized_id,normalized_bytes,normalized_sha256,sha256,location_binding,seal_evidence,seal_phase,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[bundle.id,jobId,binding.attempt_generation,binding.channel_id,
          bundle.raw.id,bundle.raw.bytes,bundle.raw.sha256,bundle.normalized.id,bundle.normalized.bytes,bundle.normalized.sha256,
          hash(Buffer.from(JSON.stringify(bundle))),JSON.stringify(bundle),evidenceId,sealed.phaseId,await a.db.now()]);
      await extractionEvent(a,'staged',{outputId:bundle.id,outcome},evidenceId);await advanceJob(a,'result_staged');await a.db.commit();
      await this.hooks.barrier?.('after_extraction_stage_commit',{jobId,outputId:bundle.id});
    }finally{await a.db.close();}
    return this.commitStaged(jobId);
  }
  private async commitStaged(jobId:string):Promise<{resultId:string;effectId:string}>{
    // New connection, current authority and short RR snapshot, after output sealing.
    const current=await this.authority.open(jobId,'accept_extraction_result',()=>{});
    try{
      if(!current.job||current.job.state!=='result_staged')throw new IntakeFailure(409);
      const row=(await current.db.query(`SELECT a.binding,o.location_binding,e.observation FROM $INTAKE.extraction_output o
        JOIN $INTAKE.extraction_attempt a ON a.job_id=o.job_id AND a.attempt_generation=o.attempt_generation
        JOIN $INTAKE.extraction_event e ON e.job_id=o.job_id AND e.attempt_generation=o.attempt_generation AND e.kind='staged'
        WHERE o.job_id=$1 AND o.attempt_generation=$2`,[jobId,current.job.attempt_generation])).rows[0];
      if(!row||!['completed','partial','failed'].includes(row.observation.outcome))throw new IntakeFailure(503);
      const binding:WorkerBinding=row.binding,bundle:SealedExtraction=JSON.parse(row.location_binding);
      if(row.observation.outputId!==bundle.id)throw new IntakeFailure(503);
      this.authority.resolveBinding(current,'accept_extraction_result',binding,bundle.normalized);
      const resultId=randomUUID(),effectId=current.job.effect_slot;
      const evidence=await this.authority.evidence(current,'accept_extraction_result','effect');
      await current.db.query('INSERT INTO $INTAKE.extraction_result VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [resultId,jobId,binding.attempt_generation,effectId,bundle.id,row.observation.outcome,evidence,await current.db.now()]);
      await current.db.query('SELECT $INTAKE.accept_extraction($1,$2,$3)',[jobId,current.job.revision,resultId]);
      await extractionEvent(current,'accepted',{resultId,effectId},evidence);
      await this.clock(current,'before_extraction_accept_commit');await current.db.commit();
      await this.hooks.barrier?.('after_extraction_accept_commit',{jobId,resultId,effectId});
      return{resultId,effectId};
    }finally{await current.db.close();}
  }
}
