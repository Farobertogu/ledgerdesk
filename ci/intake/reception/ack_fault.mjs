/** Captured-only transport fault, after a real operation or terminal journal ACK. */
export function lostPrivateAckCopy(source) {
  const anchor = 'if(!connection.destroyed)connection.end(JSON.stringify(reply));';
  if (source.split(anchor).length !== 2) throw Error('PRIVATE_ACK_FAULT_ANCHOR');
  return "import * as ackFaultFs from 'node:fs';\n" + source.replace(anchor, `
      if(reply.ok&&ackFaultFs.existsSync('/output/ack-fault.json')){
        const target=JSON.parse(ackFaultFs.readFileSync('/output/ack-fault.json','utf8'));
        const phaseId=request.phaseId??request.binding?.id;
        const phase=journal.rows[phaseId];
        const original=request.original??(phase?.binding?JSON.parse(phase.binding).original:null);
        if(original?.id===target.artifactId&&original.generation===target.generation&&request.action===target.action){
          ackFaultFs.renameSync('/output/ack-fault.json','/output/ack-fault-used.json');
          observer({origin:'private-ack-boundary',kind:'lost-after-completion',requestId:request.id,phaseId,
            artifactId:original.id,generation:original.generation,action:request.action,participant:mode,
            journalState:phase?.state??null,termination:reply.termination??null,atMs:Date.now()});
          connection.destroy();return;
        }
      }
      ${anchor}`);
}
