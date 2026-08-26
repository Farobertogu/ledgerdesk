// test_PROMO_writes_its_own_run
//
// The capsule opens a run of its own, and the reason is that the run of the DEMONSTRATION is what a
// careless implementation gets without asking for it.
//
// `runIdFor(org, 'demo')` — measured against the rehearsal bank — is exactly the run the four seeded
// rows of the first act live in. A capsule that wrote there would put the attempt inside the chain
// the replay walks, would make this writer read and extend that chain, and would leave any failed
// attempt as a row in it that nothing can remove. And the screen would be suggesting that the two
// rows belong to the first act, which they do not.
//
// So: after the capsule has been filed, the demonstration's run holds exactly what it held before,
// the capsule's run holds two rows and nothing else, and its `start` opens the chain.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { derivedUuid } from '../../agents/canonical.ts';
import { appendSystemRow } from '../../agents/ledger/system_row.ts';
import {
  capsulePair,
  capsuleRunIdFor,
  filePromotionCapsule,
  promotionRulesetHash,
} from '../../agents/ledger/promotion_row.ts';
import { ORG_A, asOwner, makeStore, readChain } from './harness.mjs';

const store = makeStore();
test.after(async () => {
  await store.close();
});

/**
 * A third organisation, so that this file's capsule collides with neither sibling's.
 *
 * The two attempt indexes are global to the cluster and an attempt identifier is a function of its
 * organisation, so "one capsule per file" means "one organisation per file". Seeded here as the
 * owner, because it is a fixture of this file and not of the demonstration's seed.
 */
const ORG_C = '33333333-3333-4333-8333-333333333333';

const TS = '2026-08-26T11:00:00.000Z';

function input(orgId) {
  const ruleset_hash = promotionRulesetHash();
  return {
    claims: { org_id: orgId },
    incumbent_prompt_version_id: '7a1a9e00-0000-4000-8000-000000000002',
    code_sha: '0123456789abcdef0123456789abcdef01234567',
    ts: TS,
    state: { schema_version: '1.0', ruleset_hash, kb_snapshot: `${orgId}:none` },
    toolchain: { app: '0.1.0', ruleset: `contract@${ruleset_hash.slice(0, 12)}` },
  };
}

/** The formula the composition root derives a run from, transcribed so a change to it fails here. */
function demoRunFor(orgId) {
  return derivedUuid(`ledgerdesk:run:demo:${orgId}`);
}

test.before(async () => {
  await asOwner(async (client) => {
    await client.query(
      "insert into org (id, name, tier_default) values ($1, 'Capsule Fixture', 'standard') on conflict (id) do nothing",
      [ORG_C],
    );
  });
});

test('the capsule run is not the demonstration run, and the two seeds differ by construction', () => {
  const pair = capsulePair(input(ORG_C));
  assert.equal(pair.run_id, capsuleRunIdFor(ORG_C));
  assert.notEqual(
    pair.run_id,
    demoRunFor(ORG_C),
    'the capsule would write into the run the first act replays',
  );
  assert.notEqual(capsuleRunIdFor(ORG_A), demoRunFor(ORG_A));
});

test('filing the capsule leaves the demonstration run exactly as it was', async () => {
  const demo = demoRunFor(ORG_C);

  // Two rows standing in for the first act's chain: whatever is there before must be there after.
  await appendSystemRow(store, {
    run_id: demo,
    org_id: ORG_C,
    class: 'checkpoint',
    output: { seq_covered: 1, head_row_hash: 'a'.repeat(64), k: 50 },
    state: { schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: `${ORG_C}:none` },
    toolchain: { app: '0.1.0', ruleset: 'ruleset-1' },
    ts: TS,
  });

  const before = await readChain(demo);
  assert.equal(before.length, 1);

  await filePromotionCapsule(store, store, input(ORG_C));

  const after = await readChain(demo);
  assert.equal(after.length, before.length, 'the capsule wrote into the demonstration run');
  assert.deepEqual(
    after.map((row) => row.row_hash),
    before.map((row) => row.row_hash),
    'the demonstration chain moved',
  );
});

test('the capsule run holds exactly two rows, and the start opens it', async () => {
  const chain = await readChain(capsuleRunIdFor(ORG_C));

  assert.equal(chain.length, 2);
  assert.equal(chain[0].class, 'start');
  assert.equal(chain[0].prev_hash, 'GENESIS', 'the start does not open its own run');
  assert.equal(chain[0].seq, 1);
  assert.equal(chain[1].class, 'promotion_attempt');
  assert.equal(chain[1].seq, 2);

  // And nothing else in this organisation's ledger sits in that run.
  const strays = await asOwner(async (client) => {
    const result = await client.query(
      "select count(*)::int as n from ledger_entry where run_id = $1 and class not in ('start', 'promotion_attempt')",
      [capsuleRunIdFor(ORG_C)],
    );
    return result.rows[0].n;
  });
  assert.equal(strays, 0);
});
