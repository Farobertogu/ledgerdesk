// test_SEC_security_events_are_recorded
//
// A control that fires and leaves no trace has told one caller and nobody else. This file measures
// the other half: that when the chokepoint refuses something on security grounds, the refusal lands
// in `audit_event` — org-scoped, append-only, chained — and can be read back by the tenant it
// belongs to.
//
// Three things are asserted about every event, and they are three different claims:
//
//   1. **The caller still gets the real error.** The audit write is best effort by design. If it
//      ever masked the original `GatewayError`, a redaction failure would surface as a database
//      problem and the signal would be gone.
//   2. **The row is visible THROUGH THE POLICY**, not just to the owner. `audit_event` carries RLS,
//      and a row the tenant cannot read is a row that will not appear on the audit console the
//      tenant is the audience for. `asTenant` is how the question is asked.
//   3. **The chain links and the digest recomputes.** The trigger checks that `prev_hash` is the
//      organisation's head; it cannot check that `row_hash` is the right digest, for the same
//      reason the ledger's cannot. So it is recomputed here from the row read back.
//
// How the redactor is broken, since that deserves explaining. Nothing patches a module. The token
// the canary is built from is injectable — it exists so a test can pin it — and a token ending in a
// space produces `ld-canary-deadbeef @canary.invalid`, which the address rule cannot match, because
// it requires at least one address character immediately before the `@`. The canary then survives
// its own pass, which is precisely the condition the attestation exists to catch, reached without
// pretending the dictionary is something it is not.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { verifyAuditRowHash } from '../../agents/audit.ts';
import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import {
  MODEL,
  ORG_A,
  TICKET_A,
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readAuditChain,
  readChain,
  refusedWith,
  registerPrompt,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000907';
const GENERATION = 907;

/** A token that ends in a space, so the address it builds cannot match the address rule. */
const BROKEN_TOKEN = () => 'deadbeefdeadbeefdeadbeef ';

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION });
});

after(async () => {
  await store.close();
});

/** The audit rows this organisation has gained since `before`, in chain order. */
async function newAuditRows(before) {
  const all = await readAuditChain(ORG_A);
  return all.slice(before);
}

test('a canary that survives the redactor is refused typed AND filed, chained, under the policy', async () => {
  const existing = (await readAuditChain(ORG_A)).length;
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: BROKEN_TOKEN }),
  );

  const error = await refusedWith('E_CANARY_NOT_REDACTED', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: 'A perfectly ordinary enquiry.' })),
  );

  // 1 · the caller got the real failure, and it names the rule that stopped firing
  assert.deepEqual(error.detail.kinds, ['email']);
  assert.equal(spy.calls.length, 0, 'the provider was called although redaction had failed');
  assert.equal((await readChain(run_id)).length, 0, 'a refused call wrote a ledger row');

  // 2 · the event is visible to the tenant it belongs to
  const added = await newAuditRows(existing);
  assert.equal(added.length, 1, 'the security event was not filed, or was filed more than once');

  const [event] = added;
  assert.equal(event.action, 'E_CANARY_NOT_REDACTED');
  assert.equal(event.org_id, ORG_A);
  assert.equal(event.object_type, 'ticket');
  assert.equal(event.object_id, TICKET_A);
  // The writer is the system's path to the model, not a person, and the column says so.
  assert.equal(event.actor_id, null);
  assert.deepEqual(event.detail.kinds, ['email']);
  assert.equal(event.detail.run_id, run_id);
  assert.equal(event.detail.model_requested, MODEL);

  // 3 · the chain links and the digest recomputes
  const chain = await readAuditChain(ORG_A);
  let previous = 'GENESIS';
  for (const row of chain) {
    assert.equal(row.prev_hash, previous, 'an audit row does not attach to the head before it');
    assert.ok(verifyAuditRowHash(row), 'an audit row_hash is not the digest of its own content');
    previous = row.row_hash;
  }

  // And it covers what it should: a detail changed after the fact no longer verifies.
  assert.equal(
    verifyAuditRowHash({ ...event, detail: { ...event.detail, kinds: ['card'] } }),
    false,
    'the audit digest does not cover the detail of the event',
  );
});

