/** A copied service loses the unread reply to its real business-receipt COMMIT. */
export function receiptCommitFaultCopy(source){
  const anchor="    await admission.db.commit();\n    await this.hooks.barrier?.('before_handoff'";
  if(source.split(anchor).length!==2)throw Error('RECEIPT_COMMIT_FAULT_ANCHOR');
  return "import * as receiptFaultFs from 'node:fs';\n"+source.replace(anchor,`
    const file='/work/output/receipt-commit-fault.json';
    const fault=receiptFaultFs.existsSync(file)?JSON.parse(receiptFaultFs.readFileSync(file,'utf8')):null;
    if(request.route==='finalize_reception'&&fault?.receptionId===subject.receptionId){
      receiptFaultFs.renameSync(file,'/work/output/receipt-commit-fault-used.json');
      const socket=(admission.db.client as any).connection.stream,backendPid=(admission.db.client as any).processID;
      socket.pause();let settled=false;
      const completion=admission.db.commit().then(()=>{settled=true;return{ok:true,error:null};},error=>{settled=true;return{ok:false,error};});
      try{
        await this.hooks.barrier?.('receipt_commit_reply_held',{receptionId:subject.receptionId,evidenceId:event.id,backendPid});
        if(settled)throw Error('RECEIPT_COMMIT_REPLY_NOT_HELD');
      }finally{socket.destroy();}
      const outcome=await completion;
      await this.hooks.barrier?.('receipt_commit_reply_lost',{receptionId:subject.receptionId,backendPid,commitResolved:outcome.ok});
      if(outcome.ok)throw Error('RECEIPT_COMMIT_REPLY_NOT_LOST');
      throw outcome.error;
    }else await admission.db.commit();
    await this.hooks.barrier?.('before_handoff'`);
}
