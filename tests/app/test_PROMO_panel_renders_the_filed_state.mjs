// test_PROMO_panel_renders_the_filed_state
//
// The promotion screen, over a real row, through HTTP, under a real session.
//
// Two organisations file a capsule each, because the assertion that matters most on this page is not
// that it renders — it is that it renders ONE tenant's attempt. The read runs as `app_rw` under the
// claims of the session, so `ledger_tenant_select` is what decides which rows come back. The role
// that would break it is `quality_ro`, whose select policy on `ledger_entry` is `using (true)` and
// which therefore sees the chain of every organisation in the cluster: a screen that reached for it
// would put every tenant's rows in front of an examiner, live, in the beat whose whole argument is
// discipline. Filing for both organisations is what turns that from an argument into a measurement.
//
// The rest is the beat: the four names, the four verdicts with their reasons, the named failing
// conjunct, the terminal, the interpretation, the reconciliation with its scope sentence, and the two
// dated deliverables. Plus the guard, because a console that shows the gate to whoever asks is a
// console with no guard.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { PgLedgerStore } from '../../agents/ledger/pg.ts';
import {
  attemptIdFor,
  capsuleRunIdFor,
  filePromotionCapsule,
  promotionRulesetHash,
} from '../../agents/ledger/promotion_row.ts';
import { asOwner, identities, request, sessionFor, waitForServer } from './harness.mjs';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

let store;
let people;

before(async () => {
  await waitForServer();
  people = await identities();

  store = new PgLedgerStore({ connectionString: process.env.DATABASE_URL });

  // Filed the way the operator mandate files it: one instant, a resolved incumbent, a state composed
  // once. Not through a route, because there is no route — `ledger_writer_insert` reads only
  // `org_id`, so an open route would let any session whose organisation claim matched file one.
  const ruleset_hash = promotionRulesetHash();
  for (const orgId of [ORG_A, ORG_B]) {
    await filePromotionCapsule(store, store, {
      claims: { org_id: orgId },
      incumbent_prompt_version_id: '7a1a9e00-0000-4000-8000-000000000002',
      code_sha: '0123456789abcdef0123456789abcdef01234567',
      ts: '2026-08-26T09:00:00.000Z',
      state: { schema_version: '1.0', ruleset_hash, kb_snapshot: `${orgId}:kb-2026-08-01` },
      toolchain: { app: '0.1.0', ruleset: `contract@${ruleset_hash.slice(0, 12)}` },
    });
  }
});

after(async () => {
  if (store) await store.close();
});

async function page(cookie) {
  const response = await request(cookie, '/promotion');
  assert.equal(response.status, 200);
  return response.body.raw ?? '';
}

test('the supervisor sees the four conjuncts, their verdicts and their reasons', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));

  for (const name of [
    'paired_significant_at_alpha',
    'delta_positive',
    'battery_in_force_green',
    'query_index_within_cmax',
  ]) {
    assert.ok(html.includes(name), `the panel does not name ${name}`);
  }

  // Four verdicts, and the alphabet is the published one.
  const verdicts = html.match(/UNEVALUABLE/g) ?? [];
  assert.ok(verdicts.length >= 4, `only ${verdicts.length} verdicts were rendered`);

  for (const reason of [
    'no scored run has been recorded, so the paired test has nothing to run on',
    'no candidate generation has been proposed; the attempt names the incumbent on both sides',
    'the negative battery has not been built, so no round and date can be in force',
    'no report split has been sealed, so the query index has nothing to be counted against',
  ]) {
    assert.ok(html.includes(reason), `the panel does not carry the reason '${reason.slice(0, 40)}…'`);
  }
});

