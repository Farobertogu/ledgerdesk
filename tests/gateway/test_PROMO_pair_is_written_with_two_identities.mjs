// test_PROMO_pair_is_written_with_two_identities
//
// The capsule against a live schema, which is where the claims of the contract stop being claims.
//
// **Two identities, and they are written rather than discovered.** `ledger_agent_identity` demands
// `agent = 'evolve'` for a `promotion_attempt` and `agent = 'system'` for the other six non-model
// classes, `start` among them. So the pair is signed by two writers: the `start` by
// `appendSystemRow`, which already owns that class and hardwires `system`, and the terminal by the
// promotion writer, which hardwires `evolve`. Neither is a parameter, and a database is the only
// thing that can prove it.
//
// **The five cost sentinels are mechanical**, and `restarts` is the trap among them: a writer that
// copied the chokepoint's shape would pass `runtime.restarts`, which in a restarted process is not
// zero, and `ledger_nonmodel_costs_zero` would refuse the row. The other five nulls are choices with
// reasons — `prompt_version_id` is a real foreign key and the evolution agent has no registered row;
// `ticket_id` would drop the terminal into a customer's evidence panel through `ledger_ticket_idx`.
//
// And the link: the terminal's `prev_hash` is the start's `row_hash`, both rows re-hash to what they
// say they do, and the instant the mandate produced is the `ts` of the start row AND its
// `started_at`, byte for byte.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyRowHash } from '../../agents/ledger/row.ts';
import {
  attemptIdFor,
  capsuleRunIdFor,
  filePromotionCapsule,
  promotionRulesetHash,
} from '../../agents/ledger/promotion_row.ts';
import { ORG_A, asOwner, makeStore, readChain } from './harness.mjs';

const store = makeStore();
test.after(async () => {
  await store.close();
});

const TS = '2026-08-26T09:00:00.000Z';
const INCUMBENT = '7a1a9e00-0000-4000-8000-000000000002';

function input(orgId) {
  const ruleset_hash = promotionRulesetHash();
  return {
    claims: { org_id: orgId },
    incumbent_prompt_version_id: INCUMBENT,
    code_sha: '0123456789abcdef0123456789abcdef01234567',
    ts: TS,
    state: {
      schema_version: '1.0',
      ruleset_hash,
      kb_snapshot: `${orgId}:kb-2026-08-01`,
    },
    toolchain: { app: '0.1.0', ruleset: `contract@${ruleset_hash.slice(0, 12)}` },
  };
}

test('the pair lands, signed by two identities, with every cost sentinel where the schema demands it', async () => {
  const filed = await filePromotionCapsule(store, store, input(ORG_A));

  assert.equal(filed.action, 'filed');
  assert.equal(filed.attempt_id, attemptIdFor(ORG_A));
  assert.equal(filed.run_id, capsuleRunIdFor(ORG_A));

  const chain = await readChain(capsuleRunIdFor(ORG_A));
  assert.equal(chain.length, 2, 'the capsule did not write exactly two rows');

  const [start, terminal] = chain;
  assert.equal(start.class, 'start');
  assert.equal(terminal.class, 'promotion_attempt');

  // The two identities the constraint demands.
  assert.equal(start.agent, 'system');
  assert.equal(terminal.agent, 'evolve');

  for (const row of chain) {
    // Five forced by `ledger_nonmodel_costs_zero`. `restarts` is the one a careless writer breaks.
    assert.equal(row.tokens_in, 0);
    assert.equal(row.tokens_out, 0);
    assert.equal(row.cost_aud, '0.000000');
    assert.equal(row.latency_ms, 0);
    assert.equal(row.restarts, 0);
    // A row that spends nothing advances nothing.
    assert.equal(row.cum_tokens, 0);
    // Five chosen, each with its reason in the writer's header.
    assert.equal(row.prompt_version_id, null, 'the column names a prompt version');
    assert.equal(row.ticket_id, null, 'the row would enter a ticket evidence panel');
    assert.equal(row.split_id, null);
    assert.equal(row.confidence, null);
    assert.equal(row.model_requested, null);
  }
});

