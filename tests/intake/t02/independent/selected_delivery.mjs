// A committed preparation is not a delivery. Compare only the exact evidence
// selected by a governed handoff with that call's completed HTTP observation.
export function selectedCompletedDeliveries(c,o) {
  for(const handoff of o.transport) {
    if(handoff.kind!=='handoff')continue;
    const call=o.requestBoundaries.find(x=>x.callId===handoff.callId);
    const response=o.responses.find(x=>x.label===call?.responseLabel);
    c.ok(call&&response,'delivery.selected-call-response-required');
    if(response.status===null)continue; // No completed client response to corroborate.
    const evidence=o.evidence.find(x=>x.id===handoff.evidenceId);
    c.ok(evidence,'delivery.selected-evidence-required');
    c.eq([evidence.callId,evidence.operationId,evidence.receptionId,handoff.receptionId,evidence.principal,evidence.phase,evidence.transactionOpen,handoff.route],
      [call.callId,handoff.operationId,call.receptionId,call.receptionId,call.principal,'delivery',false,response.route],
      'delivery.selected-preparation-association');
    c.ok(evidence.atMs<=handoff.atMs&&handoff.atMs<=response.atMs,'delivery.selected-observed-order');
    c.eq(evidence.status,response.status,'delivery.selected-completed-status');
  }
}
