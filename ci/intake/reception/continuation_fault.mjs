/** Test observation at a real retired phase, before its fresh effect snapshot. */
export function continuationObservedCopy(source, omitEpochCheck) {
  const anchor = 'await db.begin([]);';
  if (source.split(anchor).length !== 2) throw Error('CONTINUATION_OBSERVER_ANCHOR');
  let result = source.replace(anchor, `await service.hooks.barrier?.('phase_retired_before_snapshot',
    {phaseId:id,evidenceId,original,backendPid:(db.client as any).processID,retiredEpoch:retired.rows[0].epoch});
  ${anchor}`);
  if (omitEpochCheck) {
    const guard = "await db.query('SELECT intake_control.assert_fence_epoch($1)',[retired.rows[0].epoch]);";
    if (result.split(guard).length !== 2) throw Error('CONTINUATION_GUARD_ANCHOR');
    result = result.replace(guard, 'void 0; /* Deliberately omit the epoch admission. */');
  }
  return result;
}