test('the instant is one instant, and the chain links', async () => {
  const chain = await readChain(capsuleRunIdFor(ORG_A));
  const [start, terminal] = chain;

  assert.equal(start.ts, TS, 'the start row does not carry the instant the mandate produced');
  assert.equal(start.output.started_at, TS, 'started_at and ts are two different instants');
  assert.equal(terminal.ts, TS);

  assert.equal(start.prev_hash, 'GENESIS', 'the capsule did not open its run');
  assert.equal(terminal.prev_hash, start.row_hash, 'the terminal does not attach to its start');
  assert.equal(terminal.seq, start.seq + 1);

  // Verified with the SAME implementation that wrote them, which is what makes it a check rather
  // than a second opinion.
  for (const row of chain) {
    assert.ok(verifyRowHash(row), `seq ${row.seq} does not hash to what it says it does`);
  }
});

test('the payloads are the signed ones, as the database holds them', async () => {
  const [start, terminal] = await readChain(capsuleRunIdFor(ORG_A));

  assert.equal(start.output.attempt_id, attemptIdFor(ORG_A));
  assert.equal(start.output.budget_reserved, 0);
  assert.match(start.output.code_sha, /^[0-9a-f]{40}$/);

  assert.equal(terminal.output.attempt_id, start.output.attempt_id);
  assert.equal(terminal.output.outcome, 'REJECTED');
  assert.equal(terminal.output.failing_conjunct, 'precondition_underpowered');
  assert.equal(terminal.output.interpretation, 'UNDERPOWERED');
  assert.equal(terminal.output.candidate_prompt_version_id, INCUMBENT);
  assert.equal(terminal.output.incumbent_prompt_version_id, INCUMBENT);

  // The SET, not the sequence — and the difference is a fact about the column rather than a
  // looser assertion. `output` is `jsonb`, which normalises key order by length and then bytewise:
  // these four come back as delta_positive, battery_in_force_green, query_index_within_cmax,
  // paired_significant_at_alpha, whatever order the writer built them in. The published order is
  // enforced by the writer on the payload it is handed and re-established by the panel at render.
  assert.deepEqual(Object.keys(terminal.output.conjuncts).sort(), [
    'battery_in_force_green',
    'delta_positive',
    'paired_significant_at_alpha',
    'query_index_within_cmax',
  ]);
  assert.notDeepEqual(
    Object.keys(terminal.output.conjuncts),
    ['paired_significant_at_alpha', 'delta_positive', 'battery_in_force_green', 'query_index_within_cmax'],
    'jsonb preserved the authored key order, and the reasoning above has to be revisited',
  );
  for (const conjunct of Object.values(terminal.output.conjuncts)) {
    assert.equal(conjunct.verdict, 'UNEVALUABLE');
    assert.notEqual(conjunct.reason.trim(), '');
  }

  // The six keys of the supersession survive a round trip through `jsonb`, nulls included.
  assert.deepEqual(Object.keys(terminal.output.power).sort(), [
    'ci_high',
    'ci_low',
    'ci_unit',
    'delta',
    'mde_n',
    'mdi',
  ]);
  assert.equal(terminal.output.power.ci_unit, 'clan');
  for (const key of ['delta', 'ci_low', 'ci_high', 'mde_n', 'mdi']) {
    assert.equal(terminal.output.power[key], null, `power.${key} arrived carrying a figure`);
  }
});

test('this attempt has exactly one start and exactly one terminal, in the whole cluster', async () => {
  // Asked of the OWNER and without an organisation predicate, because that is the scope the two
  // unique indexes actually have: they are partial indexes over `output->>'attempt_id'` with no
  // `org_id` and no `run_id` in them. Anything else would be measuring a narrower claim than the
  // one the schema makes.
  const counted = await asOwner(async (client) => {
    const result = await client.query(
      `select class::text as class, count(*)::int as n
         from ledger_entry
        where output ->> 'attempt_id' = $1 and class in ('start', 'promotion_attempt')
        group by class order by class`,
      [attemptIdFor(ORG_A)],
    );
    return Object.fromEntries(result.rows.map((row) => [row.class, row.n]));
  });

  assert.deepEqual(counted, { promotion_attempt: 1, start: 1 });
});
