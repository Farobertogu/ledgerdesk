import {writeFileSync, renameSync} from 'node:fs';
import path from 'node:path';

export const checkpointCases = Object.freeze(['W01', 'W14-prepared', 'W14-difference', 'W15', 'W16',
  'W17-false', 'W17-true', 'W18', 'W19-same-account', 'W19-other-account', 'W20']);
const caseStages = new Set(['action_started', 'action_returned', 'action_threw', 'observer_settled']);
const segmentStages = new Set(['workspace_enter', 'app_prepare_enter', 'chromium_launch_enter', 'protection_enter',
  'context_close_enter', 'browser_close_enter', 'server_close_enter', 'app_close_enter', 'workspace_closed']);
export const checkpointFailureMarker = 'INTAKE_WORKSPACE_CHECKPOINT_WRITE_FAILED';
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
const allowed = (caseId, stage) => caseId === null ? segmentStages.has(stage) : checkpointCases.includes(caseId) && caseStages.has(stage);

export function validateCheckpoint(value) {
  if (!exact(value, ['profile', 'group', 'events', 'overflow']) || value.profile !== 'intake-workspace-checkpoints/1' ||
      value.group !== 'ui-protection' || !Array.isArray(value.events) || value.events.length > 64 ||
      !Number.isSafeInteger(value.overflow) || value.overflow < 0) throw Error('WORKSPACE_CHECKPOINT_INVALID');
  if (value.events.some((event, i) => !exact(event, ['seq', 'caseId', 'stage']) || event.seq !== i + 1 ||
      !allowed(event.caseId, event.stage))) throw Error('WORKSPACE_CHECKPOINT_INVALID');
  return {profile: value.profile, group: value.group,
    events: value.events.map(({seq, caseId, stage}) => ({seq, caseId, stage})), overflow: value.overflow};
}

function atomicWrite(directory, bytes) {
  const pending = path.join(directory, 'workspace-checkpoints.pending');
  writeFileSync(pending, bytes);
  renameSync(pending, path.join(directory, 'workspace-checkpoints.json'));
}

// Fixed boundaries only. Diagnostic failure must neither replace an action's
// error nor turn it into success; the fixed marker invalidates a stale file.
export function createWorkspaceCheckpoint(directory, {persist = atomicWrite, report = console.log} = {}) {
  const state = {profile: 'intake-workspace-checkpoints/1', group: 'ui-protection', events: [], overflow: 0};
  let failed = false;
  function mark(stage, caseId = null) {
    try {
      if (!allowed(caseId, stage)) throw Error('WORKSPACE_CHECKPOINT_INVALID');
      if (state.events.length < 64) state.events.push({seq: state.events.length + 1, caseId, stage});
      else state.overflow = Math.min(Number.MAX_SAFE_INTEGER, state.overflow + 1);
      const bytes = Buffer.from(JSON.stringify(state) + '\n');
      if (bytes.length > 16384) throw Error('WORKSPACE_CHECKPOINT_BOUND');
      persist(directory, bytes);
    } catch {
      if (!failed) {failed = true; try {report(checkpointFailureMarker);} catch { /* Preserve the existing outcome. */ }}
    }
  }
  mark('workspace_enter');
  return {mark, wrap(observer) {
    return {mark: (...args) => observer.mark(...args), async run(name, action) {
      try {
        return await observer.run(name, async () => {
          mark('action_started', name);
          try {const result = await action(); mark('action_returned', name); return result;}
          catch (error) {mark('action_threw', name); throw error;}
        });
      } finally {mark('observer_settled', name);}
    }};
  }};
}