test('the terminal, the interpretation and the named failing conjunct are on screen', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));

  assert.ok(html.includes('REJECTED'), 'the outcome is not on screen');
  assert.ok(html.includes('UNDERPOWERED'), 'the interpretation is not on screen');
  assert.ok(html.includes('precondition_underpowered'), 'the failing conjunct is not named');

  // The sentence that separates "we measured and came up short" from "nothing was measured".
  assert.ok(
    html.includes('could not be evaluated here because neither quantity is derived'),
    'the fail-closed sentence is not rendered',
  );

  // And nothing that would read as a measurement where nothing was measured.
  assert.ok(html.includes('not derived'), 'the undrawn figures are not marked');
  assert.ok(!html.includes('does not improve'), 'the panel makes a claim it may not make');
  assert.ok(!html.includes('no improvement'), 'the panel makes a claim it may not make');
});

test('the reconciliation line carries its two counts, its verdict and its scope', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));

  assert.ok(html.includes('starts == terminals'), 'the reconciliation panel is missing');
  assert.ok(html.includes('reconciled'), 'the reconciliation verdict is missing');
  assert.ok(
    html.includes(
      'Counted over exactly the rows this session may see, so the total is a tenant total and not a system total',
    ),
    'the scope of the count is not stated',
  );
});

test('the two pending deliverables are named with their published dates', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));

  assert.ok(html.includes('D-9'), 'D-9 is not named');
  assert.ok(html.includes('14 Sep 2026'), 'the date of D-9 is not on screen');
  assert.ok(html.includes('D-11'), 'D-11 is not named');
  assert.ok(html.includes('4 Oct 2026'), 'the date of D-11 is not on screen');
});

test('the chain coordinates say the attempt opens a run of its own, and carries no ticket', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));

  assert.ok(html.includes(attemptIdFor(ORG_A)), 'the attempt is not identified');
  assert.ok(html.includes(capsuleRunIdFor(ORG_A).slice(0, 8)), 'the run is not identified');
  assert.ok(html.includes('null on both rows'), 'the absence of a ticket is not stated');
  assert.ok(html.includes('opens a run of its own'), 'the run is not explained');
  assert.ok(html.includes('read-only'), 'the absence of controls is not declared');
});

test('the panel shows this tenant’s attempt and not the other tenant’s', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));

  assert.ok(html.includes(attemptIdFor(ORG_A)));
  assert.ok(
    !html.includes(attemptIdFor(ORG_B)),
    'a supervisor of one organisation was shown another organisation’s attempt',
  );
  assert.ok(
    !html.includes(capsuleRunIdFor(ORG_B).slice(0, 8)),
    'a supervisor of one organisation was shown another organisation’s run',
  );

  // Two attempts exist in the cluster; the tenant total on screen is one, and it says so.
  const total = await asOwner(async (client) => {
    const result = await client.query(
      "select count(*)::int as n from ledger_entry where class = 'promotion_attempt'",
    );
    return result.rows[0].n;
  });
  assert.equal(total, 2, 'the fixture did not file two attempts');
  assert.ok(html.includes('1</span> start'), 'the count on screen is not the tenant total');
});

test('a session that is not a supervisor is refused, and one with no session is asked for one', async () => {
  const agent = await page(await sessionFor(people.northwindAgent.user_id));
  assert.ok(
    agent.includes('This console belongs to the supervisor role'),
    'the agent was shown the gate',
  );
  assert.ok(!agent.includes('precondition_underpowered'), 'the agent was shown the row');

  const customer = await page(await sessionFor(people.northwindCustomer.user_id));
  assert.ok(customer.includes('This console belongs to the supervisor role'));
  assert.ok(!customer.includes('precondition_underpowered'));

  const anonymous = await page(null);
  assert.ok(anonymous.includes('No session is selected'), 'a request with no session was served');
  assert.ok(!anonymous.includes('precondition_underpowered'));
});

test('the navigation carries an entry for the gate, named for what it shows', async () => {
  const html = await page(await sessionFor(people.northwindSupervisor.user_id));
  assert.ok(html.includes('Promotion gate'), 'the console has no entry in the navigation');
  assert.ok(
    !html.includes('Model Quality (lite)'),
    'the entry claims a surface that is paid for in a later phase',
  );
});
