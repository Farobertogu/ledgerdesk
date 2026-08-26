// tests/agents/promotion_fixture.mjs — what the promotion writer's contract tests share.
//
// Two spies and one valid pair. The spies are the whole point of the arrangement: every refusal this
// writer owes has to happen BEFORE the database is touched, so a store and a reader that throw when
// they are called turn "it refused" into "it refused without asking anybody", which is the property
// that is actually worth having. A refusal that arrived from PostgreSQL would arrive as
// `E_LEDGER_ROW_INCOMPLETE` from inside a transaction, naming nothing about which key was wrong.

import assert from 'node:assert/strict';

import {
  CAPSULE_CONJUNCTS,
  CAPSULE_POWER,
  CONJUNCT_NAMES,
  NO_CANDIDATE_PROPOSED,
  attemptIdFor,
  capsuleRunIdFor,
} from '../../agents/ledger/promotion_row.ts';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

/** A registered prompt version. Any uuid: nothing in the writer resolves it. */
export const INCUMBENT = '7a1a9e00-0000-4000-8000-000000000002';

export const CODE_SHA = '0123456789abcdef0123456789abcdef01234567';
export const TS = '2026-08-26T09:00:00.000Z';

export const STATE = {
  schema_version: '1.0',
  ruleset_hash: 'r'.repeat(64),
  kb_snapshot: `${ORG_A}:kb-2026-08-01`,
};
export const TOOLCHAIN = { app: '0.1.0', ruleset: 'contract@abcdef012345' };

/** A store whose `append` is a failed assertion. Nothing valid ever reaches it in these files. */
export function refusingStore() {
  return {
    calls: 0,
    async append() {
      this.calls += 1;
      assert.fail('the writer reached the store with a payload it should have refused');
    },
    async spentMicroAud() {
      assert.fail('the writer asked the store for consumption');
    },
    async findCached() {
      assert.fail('the writer asked the store for a cached call');
    },
    async close() {},
  };
}

/** A reader whose `findAttempt` is a failed assertion: validation precedes even the pre-read. */
export function refusingReader() {
  return {
    calls: 0,
    async findAttempt() {
      this.calls += 1;
      assert.fail('the writer read the chain before it had finished checking the payloads');
    },
  };
}

/** A reader that answers "nothing is filed", for the cases that are allowed to get that far. */
export function emptyReader() {
  return {
    calls: 0,
    async findAttempt() {
      this.calls += 1;
      return { start: null, terminal: null };
    },
  };
}

export function conjunctsOfCapsule() {
  return Object.fromEntries(
    CONJUNCT_NAMES.map((name) => [
      name,
      { verdict: CAPSULE_CONJUNCTS[name].verdict, reason: CAPSULE_CONJUNCTS[name].reason },
    ]),
  );
}

/** The pair the capsule files, rebuilt here so a case can mutate one field of it. */
export function validPair(overrides = {}) {
  const attempt_id = attemptIdFor(ORG_A);
  const base = {
    claims: { org_id: ORG_A },
    run_id: capsuleRunIdFor(ORG_A),
    start: {
      attempt_id,
      started_at: TS,
      budget_reserved: 0,
      code_sha: CODE_SHA,
    },
    terminal: {
      attempt_id,
      candidate_prompt_version_id: NO_CANDIDATE_PROPOSED.candidateFrom(INCUMBENT),
      incumbent_prompt_version_id: INCUMBENT,
      conjuncts: conjunctsOfCapsule(),
      failing_conjunct: 'precondition_underpowered',
      power: { ...CAPSULE_POWER },
      outcome: 'REJECTED',
      interpretation: 'UNDERPOWERED',
    },
    scored_run: null,
    evidence: {},
    state: STATE,
    toolchain: TOOLCHAIN,
    ts: TS,
  };
  return {
    ...base,
    ...overrides,
    start: { ...base.start, ...(overrides.start ?? {}) },
    terminal: { ...base.terminal, ...(overrides.terminal ?? {}) },
  };
}

/**
 * The two rows of the capsule, in the shape the panel's reader hands over.
 *
 * `verified` is what the reader reports after recomputing `row_hash` over the row it read back; here
 * it is a fixture value, and a case that sets it false is asserting what the panel does with a row
 * whose digest does not match its contents.
 */
export function capsuleRows(overrides = {}) {
  const pair = validPair(overrides);
  return [
    {
      kind: 'start',
      attempt_id: pair.start.attempt_id,
      run_id: pair.run_id,
      seq: 1,
      ticket_id: null,
      output: pair.start,
      verified: true,
      ...(overrides.startRow ?? {}),
    },
    {
      kind: 'terminal',
      attempt_id: pair.terminal.attempt_id,
      run_id: pair.run_id,
      seq: 2,
      ticket_id: null,
      output: pair.terminal,
      verified: true,
      ...(overrides.terminalRow ?? {}),
    },
  ];
}

/** Asserts that `work` is refused with `E_CONFIG_INVALID`, and returns the error for its detail. */
export async function refused(work, label) {
  let raised = null;
  try {
    await work();
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, `${label}: the writer accepted it`);
  assert.equal(raised.code, 'E_CONFIG_INVALID', `${label}: ${raised.message}`);
  return raised;
}
