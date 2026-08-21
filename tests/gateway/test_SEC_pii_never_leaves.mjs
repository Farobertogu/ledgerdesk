// test_SEC_pii_never_leaves
//
// The titled promise of this card, measured rather than asserted. A body carrying the four shapes
// that actually appear in a support ticket — an address, a phone number, a card, a person's name —
// goes into the chokepoint, and the test reads what came out the other side off the provider that
// was handed it. Not a copy the gateway made for the occasion: the exact object that crossed the
// boundary, captured by the spy and frozen.
//
// Three separate claims are made here, and they fail independently:
//
//   1. Nothing personal is in the payload, the canary planted in that same call is not in it
//      either, and the typed markers are — so the values were removed rather than merely absent.
//   2. The row the chain keeps carries the digest of the REDACTED input. A gateway that redacted
//      the payload but hashed the raw body would pass claim 1 and fail this one, and it would be a
//      gateway whose ledger cannot be reproduced without the raw body it promised never to keep.
//   3. The net under the redactor catches a value that reached the payload by a route the redactor
//      does not cover, and catches it before the provider is called. A control nobody has watched
//      fire is a claim.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { plant } from '../../agents/canary.ts';
import { digestOf } from '../../agents/canonical.ts';
import { createGateway } from '../../agents/gateway.ts';
import { stubProvider } from '../../agents/providers/stub.ts';
import { redact } from '../../agents/redaction.ts';
import {
  ORG_B,
  TICKET_A,
  asOwner,
  baseCall,
  baseConfig,
  makeStore,
  newRunId,
  readChain,
  refusedWith,
  registerPrompt,
  spyOn,
} from './harness.mjs';

const PROMPT_ID = '9f000000-0000-4000-8000-000000000901';
const GENERATION = 901;
const PROMPT_TEXT = 'Classify the request. Answer as JSON.';

// Forty-eight hex characters, pinned so the test can look for the exact token the gateway planted.
// In production it is minted from the system's own randomness and never leaves this process.
const CANARY = 'c0ffee'.repeat(8);

const NAME = 'Priya Raghavan';
const EMAIL = 'priya.raghavan@northwind-freight.com.au';
const PHONE = '0412 345 678';
const CARD = '4111 1111 1111 1111';
const BODY =
  `Hi, this is ${NAME}. My card ${CARD} was billed twice for invoice INV-10021. ` +
  `Please call me on ${PHONE} or write to ${EMAIL}.`;

const SECRETS = [NAME, EMAIL, PHONE, CARD, CANARY, 'canary.invalid'];

let store;

before(async () => {
  store = makeStore();
  await registerPrompt({ id: PROMPT_ID, generation: GENERATION, text: PROMPT_TEXT });
});

after(async () => {
  await store.close();
});

test('the payload that leaves carries no personal value and no canary', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: () => CANARY }),
  );

  const result = await gateway.call(
    baseCall({ prompt_version_id: PROMPT_ID, body: BODY, literals: [NAME] }),
  );

  assert.equal(spy.calls.length, 1, 'the provider was called once');
  const outbound = JSON.stringify(spy.calls[0]);

  for (const secret of SECRETS) {
    assert.ok(
      !outbound.includes(secret),
      `the payload carried a value it may not carry (${secret.slice(0, 12)}…)`,
    );
  }

  // Absent is not enough: the values must have been REMOVED, and a marker is what says so.
  for (const kind of ['literal', 'email', 'card', 'phone']) {
    assert.ok(
      outbound.includes(`[REDACTED:${kind}]`),
      `the payload carries no ${kind} marker, so that rule did not fire`,
    );
  }

  // The reference number is not personal and survives: over-redaction is bounded, not total.
  assert.ok(outbound.includes('INV-10021'), 'the redactor ate a value that is not personal');

  // The counts are reported per side. A single total would attribute to the customer whatever an
  // admitted knowledge-base document happened to contain, on a summary read by the person
  // answering them.
  assert.equal(result.redaction.body.email, 1);
  assert.equal(result.redaction.body.card, 1);
  assert.equal(result.redaction.body.phone, 1);
  assert.equal(result.redaction.body.literal, 1);
  assert.deepEqual(
    result.redaction.kb,
    { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 },
    'this call carried no excerpts, so nothing was removed from any',
  );

  for (const secret of SECRETS) {
    assert.ok(!result.body_redacted.includes(secret), 'the returned body still carries a value');
  }
});

