// test_PROMO_writer_is_idempotent_and_tenant_bound
//
// Two properties that only a live database can decide, and one of them is the mitigation the writer's
// header trades atomicity for.
//
// **Idempotence.** Both unique indexes on an attempt are GLOBAL to the cluster — partial indexes over
// `output->>'attempt_id'` with no `org_id` and no `run_id`. With a random identifier a second run of
// the operator mandate would write a SECOND complete attempt and the panel would show two attempts
// where one thing happened. With the derived one it is a resume: a complete pair comes back
// untouched, a half pair is completed by writing only its terminal. That is what makes a pair that is
// not transactionally atomic tolerable, and it covers a case atomicity does not — a commit the
// operator never saw.
//
// **Tenancy.** The asymmetry is real and measured: under one organisation's claims a SELECT over
// `ledger_entry` returns that organisation's rows, while the unique index is global. So a pre-read can
// truthfully say "no row" and the INSERT still die on a row of another organisation that this role
// can never see. What closes it is that the attempt identifier carries the organisation, and this
// file is where that stops being an argument.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendPromotionPair,
  attemptIdFor,
  capsulePair,
  capsuleRunIdFor,
  filePromotionCapsule,
  promotionRulesetHash,
} from '../../agents/ledger/promotion_row.ts';
import { ORG_A, ORG_B, asOwner, asTenant, makeStore, readChain } from './harness.mjs';

const store = makeStore();
test.after(async () => {
  await store.close();
});

const TS = '2026-08-26T10:00:00.000Z';
const INCUMBENT = '7a1a9e00-0000-4000-8000-000000000002';

/** An attempt of this file's own, so that nothing here collides with a sibling's capsule. */
const RESUME_ATTEMPT = 'de000000-0000-4000-8000-000000000001';
const RESUME_RUN = 'de000000-0000-4000-8000-0000000000ff';

function input(orgId) {
  const ruleset_hash = promotionRulesetHash();
  return {
    claims: { org_id: orgId },
    incumbent_prompt_version_id: INCUMBENT,
    code_sha: '0123456789abcdef0123456789abcdef01234567',
    ts: TS,
    state: { schema_version: '1.0', ruleset_hash, kb_snapshot: `${orgId}:kb-2026-08-01` },
    toolchain: { app: '0.1.0', ruleset: `contract@${ruleset_hash.slice(0, 12)}` },
  };
}

async function promotionRowCount() {
  return asOwner(async (client) => {
    const result = await client.query(
      "select count(*)::int as n from ledger_entry where class in ('start', 'promotion_attempt')",
    );
    return result.rows[0].n;
  });
}

test('a second filing writes nothing and returns the pair that is standing', async () => {
  const first = await filePromotionCapsule(store, store, input(ORG_B));
  assert.equal(first.action, 'filed');

  const before = await promotionRowCount();
  const second = await filePromotionCapsule(store, store, input(ORG_B));
  const after = await promotionRowCount();

  assert.equal(second.action, 'already_filed', 'the second filing opened a second attempt');
  assert.equal(after, before, `${after - before} row(s) were inserted by a repeated filing`);

  assert.equal(second.attempt_id, first.attempt_id);
  assert.equal(second.start.row_hash, first.start.row_hash);
  assert.equal(second.terminal.row_hash, first.terminal.row_hash);
  assert.equal(second.start.seq, first.start.seq);
  assert.equal(second.terminal.seq, first.terminal.seq);

  const chain = await readChain(capsuleRunIdFor(ORG_B));
  assert.equal(chain.length, 2, 'the capsule run holds something other than two rows');
});

