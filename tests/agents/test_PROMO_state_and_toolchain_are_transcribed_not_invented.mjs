// test_PROMO_state_and_toolchain_are_transcribed_not_invented
//
// Every row of this system pins the state it was written under, and the rule that keeps that pin
// honest is CONTRACT-13's: *"a field with two producers is a field that can disagree with itself"*.
//
// The chokepoint and the admission writer satisfy it by sharing one composed object held on the
// runtime. The capsule cannot reach that object — nothing outside a Next build can load the
// composition root, because every import in it goes through an alias only `tsconfig.app.json`
// resolves — and it does not need to: the capsule opens a run of its OWN, so it shares no field with
// any other row and the rule is satisfied by having exactly one producer, which is the operator
// mandate.
//
// What that costs is that two components are transcribed rather than imported, and what pays for it
// is this file: the transcription is compared against the text of the file that owns it, exactly as
// `RESULT_CHANNEL_MAX_BYTES` is compared by `ci/seam_check.mjs:241-250`. The third component is not
// transcribed at all — it is READ from the database.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { digestOf } from '../../agents/canonical.ts';
import { stateHash } from '../../agents/ledger/row.ts';
import {
  PROMOTION_ATTEMPT_PAYLOAD_CONTRACT,
  promotionRulesetHash,
} from '../../agents/ledger/promotion_row.ts';
import { ORG_A } from './promotion_fixture.mjs';

const WRITER = 'agents/ledger/promotion_row.ts';
const MANDATE = 'seed/promotion_capsule.mjs';
const COMPOSITION_ROOT = 'src/server/agents.ts';

test('the schema component is transcribed from the composition root, and the two agree', () => {
  const root = readFileSync(COMPOSITION_ROOT, 'utf8');
  const published = root.match(/export const STATE_SCHEMA_VERSION = '([^']+)'/);
  assert.ok(published, `${COMPOSITION_ROOT} no longer publishes STATE_SCHEMA_VERSION`);

  const mandate = readFileSync(MANDATE, 'utf8');
  const transcribed = mandate.match(/^const STATE_SCHEMA_VERSION = '([^']+)';$/m);
  assert.ok(transcribed, `${MANDATE} does not transcribe STATE_SCHEMA_VERSION`);

  assert.equal(
    transcribed[1],
    published[1],
    `the mandate writes '${transcribed[1]}' where the composition root publishes '${published[1]}'`,
  );
});

test('the snapshot component keeps the shape the composition root publishes', () => {
  const root = readFileSync(COMPOSITION_ROOT, 'utf8');
  // `kbSnapshotComponent(orgId, label)` returns `${orgId}:${label}`. The organisation is in FRONT of
  // the label, so that a row identifies the corpus it cited and not merely a date two tenants share.
  assert.match(
    root,
    /export function kbSnapshotComponent\([\s\S]{0,120}?return `\$\{orgId\}:\$\{label\}`/,
    'kbSnapshotComponent no longer composes the organisation in front of the label',
  );

  const mandate = readFileSync(MANDATE, 'utf8');
  assert.match(
    mandate,
    /kb_snapshot: `\$\{orgId\}:\$\{snapshot\}`/,
    'the mandate composes the snapshot component in a different shape',
  );
  // And the sentinel for an organisation with no head at all is a value, not an empty string.
  assert.match(mandate, /const NO_SNAPSHOT = 'none';/);
});

test('the ruleset component is the digest of the contract that decided the row', () => {
  // Recomputable by an auditor from the repository, and it moves the day the contract moves — which
  // is the whole reason it is this digest and not a copy of the application's ruleset hash.
  assert.equal(promotionRulesetHash(), digestOf(PROMOTION_ATTEMPT_PAYLOAD_CONTRACT));
  assert.match(promotionRulesetHash(), /^[a-f0-9]{64}$/);

  const mandate = readFileSync(MANDATE, 'utf8');
  assert.match(mandate, /const ruleset_hash = promotionRulesetHash\(\);/);
  assert.match(
    mandate,
    /ruleset: `contract@\$\{ruleset_hash\.slice\(0, 12\)\}`/,
    'the toolchain does not name the contract it was decided under',
  );
});

test('state_hash is the digest of the three components and of nothing else', () => {
  const state = {
    schema_version: '1.0',
    ruleset_hash: promotionRulesetHash(),
    kb_snapshot: `${ORG_A}:kb-2026-08-01`,
  };
  assert.equal(
    stateHash(state),
    digestOf({
      schema_version: state.schema_version,
      ruleset_hash: state.ruleset_hash,
      kb_snapshot: state.kb_snapshot,
    }),
  );
});

test('the writer composes neither state nor toolchain: it receives both', () => {
  const source = readFileSync(WRITER, 'utf8');

  // It must never build the three-part object itself. One producer, and it is the mandate.
  assert.doesNotMatch(
    source,
    /schema_version:\s*['`]/,
    'the writer composes a schema_version of its own',
  );
  assert.doesNotMatch(source, /kb_snapshot:\s*[`'"]/, 'the writer composes a kb_snapshot of its own');
  assert.doesNotMatch(source, /app:\s*['`]/, 'the writer composes a toolchain of its own');

  // What it does instead: takes them whole and digests them.
  assert.match(source, /state:\s*\{\s*schema_version: string; ruleset_hash: string; kb_snapshot: string\s*\}/);
  assert.match(source, /stateHash\(pair\.state\)/);
  assert.match(source, /toolchain: pair\.toolchain/);
});
