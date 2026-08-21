// test_GW_state_hash_tracks_the_snapshot_in_force
//
// The twin of `test_GW_state_hash_differs_across_rulesets`, pointed at the component that had no
// writer when that one was written.
//
// `state_hash` covers three things: the schema version, the ruleset digest, and the knowledge-base
// snapshot. Two of the three moved before this increment. The third was the constant `'kb:none'` —
// described in the composition root as "the knowledge base does not exist yet" while the seed had
// been inserting articles under `kb-2026-08-01` since the data spine landed. Every row the triage
// agent wrote recorded a state meaning *there is no corpus*, for organisations that had one.
//
// Now that the snapshot is read from the database, it is a condition that moves, and the consequence
// is the one the column exists for: **the same ticket, the same words, the same model and the same
// answer, against a different corpus, is a different question.** A cache that ignored it would hand
// an answer produced under last month's knowledge base to a call made under this month's, and record
// it as though this month's had produced it — the one column whose whole purpose is to keep those
// apart, defeated by the lookup that runs before it is written.
//
// The qualification by organisation is measured here too. Two tenants share the label
// `kb-2026-08-01` and hold entirely different corpora under it; an unqualified component would give
// their rows the same state, which is the column saying that two incomparable things are comparable.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import { stateHash } from '../../agents/ledger/row.ts';
import {
  ORG_A,
  ORG_B,
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readChain,
  registerPrompt,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000910';
const GENERATION = 910;

const BODY = 'Which plan covers a second export destination for the warehouse team?';

/** The way the composition root qualifies the component. Transcribed, not imported: see below. */
const qualified = (orgId, label) => `${orgId}:${label}`;

const BEFORE = qualified(ORG_A, 'kb-2026-08-01');
const AFTER = qualified(ORG_A, 'kb-2026-08-22');

const store = makeStore();

before(async () => {
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION, text: 'Classify the request.' });
});

after(async () => {
  await store.close();
});

test('the same call under two snapshots is two rows and two keys', async () => {
  const run_id = newRunId();

  const first = spyOn(stubProvider());
  const before = createGateway(
    baseConfig({
      store,
      provider: first.provider,
      run_id,
      state: { schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: BEFORE },
    }),
  );

  await before.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));
  assert.equal(first.calls.length, 1);

  // The same call again, under the same snapshot: the chain answers, nothing is spent. That is the
  // premise the next assertion rests on — without it, a miss below would prove nothing.
  const repeated = await before.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));
  assert.equal(first.calls.length, 1, 'a call under an unchanged state reached the provider');
  assert.equal(repeated.cached, true);

  // And now under the snapshot that follows an admission. Same body, same prompt, same model, same
  // sampling, same seed — everything a cache key holds except the corpus.
  const second = spyOn(stubProvider());
  const after = createGateway(
    baseConfig({
      store,
      provider: second.provider,
      run_id,
      state: { schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: AFTER },
    }),
  );

  const fresh = await after.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY }));
  assert.equal(second.calls.length, 1, 'the corpus moved and the chain answered from the old one');
  assert.equal(fresh.cached, false);

  const chain = await readChain(run_id);
  assert.equal(chain.length, 3);
  assert.equal(chain[0].state_hash, chain[1].state_hash, 'two rows under one snapshot disagree');
  assert.notEqual(chain[2].state_hash, chain[0].state_hash, 'the row does not record which corpus it read');
  assert.equal(chain[2].state_hash, stateHash({ schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: AFTER }));

  // The two chained runs of the closing act are exactly this shape: ONE chain, two state values,
  // ordered by seq, with the admission row between them. A second run would be two chains, and
  // nothing orders two chains relative to each other.
  assert.equal(new Set(chain.map((row) => row.run_id)).size, 1, 'the corpus moving opened a second run');
  assert.deepEqual(
    chain.map((row) => row.seq),
    [1, 2, 3],
  );
});

test('two organisations sharing a label do not share a state', () => {
  // Transcribed rather than imported, deliberately: `src/server/agents.ts` reaches the database
  // through path aliases this runner does not resolve, and a test that imported the function it is
  // checking would be asking the composition root whether it agrees with itself. What is asserted
  // is the property — the label alone is not enough — and the composition root's own use of it is
  // measured through the rows it writes, in the application suite.
  const sameLabel = 'kb-2026-08-01';

  const a = stateHash({ schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: qualified(ORG_A, sameLabel) });
  const b = stateHash({ schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: qualified(ORG_B, sameLabel) });
  assert.notEqual(a, b, 'two tenants holding different corpora under one label carry one state');

  const unqualified = stateHash({ schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: sameLabel });
  assert.notEqual(a, unqualified, 'the qualification is not in the digest');

  // And the sentinel is a value of its own, not something a real snapshot can collide with.
  const none = stateHash({ schema_version: '1.0', ruleset_hash: 'r'.repeat(64), kb_snapshot: qualified(ORG_A, 'kb:none') });
  assert.notEqual(a, none);
});