test('a dangling start is completed, and only completed', async () => {
  // The residual in its real shape: a `start` on the chain with no terminal behind it — what a crash
  // between the two transactions leaves, and what `ledger_immutable()` makes undeletable for good.
  // The sibling writer puts it there, exactly as the promotion writer would have.
  const { appendSystemRow } = await import('../../agents/ledger/system_row.ts');
  const pair = capsulePair(input(ORG_A));
  const half = {
    ...pair,
    run_id: RESUME_RUN,
    start: { ...pair.start, attempt_id: RESUME_ATTEMPT },
    terminal: { ...pair.terminal, attempt_id: RESUME_ATTEMPT },
  };

  await appendSystemRow(store, {
    run_id: RESUME_RUN,
    org_id: ORG_A,
    class: 'start',
    output: half.start,
    state: half.state,
    toolchain: half.toolchain,
    ts: TS,
  });

  const before = await promotionRowCount();
  const filed = await appendPromotionPair(store, store, half);
  const after = await promotionRowCount();

  assert.equal(filed.action, 'resumed', 'a dangling start was not recognised as one');
  assert.equal(after - before, 1, `${after - before} rows were written to complete a half pair`);

  const chain = await readChain(RESUME_RUN);
  assert.equal(chain.length, 2);
  assert.equal(chain[0].class, 'start');
  assert.equal(chain[1].class, 'promotion_attempt');
  assert.equal(chain[1].prev_hash, chain[0].row_hash);

  // And a third run changes nothing at all.
  const again = await appendPromotionPair(store, store, half);
  assert.equal(again.action, 'already_filed');
  assert.equal(await promotionRowCount(), after);
});

test('the organisation comes from the claims and from nowhere else', async () => {
  // There is no `org_id` in the writer's input — the check job asserts that over the exported key
  // list — so the only thing that can decide where a row lands is the claim set, and
  // `ledger_writer_insert` reads exactly that claim and no other. What this measures is the
  // consequence: a filing made under A's session lands under A, and B's visible chain does not move.
  const beforeB = await asTenant(ORG_B, async (client) => {
    const result = await client.query('select count(*)::int as n from ledger_entry');
    return result.rows[0].n;
  });

  const pair = capsulePair(input(ORG_A));
  const attempt = 'de000000-0000-4000-8000-000000000003';
  await appendPromotionPair(store, store, {
    ...pair,
    run_id: 'de000000-0000-4000-8000-0000000000fd',
    start: { ...pair.start, attempt_id: attempt },
    terminal: { ...pair.terminal, attempt_id: attempt },
  });

  const landedIn = await asOwner(async (client) => {
    const result = await client.query(
      "select distinct org_id::text as org_id from ledger_entry where output ->> 'attempt_id' = $1",
      [attempt],
    );
    return result.rows.map((row) => row.org_id);
  });
  assert.deepEqual(landedIn, [ORG_A], 'the rows did not land under the organisation of the claims');

  const afterB = await asTenant(ORG_B, async (client) => {
    const result = await client.query('select count(*)::int as n from ledger_entry');
    return result.rows[0].n;
  });
  assert.equal(afterB, beforeB, 'B’s chain grew while A was writing');

  // And B cannot see A's attempt at all, which is the policy doing its job rather than a predicate.
  const visibleToB = await asTenant(ORG_B, async (client) => {
    const result = await client.query(
      "select count(*)::int as n from ledger_entry where output ->> 'attempt_id' = $1",
      [attempt],
    );
    return result.rows[0].n;
  });
  assert.equal(visibleToB, 0);
});

test('the writer never registers a prompt version', async () => {
  // The temptation the map places at rung P4 and not before: registering a candidate generation to
  // give this row something to compare against. `ensurePromptLineage` takes the highest generation
  // whose schema hash matches the build, so a new one would silently become the prompt every agent
  // runs under — for the sake of one demonstration row.
  const before = await asOwner(async (client) => {
    const result = await client.query('select count(*)::int as n from prompt_version');
    return result.rows[0].n;
  });

  await filePromotionCapsule(store, store, input(ORG_B));

  const after = await asOwner(async (client) => {
    const result = await client.query('select count(*)::int as n from prompt_version');
    return result.rows[0].n;
  });
  assert.equal(after, before, 'the writer registered a prompt version');
});

test('the attempt of one organisation is not the attempt of another', async () => {
  assert.notEqual(attemptIdFor(ORG_A), attemptIdFor(ORG_B));
  assert.notEqual(capsuleRunIdFor(ORG_A), capsuleRunIdFor(ORG_B));

  const rows = await asOwner(async (client) => {
    const result = await client.query(
      `select org_id::text as org_id, output ->> 'attempt_id' as attempt_id
         from ledger_entry where class = 'promotion_attempt'
          and output ->> 'attempt_id' in ($1, $2)`,
      [attemptIdFor(ORG_A), attemptIdFor(ORG_B)],
    );
    return result.rows;
  });

  for (const row of rows) {
    const expected = row.attempt_id === attemptIdFor(ORG_A) ? ORG_A : ORG_B;
    assert.equal(row.org_id, expected, 'an attempt identity crossed organisations');
  }
});