test('a value caught on its way out is filed with its kind and no value', async () => {
  const existing = (await readAuditChain(ORG_A)).length;
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  const name = 'Priya Raghavan';
  await refusedWith('E_PII_EGRESS', () =>
    gateway.call(
      baseCall({
        prompt_version_id: PROMPT_ID,
        body: `This is ${name}, following up on the export failure.`,
        literals: [name],
        prompt_text: `Answer the enquiry from ${name} as JSON.`,
      }),
    ),
  );

  const [event] = await newAuditRows(existing);
  assert.equal(event.action, 'E_PII_EGRESS');
  assert.equal(event.detail.kind, 'literal');

  // The whole point of the detail contract: the row records that a literal was caught and never
  // what it was. A row quoting the value would put it in an append-only table by way of the
  // control that stopped it leaving.
  const stored = JSON.stringify(event);
  assert.ok(!stored.includes(name), 'the audit row carries the value it caught');
  assert.ok(!stored.includes('Raghavan'), 'the audit row carries part of the value it caught');
});

test('the ceiling is filed once when it cuts, not once per refusal', async () => {
  const existing = (await readAuditChain(ORG_A)).length;
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({
      store,
      provider: spy.provider,
      run_id,
      pricing: { [MODEL]: { input_aud_per_1k: 1, output_aud_per_1k: 1 } },
      budget: { cap_aud: 1, cut_aud: 0.000001, scope: 'run' },
    }),
  );

  // The cut is below the cost of any call, so the first one is already refused — and so are the
  // next two. An append-only table cannot be tidied up afterwards, so filing every refusal would
  // mean the same event repeated for as long as anybody kept calling.
  for (const attempt of [1, 2, 3]) {
    await refusedWith('E_BUDGET_EXHAUSTED', () =>
      gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: `Enquiry number ${attempt}.` })),
    );
  }

  const added = await newAuditRows(existing);
  assert.equal(added.length, 1, `the ceiling filed ${added.length} events for one cut`);
  assert.equal(added[0].action, 'E_BUDGET_EXHAUSTED');
  assert.equal(added[0].detail.scope, 'run');
  assert.equal(added[0].detail.cut_aud, '0.000001');
  assert.equal(spy.calls.length, 0);
});

test('a literal too short to be searched for is refused when it is supplied', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(baseConfig({ store, provider: spy.provider, run_id }));

  // Previously this was filtered out in silence: the caller believed the value was covered and the
  // redactor had dropped it from consideration. A fail-open in a privacy control is worse than a
  // refusal, so it is now a refusal that names the length without naming the value.
  const error = await refusedWith('E_CONFIG_INVALID', () =>
    gateway.call(
      baseCall({ prompt_version_id: PROMPT_ID, body: 'Chan asked about the invoice.', literals: ['Chan'] }),
    ),
  );

  assert.equal(error.detail.literal_length, 4);
  assert.equal(error.detail.minimum, 8);
  assert.ok(!JSON.stringify(error.detail).includes('Chan'), 'the error quotes the literal');
  assert.equal(spy.calls.length, 0);

  // A full name, which is what the tenant's records actually hold, is accepted and removed.
  const ok = await gateway.call(
    baseCall({
      prompt_version_id: PROMPT_ID,
      body: 'Mei-Ling Chan asked about the invoice.',
      literals: ['Mei-Ling Chan'],
    }),
  );
  assert.equal(ok.redaction.literal, 1);
  assert.ok(!ok.body_redacted.includes('Mei-Ling Chan'));
});

test('a failing audit sink does not mask the error the caller actually hit', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({
      store,
      provider: spy.provider,
      run_id,
      canary_token: BROKEN_TOKEN,
      audit: {
        record: async () => {
          throw new Error('the audit table is unavailable');
        },
      },
    }),
  );

  // The security failure comes out, not the infrastructure one. Trading the first for the second
  // would lose the only signal that mattered.
  const error = await refusedWith('E_CANARY_NOT_REDACTED', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: 'An ordinary enquiry.' })),
  );
  assert.deepEqual(error.detail.kinds, ['email']);
  assert.equal(spy.calls.length, 0);
});
