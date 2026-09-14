/** Captured-only fault at the real PostgreSQL COMMIT transport boundary. */
export function privateCommitFaultCopy(source) {
  const anchor = 'await db.commit(); // A lost commit reply never dispatches OPEN or application input.';
  if (source.split(anchor).length !== 2) throw Error('PRIVATE_COMMIT_FAULT_ANCHOR');
  return "import * as commitFaultFs from 'node:fs';\n" + source.replace(anchor, `
  const faultPath='/work/output/commit-fault.json';
  const fault=commitFaultFs.existsSync(faultPath)?JSON.parse(commitFaultFs.readFileSync(faultPath,'utf8')):null;
  if(fault?.artifactId===original.id&&fault.generation===original.generation){
    commitFaultFs.renameSync(faultPath,'/work/output/commit-fault-used.json');
    const backendPid=(db.client as any).processID;
    if(fault.kind==='rollback'){
      await db.query('ROLLBACK');
      await service.hooks.barrier?.('phase_commit_rolled_back',{phaseId:id,evidenceId,original,backendPid});
      throw new IntakeFailure(503);
    }
    // Pause the actual database socket BEFORE issuing COMMIT. The independent
    // parent reads durable rows while this client's reply remains unread.
    const socket=(db.client as any).connection.stream;
    socket.pause();
    let settled=false;
    const completion=db.commit().then(()=>{settled=true;return{ok:true,error:null};},error=>{settled=true;return{ok:false,error};});
    try{
      await service.hooks.barrier?.('phase_commit_reply_held',{phaseId:id,evidenceId,original,backendPid});
      if(settled)throw Error('COMMIT_REPLY_WAS_NOT_HELD');
    }finally{socket.destroy();}
    const outcome=await completion;
    await service.hooks.barrier?.('phase_commit_reply_lost',{phaseId:id,evidenceId,original,backendPid,commitResolved:outcome.ok});
    if(outcome.ok)throw Error('COMMIT_LOSS_INJECTION_FAILED');
    throw outcome.error;
  }else{
    ${anchor}
  }
  `);
}
