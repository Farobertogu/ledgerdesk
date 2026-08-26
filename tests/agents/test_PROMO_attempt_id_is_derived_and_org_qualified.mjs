// test_PROMO_attempt_id_is_derived_and_org_qualified
//
// The identity of an attempt, and the two ways of getting it wrong that both look fine.
//
// **Both unique indexes on an attempt are GLOBAL to the cluster** — partial indexes over
// `((output->>'attempt_id'))` with no `org_id` and no `run_id` in them
// (`migrations/0002_ledger.sql:247-250`). Two consequences, and both are measured here.
//
// A RANDOM identifier lets a second run of the operator mandate write a second complete attempt, and
// the panel then shows two attempts where one thing happened.
//
// A DERIVED identifier that is not qualified by organisation collides across tenants — and the
// collision is worse than it sounds, because SELECT is clipped by `ledger_tenant_select` while the
// index is not: a pre-read can truthfully report "no row" and the INSERT still die on a row of
// another organisation that this role can never see. With the organisation inside the seed, that
// collision needs a sha256 collision first.
//
// And the capsule's RUN is derived separately, because the run of the rehearsal is the value a
// careless implementation gets without asking for it: `runIdFor(org, 'demo')` is exactly the run the
// four seeded rows of the rehearsal bank live in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { derivedUuid } from '../../agents/canonical.ts';
import { attemptIdFor, capsuleRunIdFor } from '../../agents/ledger/promotion_row.ts';
import { ORG_A, ORG_B } from './promotion_fixture.mjs';

const WRITER = 'agents/ledger/promotion_row.ts';
const COMPOSITION_ROOT = 'src/server/agents.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the derivation lives in the canonical module and no longer in the composition root', () => {
  // The writer has to load under a bare `node --experimental-strip-types`, and the composition root
  // cannot be loaded that way at all — every import in it goes through an alias only the application
  // bundler resolves. Two copies of a function that mints identities would be two answers to "what is
  // this attempt called", so there is one and it lives where digests live.
  assert.equal(typeof derivedUuid, 'function');

  const root = readFileSync(COMPOSITION_ROOT, 'utf8');
  assert.doesNotMatch(
    root,
    /function derivedUuid/,
    `${COMPOSITION_ROOT} still declares derivedUuid; there must be exactly one implementation`,
  );
  assert.match(root, /derivedUuid/, `${COMPOSITION_ROOT} no longer names derivedUuid at all`);
});

test('an attempt identifier is a uuid, and is a function of the organisation', () => {
  const a = attemptIdFor(ORG_A);
  const b = attemptIdFor(ORG_B);

  assert.match(a, UUID);
  assert.match(b, UUID);
  assert.notEqual(a, b, 'two organisations were given one attempt identity');
  assert.equal(a, attemptIdFor(ORG_A), 'the same organisation was given two attempt identities');

  // Written out rather than imported, so the seed cannot change without this line changing.
  assert.equal(a, derivedUuid(`ledgerdesk:promotion-attempt:capsule:${ORG_A}`));
});

test('the capsule opens a run of its own, and it is not the rehearsal run', () => {
  const capsule = capsuleRunIdFor(ORG_A);
  assert.match(capsule, UUID);
  assert.equal(capsule, capsuleRunIdFor(ORG_A));
  assert.notEqual(capsule, capsuleRunIdFor(ORG_B));

  // The formula of the demonstration's run, transcribed from `runIdFor` in the composition root.
  const demo = derivedUuid(`ledgerdesk:run:demo:${ORG_A}`);
  assert.notEqual(
    capsule,
    demo,
    'the capsule would write into the run the first act replays',
  );

  assert.equal(capsule, derivedUuid(`ledgerdesk:run:promotion-capsule:${ORG_A}`));
});

test('the writer mints no fixed identifier and calls no random one', () => {
  const source = readFileSync(WRITER, 'utf8');

  assert.doesNotMatch(source, /randomUUID/, 'the writer reaches for a random identifier');
  assert.doesNotMatch(source, /Math\.random/, 'the writer reaches for a random identifier');

  // A literal uuid anywhere in the writer would be an identity nobody derived. The comments are
  // stripped first: the header cites row identifiers from the rehearsal bank as evidence, and citing
  // one is the opposite of minting one.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const literal = code.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.equal(literal, null, `the writer carries the literal identifier ${literal}`);
});