test('the row persists the digest of the redacted input, not of the raw one', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: () => CANARY }),
  );

  const result = await gateway.call(
    baseCall({ prompt_version_id: PROMPT_ID, body: BODY, literals: [NAME] }),
  );

  // The envelope is written out here rather than imported, so that a change to the shape the
  // gateway hashes has to be made in two places by someone who noticed.
  const envelope = (body) => ({
    schema_version: '1.0',
    agent: 'triage',
    prompt_version_id: PROMPT_ID,
    ticket_id: TICKET_A,
    body_redacted: body,
    kb_context: [],
    locale: 'en-AU',
  });

  const [row] = await readChain(run_id);
  assert.equal(row.class, 'agent_call');
  assert.equal(
    row.input_hash,
    digestOf(envelope(result.body_redacted)),
    'input_hash is not the digest of the redacted input',
  );
  assert.notEqual(
    row.input_hash,
    digestOf(envelope(BODY)),
    'input_hash is the digest of the raw body, which is the failure this test exists for',
  );

  // The row is stored, read and audited. Nothing personal may be anywhere in it.
  const stored = JSON.stringify(row);
  for (const secret of SECRETS) {
    assert.ok(!stored.includes(secret), `the stored row carries a value it may not carry`);
  }
  assert.equal(row.output.canary, 'cleared');
  assert.deepEqual(row.output.redaction, {
    body: { literal: 1, email: 1, card: 1, account: 0, phone: 1, id: 0 },
    kb: { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 },
  });
});

test('a value reaching the payload outside the redacted body is caught before the call', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: () => CANARY }),
  );

  // The prompt is the system's own text and is not tenant material, so it is not redacted. Here it
  // names the customer — the mistake somebody makes once — and the value therefore reaches the
  // payload by a route the redactor never sees. The scan over what is about to leave is the thing
  // that has to catch it.
  await refusedWith('E_PII_EGRESS', () =>
    gateway.call(
      baseCall({
        prompt_version_id: PROMPT_ID,
        body: BODY,
        literals: [NAME],
        prompt_text: `Answer the enquiry from ${NAME} as JSON.`,
      }),
    ),
  );

  assert.equal(spy.calls.length, 0, 'the provider was called although the payload was refused');
  assert.equal((await readChain(run_id)).length, 0, 'a refused call wrote a row');
});

test('a body that is nothing but personal values is refused rather than sent empty', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: () => CANARY }),
  );

  await refusedWith('E_EMPTY_AFTER_REDACTION', () =>
    gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: `   ${EMAIL}   `, literals: [] })),
  );

  assert.equal(spy.calls.length, 0);
  assert.equal((await readChain(run_id)).length, 0);
});

test('each planted canary is removed by the rule of its own kind', () => {
  const planted = plant(CANARY);
  const pass = redact(planted.block, []);

  // The tail is the verdict the gateway uses. Asserting it here as well means a broken rule names
  // itself in this file rather than showing up as a mysterious refusal three tests away.
  assert.equal(pass.text, planted.expectedTail);

  for (const value of planted.values) {
    assert.ok(!pass.text.includes(value), `a canary survived the redactor: ${value.slice(0, 8)}…`);
  }

  // One marker per shaped rule in the dictionary. `literal` has no synthetic form and is excluded
  // by design; if that ever changes, this count is where it will be noticed.
  for (const kind of ['email', 'account', 'card', 'phone', 'id']) {
    assert.ok(pass.text.includes(`[REDACTED:${kind}]`), `no ${kind} canary was planted or removed`);
  }
});

test('a body with nothing personal in it still attests every rule', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: () => CANARY }),
  );

  // Nothing here matches any pattern. The call can only succeed if all five canaries were planted
  // and all five were removed — so a rule that had stopped firing would fail THIS test, on a body
  // that contains none of the values the rule is about.
  const result = await gateway.call(
    baseCall({ prompt_version_id: PROMPT_ID, body: 'The dashboard shows an outdated total.' }),
  );

  assert.equal(spy.calls.length, 1);
  // Every count is zero: the canaries were subtracted, so the summary describes the ticket and not
  // the instrumentation planted in it.
  assert.deepEqual(result.redaction, {
    body: { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 },
    kb: { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 },
  });
  assert.equal(result.body_redacted, 'The dashboard shows an outdated total.');
});

test('the tenant that did not make the call cannot read its row', async () => {
  const run_id = newRunId();
  const spy = spyOn(stubProvider());
  const gateway = createGateway(
    baseConfig({ store, provider: spy.provider, run_id, canary_token: () => CANARY }),
  );

  await gateway.call(baseCall({ prompt_version_id: PROMPT_ID, body: BODY, literals: [NAME] }));

  const visible = await asOwner(async (client) => {
    await client.query('begin');
    await client.query('set local role app_rw');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ org_id: ORG_B }),
    ]);
    const result = await client.query('select count(*)::int as n from ledger_entry where run_id = $1', [
      run_id,
    ]);
    await client.query('rollback');
    return result.rows[0].n;
  });

  assert.equal(visible, 0, 'the other organisation can read a row the gateway wrote for this one');
});
