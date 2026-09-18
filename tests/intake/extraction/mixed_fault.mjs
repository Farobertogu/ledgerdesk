/** Three controlled component outcomes inserted into a disposable materializer
 * copy. The real adapters do not claim to discover these synthetic components. */
export function mixedComponentsCopy(source){
  const anchor="    outcome=observation.extraction.outcome as 'completed'|'partial';";
  if(source.split(anchor).length!==2)throw Error('MIXED_COMPONENT_ANCHOR');
  return source.replace(anchor,anchor+`
    // Instrumented component branch for persistence/query fidelity only.
    body.components.push(
      {id:'damaged-cell',execution:'failed',coverage:'unknown',fidelity:'unchecked',limitations:['instrumented-component'],incidents:['damaged-cell-incident']},
      {id:'visual-region',execution:'not_attempted',coverage:'none',fidelity:'unchecked',limitations:['instrumented-component'],incidents:['visual-region-incident']},
      {id:'notes-stage',execution:'failed',coverage:'unknown',fidelity:'unchecked',limitations:['instrumented-component'],incidents:['notes-stage-incident']});
    body.incidents.push(
      {id:'damaged-cell-incident',component:'damaged-cell',cause:'unreadable',code:'invalid_cell_address'},
      {id:'visual-region-incident',component:'visual-region',cause:'route_unoffered',code:'unsupported_profile'},
      {id:'notes-stage-incident',component:'notes-stage',cause:'technical_failure',code:'worker_timeout'});
    outcome='partial';`);
}
