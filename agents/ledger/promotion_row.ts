/**
 * The writer of a promotion attempt: the `promotion_attempt` terminal and the `start` row that opens
 * it, filed as a pair, fail-closed.
 *
 * ## Why this is a sibling of `system_row.ts` and not a widening of it
 *
 * `ledger_agent_identity` requires `agent = 'evolve'` for `promotion_attempt` and
 * `modification_event`, and `agent = 'system'` for the other six non-model classes
 * (`migrations/0002_ledger.sql:212-215`). `appendSystemRow` hardwires `agent: 'system'` and its header
 * says out loud why it declines these two classes: *"a row this writer could construct and the
 * database would refuse is worse than a class this writer declines to write"*. Widening that type
 * would produce exactly what its author declared unacceptable, so nothing there is touched. `agent`
 * is not a parameter here either — it is hardwired to `'evolve'`, because a caller that could sign an
 * attempt as `'system'` would be a caller whose row dies in a check constraint eight frames away.
 *
 * **The pair is therefore signed by two identities, and that is written rather than discovered.** The
 * `start` row is one of the six classes `appendSystemRow` already owns, so it is written by that
 * writer, with `agent = 'system'`, exactly as the constraint requires. The terminal is written here,
 * with `agent = 'evolve'`.
 *
 * ## Fail-closed means: what the database does not close, this file closes
 *
 * The trigger checks that the eight keys of a `promotion_attempt` are present and not JSON null, and
 * that `failing_conjunct` is null only under `PROMOTED` (`migrations/0002_ledger.sql:152-172`). It
 * checks nothing about their VALUES. Measured against a live database, all of these are writable
 * today: `outcome:"MAYBE"`, `conjuncts:{}`, `failing_conjunct:"banana"`, `interpretation:"GOOD"`, a
 * `PROMOTED` row whose `delta_positive` says `"FAIL"`, and a `REJECTED` row naming a conjunct that
 * says `"PASS"`. `ci/sql/test_LEDGER_promotion_alphabet_is_not_in_the_schema.sql` measures that
 * residual instead of assuming it, and each case there names the rule below that closes it.
 *
 * So the four alphabets are closed here, the row is checked against itself here, and every refusal
 * names the offending key. The refusals come out of the code and never out of PostgreSQL: the
 * trigger's own rejection arrives as `E_LEDGER_ROW_INCOMPLETE` from inside a transaction, naming
 * nothing about which key was wrong.
 *
 * **The error register is closed** (`agents/errors.ts:8-9`), so this file adds no code to it and
 * reuses `E_CONFIG_INVALID` with a `detail` that names the key and the alphabet — the same thing the
 * sibling writer does at `agents/ledger/system_row.ts:108, 115, 124`.
 *
 * ## The pair is validated whole before the first row is written, and it resumes
 *
 * Both payloads are built and checked in full before `store.append` is called once. The two rows are
 * still two transactions — `PgLedgerStore` opens one per `append` and the four operations of
 * `LedgerStore` are published with the reason there are exactly four (`agents/ledger/store.ts:4`), so
 * atomicity would mean widening that interface and re-arguing its header.
 *
 * **Declared residual: the pair is not atomic at the level of the database.** A crash between the two
 * rows leaves a dangling `start`, and `ledger_immutable()` makes it undeletable
 * (`migrations/0002_ledger.sql:74-83`). What makes that tolerable is bought rather than hoped for:
 * the attempt's identity is DERIVED, so re-running the mandate is a resume and not a second attempt —
 * a complete pair is returned untouched, a half pair is completed by writing only the terminal. That
 * is strictly stronger than atomicity here, because it also covers the case atomicity does not: a
 * commit the operator never saw. And because both payloads are validated before the first write, the
 * only way the terminal can fail after the `start` landed is infrastructure or contention, and both
 * are answered by running the mandate again. The panel paints a dangling start in red and names it,
 * so the intermediate state is visible and repairable, never silent.
 *
 * **A second declared residual, on the error the operator would see.** `isChainConflict` in
 * `agents/ledger/pg.ts:198-202` treats every `23505` as contention, and the `note` on
 * `E_LEDGER_WRITE_FAILED` (`agents/ledger/pg.ts:344`) names two causes, neither of which is a
 * collision on the attempt's own unique index. That is not repaired here — the retry path is shared
 * with the chokepoint, which has twelve tests over it — and the mitigation is the re-read below: on a
 * failed append the writer looks again, and if the pair is standing it returns it instead of any
 * message. Discriminating by `error.constraint` is I13's work.
 *
 * ## The published class schema is DEFERRED, and the deferral is load-bearing
 *
 * The trigger's own comment points a reader at `quality/schemas/ledger_class/<class>.schema.json`
 * (`migrations/0011_error_codes_in_english.sql:184-185`, and that comment travels into the committed
 * dump at `ci/expected/schema.sql:471`), and `02_SPEC.md:1806` names the test that would consume it,
 * `test_LEDGER_class_payload_matches_schema`. Neither the files nor that test exists.
 *
 * **DEFERRED: `quality/schemas/ledger_class/promotion_attempt.schema.json` and `start.schema.json`
 * are not written by this card.** `quality/schemas/` is a frozen path (`FROZEN_PATHS:6`) and paying it
 * costs an accepted, dated ADR in the same pull request plus a row-validation test in the `db` job,
 * which is a card's worth of work and is not in this card's closing evidence. The payer is I13.
 *
 * What IS built is the half that makes paying it cheap and makes the deferral checkable: the two
 * contracts are exported as DATA below, and `contractAsJsonSchemaText` serialises one into the file
 * that would be committed. `ci/check.sh` runs
 * `test_PROMO_published_payload_schema_is_current_or_declared_absent`: if the file exists it must be
 * byte-identical to that serialisation, and if it does not, this header must carry the deferral line
 * above. A hand-edited file and a stale one fail identically, on the day somebody pays it.
 */

import { canonicalJson, derivedUuid, digestOf } from '../canonical.ts';
import type { Json } from '../canonical.ts';
import { GatewayError } from '../errors.ts';
import { stateHash } from './row.ts';
import type { LedgerRowContent } from './row.ts';
import type { AppendedRow, LedgerStore } from './store.ts';
import { appendSystemRow, CLASS_REQUIRED_KEYS } from './system_row.ts';

/* ------------------------------------------------------------------------------------------------
 * 1 · The keys, and the four closed alphabets
 * ---------------------------------------------------------------------------------------------- */

/**
 * The eight keys a `promotion_attempt` owns, transcribed from `migrations/0002_ledger.sql:138-140`.
 *
 * The order is the migration's order, which is also the order of the published payload block at
 * `02_SPEC.md:1257-1270`.
 */
export const PROMOTION_ATTEMPT_REQUIRED_KEYS = [
  'attempt_id',
  'candidate_prompt_version_id',
  'incumbent_prompt_version_id',
  'conjuncts',
  'failing_conjunct',
  'power',
  'outcome',
  'interpretation',
] as const;

/**
 * The four keys a `start` owns.
 *
 * NOT transcribed a second time: it is the sibling writer's own table, which is transcribed from the
 * same migration and pinned by `test_LEDGER_system_row_is_not_a_model_call`. Two transcriptions of
 * one list is a list that can disagree with itself.
 */
export const START_REQUIRED_KEYS: readonly string[] = CLASS_REQUIRED_KEYS.start;

/**
 * The four conjuncts of the gate, in the order the specification publishes them
 * (`02_SPEC.md:1261-1264`). The order is part of the contract: an examiner reading the specification
 * has to find the same four names in the same sequence on the screen.
 */
export const CONJUNCT_NAMES = [
  'paired_significant_at_alpha',
  'delta_positive',
  'battery_in_force_green',
  'query_index_within_cmax',
] as const;

/** What a conjunct may say. `02_SPEC.md:1261`: *"each: PASS | FAIL | UNEVALUABLE, with its reason"*. */
export const CONJUNCT_VERDICTS = ['PASS', 'FAIL', 'UNEVALUABLE'] as const;

/**
 * What `failing_conjunct` may name, closed by `02_SPEC.md:1835`, ∪ `{null}` — and null only under
 * `PROMOTED`, which is the one nullity rule the trigger itself enforces.
 */
export const FAILING_CONJUNCTS = [
  ...CONJUNCT_NAMES,
  'precondition_underpowered',
  'aborted_before_evaluation',
] as const;

/** The three terminals of an attempt (ADR-013, `02_SPEC.md:1268`). */
export const OUTCOMES = ['PROMOTED', 'REJECTED', 'ABORTED'] as const;

/**
 * The interpretation alphabet (`02_SPEC.md:1150`, `:1269`). It is closed and it has no value meaning
 * "not evaluated" — which is why an attempt that could evaluate nothing is obliged to say
 * `UNDERPOWERED`, and why the panel carries a sentence separating that from "we measured and came up
 * short of power".
 */
export const INTERPRETATIONS = ['UNDERPOWERED', 'INFORMATIVE-NULL', 'POWERED-CONCLUSIVE'] as const;

/**
 * The six keys of `power`, after the supersession dated 2026-08-21 (`02_SPEC.md:1840`).
 *
 * The superseded form was `{ delta, ci, mde_n, mdi }`; a scalar interval can carry neither its two
 * endpoints nor its unit, and the `no_IC_sin_unidad` lint demands the unit beside every interval
 * (`02_SPEC.md:1118`). The CI fixture already writes the new form
 * (`ci/sql/test_LEDGER_class_payload.sql:196`), and that half is copied here deliberately.
 */
export const POWER_KEYS = ['delta', 'ci_low', 'ci_high', 'ci_unit', 'mde_n', 'mdi'] as const;

/** The unit an interval is measured in. A declared convention, never a measured quantity. */
export const CI_UNITS = ['clan', 'item'] as const;

/**
 * The five members of `power` that are QUANTITIES. Each is either a finite number, when a scored run
 * is named, or JSON null. There is no third state and in particular there is no zero: a `delta` of 0
 * reads as a measured null and an `mde_n` of 0 reads as infinite power, which is exactly the claim
 * `02_SPEC.md:1140` forbids under UNDERPOWERED.
 */
export const POWER_QUANTITIES = ['delta', 'ci_low', 'ci_high', 'mde_n', 'mdi'] as const;

/** The longest reason a conjunct may carry, in UTF-8 bytes. Above it the row is refused, never cut. */
export const CONJUNCT_REASON_MAX_BYTES = 240;

export type ConjunctName = (typeof CONJUNCT_NAMES)[number];
export type ConjunctVerdict = (typeof CONJUNCT_VERDICTS)[number];
export type FailingConjunct = (typeof FAILING_CONJUNCTS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type Interpretation = (typeof INTERPRETATIONS)[number];

/**
 * What a `PASS` has to be accompanied by, per conjunct.
 *
 * A verdict of PASS is a claim that something was checked, so the writer refuses one that names no
 * evidence. In the state of this card none of the four references exists — there is no sealed split,
 * no candidate generation, no battery in force — so no conjunct can legitimately be PASS and this
 * writer is structurally incapable of writing one.
 *
 * **Declared residual:** the reference is required and its SHAPE is checked; it is not resolved
 * against `eval_split` or `prompt_version`. Resolution is I13's, and in this card there is nothing to
 * resolve. It travels beside the payload rather than inside it because the payload's shape is
 * published (`02_SPEC.md:1257-1270`) and a conjunct there is `{ verdict, reason }` — adding a third
 * key would be this card editing a published shape.
 */
export const CONJUNCT_EVIDENCE_KIND: Readonly<Record<ConjunctName, 'split' | 'prompt_version' | 'battery'>> = {
  paired_significant_at_alpha: 'split',
  delta_positive: 'prompt_version',
  battery_in_force_green: 'battery',
  query_index_within_cmax: 'split',
};

export type ConjunctEvidence =
  | { kind: 'split'; split_id: string }
  | { kind: 'prompt_version'; prompt_version_id: string }
  | { kind: 'battery'; round: string; date: string };

/* ------------------------------------------------------------------------------------------------
 * 2 · The identity of an attempt: derived, qualified by organisation, idempotent
 * ---------------------------------------------------------------------------------------------- */

/**
 * The identity of the capsule attempt for one organisation. Never a fixed constant, never random.
 *
 * **Both unique indexes on an attempt are GLOBAL to the cluster** — measured, not read:
 * `ledger_start_unique_per_attempt` and `ledger_terminal_unique_per_attempt` are partial indexes over
 * `((output->>'attempt_id'))` with no `org_id` and no `run_id` in them
 * (`migrations/0002_ledger.sql:247-250`). Two consequences follow and both are load-bearing.
 *
 * A RANDOM identifier would let a second run of the mandate write a second complete attempt, and the
 * panel would then show two attempts where one thing happened — a visible lie on stage.
 *
 * A derived identifier that was NOT qualified by organisation would collide across tenants, and the
 * collision is worse than it sounds: SELECT is clipped by `ledger_tenant_select` while the unique
 * index is not, so a pre-read could truthfully report "no row" and the INSERT still die on a row of
 * ANOTHER organisation that this role can never see. With the organisation inside the seed that
 * collision is impossible by construction. It is the same reasoning that puts the organisation in
 * front of the label in `kbSnapshotComponent`.
 */
export function attemptIdFor(orgId: string): string {
  return derivedUuid(`ledgerdesk:promotion-attempt:capsule:${orgId}`);
}

/**
 * The run the capsule opens, which is its own and is never the rehearsal's.
 *
 * `runIdFor(org, 'demo')` is the run the demonstration writes into, and it is what a careless
 * implementation gets without meaning to. Writing there would put the attempt inside the chain the
 * replay walks, would make this writer read and extend that chain, and would leave any failed attempt
 * as an unrepairable row in it. The two rows of an attempt are not part of Act 1 and the screen must
 * not suggest that they are.
 */
export function capsuleRunIdFor(orgId: string): string {
  return derivedUuid(`ledgerdesk:run:promotion-capsule:${orgId}`);
}

/* ------------------------------------------------------------------------------------------------
 * 3 · The combination this card produces, and no other
 * ---------------------------------------------------------------------------------------------- */

/**
 * The decision the owner signs for `candidate_prompt_version_id` when no candidate exists.
 *
 * **The finding.** The key is required and the trigger refuses JSON null in it —
 * `failing_conjunct` is the single exempt key (`migrations/0002_ledger.sql:152-159`). So the state
 * "there is no candidate" is not expressible in the published payload, and the problem is truth
 * rather than typing: the signed reason of the second conjunct is "no candidate", so any value that
 * named a candidate would put the row at odds with itself.
 *
 * **Active form (R3).** The attempt names the incumbent on both sides and SAYS SO in the reason. The
 * degradation is declared inside the row rather than hidden behind it: zero migration, zero ADR, and
 * the row stops contradicting itself because it states what it did.
 *
 * The identifier and the reason come out of THIS ONE CONSTANT, so they cannot disagree — there are
 * not two places to write them. The coherence rule below refuses a row where the reason declares an
 * absent candidate and the two identifiers differ, and refuses one where they are equal and the
 * reason does not declare it.
 *
 * **The alternative the owner may sign instead (R2), written out and inert.** A migration `0012`
 * doing `create or replace` of `ledger_link()` to admit null in this key under
 * `failing_conjunct = 'precondition_underpowered'`. It is the only route that buys literal truth, and
 * it costs an accepted, dated ADR in the same pull request, a regenerated `ci/expected/schema.sql`
 * through the published route, and a widened trigger for every future row:
 *
 *   const NO_CANDIDATE_PROPOSED = {
 *     reason: 'no candidate generation has been proposed, so this key names nothing',
 *     marker: 'no candidate generation has been proposed',
 *     candidateFrom: () => null,
 *   };
 *
 * Nothing else in this file changes between the two. Which one is in force is recorded in the body of
 * the pull request.
 */
export const NO_CANDIDATE_PROPOSED = {
  /** The reason the second conjunct carries. It is also where the marker below comes from. */
  reason:
    'no candidate generation has been proposed; the attempt names the incumbent on both sides',
  /** The substring the coherence rule matches. A slice of `reason`, never a second string. */
  marker: 'no candidate generation has been proposed',
  /** What the candidate identifier is when nobody has proposed one: the incumbent, said out loud. */
  candidateFrom: (incumbentPromptVersionId: string): string => incumbentPromptVersionId,
} as const;

export type Conjunct = { verdict: ConjunctVerdict; reason: string };

/**
 * The four pairs this card files, fixed.
 *
 * Cross-checked against three independent sources: the ladder's rung P1 prints the four reasons in
 * conjunct order (`MAPA_BEAT_PLANB_2026-08-26.md:30`), its rung P2 crosses them by declaring C1 and
 * C4 evaluable once sealed splits and a first scored run land, and `BOARD.md:20` and ADR-023 sign the
 * terminal.
 */
export const CAPSULE_CONJUNCTS: Readonly<Record<ConjunctName, Conjunct>> = {
  paired_significant_at_alpha: {
    verdict: 'UNEVALUABLE',
    reason: 'no scored run has been recorded, so the paired test has nothing to run on',
  },
  delta_positive: {
    verdict: 'UNEVALUABLE',
    reason: NO_CANDIDATE_PROPOSED.reason,
  },
  battery_in_force_green: {
    verdict: 'UNEVALUABLE',
    reason: 'the negative battery has not been built, so no round and date can be in force',
  },
  query_index_within_cmax: {
    verdict: 'UNEVALUABLE',
    reason: 'no report split has been sealed, so the query index has nothing to be counted against',
  },
};

/** The terminal this card files. Not a choice: see the header of each field. */
export const CAPSULE_FAILING_CONJUNCT: FailingConjunct = 'precondition_underpowered';
export const CAPSULE_OUTCOME: Outcome = 'REJECTED';
export const CAPSULE_INTERPRETATION: Interpretation = 'UNDERPOWERED';

/**
 * The unit the interval would be measured in. A declared convention (`02_SPEC.md:1118` requires a
 * unit beside every interval; §15.3-bis makes the clan the unit), so it is nameable even where the
 * two endpoints are not derived.
 */
export const CAPSULE_CI_UNIT = 'clan';

/**
 * `power` in the state of this card: six keys present, five of them JSON null.
 *
 * `MDI` is *"a pinned convention declared in advance, not a derivation, and it is a pre-registration
 * field"* (`02_SPEC.md:1144`); its document is `PREREGISTRATION.md`, which is the deliverable of card
 * I25 and is not a dependency of this one. `mde_n` is not computable without a sealed report split,
 * and there is none. `[OPEN-7]` is still open (`02_SPEC.md:989`, `:1066`).
 */
export const CAPSULE_POWER: Readonly<Record<string, Json>> = {
  delta: null,
  ci_low: null,
  ci_high: null,
  ci_unit: CAPSULE_CI_UNIT,
  mde_n: null,
  mdi: null,
};

/* ------------------------------------------------------------------------------------------------
 * 4 · The two contracts, exported as data
 * ---------------------------------------------------------------------------------------------- */

export type PayloadContract = {
  ledger_class: string;
  title: string;
  required_keys: readonly string[];
  /** The keys that may carry JSON null, each with the state that authorises it. */
  nullable_keys: readonly { key: string; only_when: string }[];
  /** Every closed alphabet the class carries, by the field it governs. */
  alphabets: Readonly<Record<string, readonly string[]>>;
  /** Every declared cap, by the field it bounds, in UTF-8 bytes. */
  caps: Readonly<Record<string, number>>;
};

export const PROMOTION_ATTEMPT_PAYLOAD_CONTRACT: PayloadContract = {
  ledger_class: 'promotion_attempt',
  title: 'The terminal of a promotion attempt: promoted, rejected or aborted',
  required_keys: PROMOTION_ATTEMPT_REQUIRED_KEYS,
  nullable_keys: [{ key: 'failing_conjunct', only_when: "outcome = 'PROMOTED'" }],
  alphabets: {
    conjuncts: CONJUNCT_NAMES,
    'conjuncts.*.verdict': CONJUNCT_VERDICTS,
    failing_conjunct: FAILING_CONJUNCTS,
    outcome: OUTCOMES,
    interpretation: INTERPRETATIONS,
    power: POWER_KEYS,
    'power.ci_unit': CI_UNITS,
  },
  caps: { 'conjuncts.*.reason': CONJUNCT_REASON_MAX_BYTES },
};

export const START_PAYLOAD_CONTRACT: PayloadContract = {
  ledger_class: 'start',
  title: 'The opening of a promotion attempt, written before its first generation',
  required_keys: START_REQUIRED_KEYS,
  nullable_keys: [],
  alphabets: {},
  caps: {},
};

/** Where the published class schema would live if it were written. See the header for why it is not. */
export const LEDGER_CLASS_SCHEMA_DIR = 'quality/schemas/ledger_class';

export function schemaPathFor(contract: PayloadContract): string {
  return `${LEDGER_CLASS_SCHEMA_DIR}/${contract.ledger_class}.schema.json`;
}

/** The line the header must carry for as long as the schema files are not written. */
export const PAYLOAD_SCHEMA_DEFERRAL =
  'DEFERRED: `quality/schemas/ledger_class/promotion_attempt.schema.json` and `start.schema.json`';

/**
 * The contract, serialised as the JSON Schema document that would be committed.
 *
 * Two decimals of care, both for the same reason: whatever this emits has to be reproducible by
 * anybody holding the repository. The key order is the declaration's, and the text ends in a newline,
 * because a file that differs from its generator by a trailing byte fails a byte-comparison for a
 * reason nobody can see.
 */
export function contractAsJsonSchemaText(contract: PayloadContract): string {
  const properties: Record<string, Json> = {};
  for (const key of contract.required_keys) {
    const nullable = contract.nullable_keys.find((entry) => entry.key === key);
    const property: Record<string, Json> = {};
    if (contract.alphabets[key]) property.enum = [...contract.alphabets[key]];
    if (nullable) property.description = `null only when ${nullable.only_when}`;
    properties[key] = property;
  }

  const document: Record<string, Json> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `ledgerdesk/${contract.ledger_class}.schema.json`,
    title: contract.title,
    type: 'object',
    required: [...contract.required_keys],
    properties,
    'x-alphabets': Object.fromEntries(
      Object.entries(contract.alphabets).map(([field, members]) => [field, [...members]]),
    ),
    'x-caps-utf8-bytes': { ...contract.caps },
  };

  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The digest of the rules that decided a row.
 *
 * It is what the capsule's `state.ruleset_hash` carries, and the choice is deliberate: the rules that
 * decided this row ARE the contract above, so an auditor can recompute the digest from the repository
 * and it moves on the day the contract moves.
 */
export function promotionRulesetHash(): string {
  return digestOf(PROMOTION_ATTEMPT_PAYLOAD_CONTRACT as unknown as Json);
}

/* ------------------------------------------------------------------------------------------------
 * 5 · The writer's input, and the ports it needs
 * ---------------------------------------------------------------------------------------------- */

/** The claims a statement runs under. `org_id` and nothing else, exactly as the store's are. */
export type LedgerClaims = { org_id: string };

/** A row of an attempt, as far as the session that asked may see it. */
export type FiledRow = {
  run_id: string;
  seq: number;
  prev_hash: string;
  row_hash: string;
  ts: string;
};

export type FiledAttempt = { start: FiledRow | null; terminal: FiledRow | null };

/**
 * The one thing the writer needs that `LedgerStore` does not offer: has this attempt already been
 * filed?
 *
 * It is a NEW narrow port declared here, not a fifth operation on `LedgerStore`. That interface
 * publishes four operations with the reason there are exactly four
 * (`agents/ledger/store.ts:4-19`), and it is the surface the chokepoint depends on; a promotion
 * lookup has no business in it. Declared here, the only consumer of the port is the only caller that
 * needs it.
 */
export interface PromotionLedgerReader {
  findAttempt(orgId: string, attemptId: string): Promise<FiledAttempt>;
}

/**
 * The payloads and the row-level facts of one attempt.
 *
 * **The names that are NOT here are the point.** There is no `agent`, no `org_id`, no `restarts`, no
 * `tokens_in`, no `tokens_out`, no `cost_aud` and no `latency_ms`. The five costs are forced to zero
 * by `ledger_nonmodel_costs_zero` and a parameter whose only legal value is the one already written
 * would be a parameter that can only ever inflate the consumption figure the ceiling recomputes from
 * the chain. `agent` is fixed because the identity constraint fixes it. And the organisation arrives
 * inside `claims`, because the writer runs under a session and derives what it writes from the
 * session it runs under — it does not take an organisation from its caller.
 */
export type PromotionPair = {
  claims: LedgerClaims;
  run_id: string;
  /** The `start` payload, whole. */
  start: Readonly<Record<string, Json>>;
  /** The `promotion_attempt` payload, whole. */
  terminal: Readonly<Record<string, Json>>;
  /**
   * The scored run whose numbers `power` may carry, or null. With null, the five quantities of
   * `power` must be JSON null; with a run named, they must be finite numbers.
   */
  scored_run: string | null;
  /** Evidence for every conjunct whose verdict is `PASS`. Empty when none can be. */
  evidence: Readonly<Partial<Record<ConjunctName, ConjunctEvidence>>>;
  state: { schema_version: string; ruleset_hash: string; kb_snapshot: string };
  toolchain: Json;
  /** ISO 8601, UTC, millisecond precision. One instant for the pair; see `filePromotionCapsule`. */
  ts: string;
};

/** The keys of the writer's input, exported so that a test can assert what is NOT among them. */
export const PROMOTION_PAIR_KEYS = [
  'claims',
  'run_id',
  'start',
  'terminal',
  'scored_run',
  'evidence',
  'state',
  'toolchain',
  'ts',
] as const;

export type FiledPair = {
  attempt_id: string;
  run_id: string;
  start: AppendedRow | FiledRow;
  terminal: AppendedRow | FiledRow;
  /** What the writer actually did: filed both, completed a half pair, or found it already standing. */
  action: 'filed' | 'resumed' | 'already_filed';
};

/* ------------------------------------------------------------------------------------------------
 * 6 · The refusals
 * ---------------------------------------------------------------------------------------------- */

function refuse(message: string, detail: Record<string, unknown>): never {
  throw new GatewayError('E_CONFIG_INVALID', message, detail);
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

const HEX40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireObject(value: Json | undefined, key: string, where: string): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    refuse(`${where}: ${key} must be a JSON object`, { key, where });
  }
  return value as Record<string, Json>;
}

/** Present, not JSON null, and — where the contract says NAMED — a non-empty string after trim. */
function requireNamedString(
  payload: Record<string, Json>,
  key: string,
  where: string,
): string {
  const value = payload[key];
  if (value === undefined || value === null) {
    refuse(`${where}: ${key} must be named, and a key carrying null names nothing`, {
      key,
      where,
      missing_key: key,
    });
  }
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`${where}: ${key} must be a non-empty string`, { key, where });
  }
  return value;
}

function requireMember(
  payload: Record<string, Json>,
  key: string,
  alphabet: readonly string[],
  where: string,
): string {
  const value = payload[key];
  if (value === undefined || value === null) {
    refuse(`${where}: ${key} must be named, and a key carrying null names nothing`, {
      key,
      where,
      missing_key: key,
      alphabet: [...alphabet],
    });
  }
  if (typeof value !== 'string' || !alphabet.includes(value)) {
    refuse(`${where}: ${key} is outside its closed alphabet`, {
      key,
      where,
      alphabet: [...alphabet],
    });
  }
  return value;
}

/**
 * The `start` payload, checked before anything is written.
 *
 * `code_sha` is checked for shape and not merely for presence: the trigger accepts any non-null
 * string — the empty one included, measured — and a sha of a dirty tree or the word "unknown" pins a
 * tree nobody can check, which is the one thing the reproducibility block exists to prevent
 * (`migrations/0002_ledger.sql:267-292`).
 */
export function validateStartPayload(payload: Record<string, Json>, ts: string): void {
  const where = 'start';
  for (const key of START_REQUIRED_KEYS) {
    if (payload[key] === undefined || payload[key] === null) {
      refuse(`${where}: ${key} must be named, and a key carrying null names nothing`, {
        key,
        where,
        missing_key: key,
      });
    }
  }

  const attemptId = requireNamedString(payload, 'attempt_id', where);
  if (!UUID.test(attemptId)) {
    refuse(`${where}: attempt_id must be a uuid`, { key: 'attempt_id', where });
  }

  const startedAt = requireNamedString(payload, 'started_at', where);
  if (startedAt !== ts) {
    refuse(`${where}: started_at must be the instant the row carries`, {
      key: 'started_at',
      where,
      ts,
    });
  }

  const codeSha = requireNamedString(payload, 'code_sha', where);
  if (!HEX40.test(codeSha)) {
    refuse(`${where}: code_sha must be forty hexadecimal characters`, { key: 'code_sha', where });
  }

  const reserved = payload.budget_reserved;
  if (typeof reserved !== 'number' || !Number.isFinite(reserved) || reserved < 0) {
    refuse(`${where}: budget_reserved must be a number that is not negative`, {
      key: 'budget_reserved',
      where,
    });
  }
}

/**
 * The `promotion_attempt` payload, checked before anything is written: the eight keys, the four
 * alphabets, the six keys of `power`, and the row against itself.
 */
export function validatePromotionAttemptPayload(
  payload: Record<string, Json>,
  options: {
    scored_run: string | null;
    evidence: Readonly<Partial<Record<ConjunctName, ConjunctEvidence>>>;
  },
): void {
  const where = 'promotion_attempt';

  // 1 · presence. `failing_conjunct` is the single key that may carry JSON null, and even that one
  //     only in the state the trigger authorises.
  for (const key of PROMOTION_ATTEMPT_REQUIRED_KEYS) {
    if (payload[key] === undefined) {
      refuse(`${where}: ${key} must be named`, { key, where, missing_key: key });
    }
    if (payload[key] === null && key !== 'failing_conjunct') {
      refuse(`${where}: ${key} must be named, and a key carrying null names nothing`, {
        key,
        where,
        missing_key: key,
      });
    }
  }

  // 2 · the identities.
  const attemptId = requireNamedString(payload, 'attempt_id', where);
  if (!UUID.test(attemptId)) {
    refuse(`${where}: attempt_id must be a uuid`, { key: 'attempt_id', where });
  }
  const candidate = requireNamedString(payload, 'candidate_prompt_version_id', where);
  const incumbent = requireNamedString(payload, 'incumbent_prompt_version_id', where);

  // 3 · the conjuncts: exactly the four published names, in the published order, each an object.
  //
  //     The order is checked HERE and nowhere downstream, and the reason is worth writing down. The
  //     column is `jsonb`, which normalises key order by length and then bytewise — measured: the
  //     four names come back as delta_positive, battery_in_force_green, query_index_within_cmax,
  //     paired_significant_at_alpha, whatever order they went in as. The canonical serialisation the
  //     digest is taken over sorts keys as well (`agents/canonical.ts:44`). So the published order is
  //     a property of the payload a caller AUTHORS, and this is the last place it exists; the panel
  //     re-establishes it at render by mapping over the published array.
  const conjuncts = requireObject(payload.conjuncts, 'conjuncts', where);
  const present = Object.keys(conjuncts);
  if (
    present.length !== CONJUNCT_NAMES.length ||
    present.some((name, index) => name !== CONJUNCT_NAMES[index])
  ) {
    refuse(`${where}: conjuncts must carry exactly the four published names, in order`, {
      key: 'conjuncts',
      where,
      alphabet: [...CONJUNCT_NAMES],
      found: present,
    });
  }

  for (const name of CONJUNCT_NAMES) {
    const entry = requireObject(conjuncts[name], `conjuncts.${name}`, where);
    const verdict = requireMember(entry, 'verdict', CONJUNCT_VERDICTS, `${where}.conjuncts.${name}`);

    // Every verdict other than PASS carries its reason. A FAIL or an UNEVALUABLE with nothing said
    // beside it is the state the checklist exists to make legible, rendered illegible.
    if (verdict !== 'PASS') {
      const reason = entry.reason;
      if (typeof reason !== 'string' || reason.trim() === '') {
        refuse(`${where}: conjuncts.${name} is ${verdict} and carries no reason`, {
          key: `conjuncts.${name}.reason`,
          where,
          verdict,
        });
      }
      const bytes = utf8Bytes(reason);
      if (bytes > CONJUNCT_REASON_MAX_BYTES) {
        // Refused, never trimmed: a shortened reason is a sentence its author did not write.
        refuse(`${where}: conjuncts.${name} carries a reason above the declared cap`, {
          key: `conjuncts.${name}.reason`,
          where,
          bytes,
          cap: CONJUNCT_REASON_MAX_BYTES,
        });
      }
    }

    // 3b · no PASS without named evidence. §15.3-bis closes "unevaluable ⇒ NO-PROMOTE"; this is the
    //      symmetric half it leaves open.
    if (verdict === 'PASS') {
      const evidence = options.evidence[name];
      const expected = CONJUNCT_EVIDENCE_KIND[name];
      if (!evidence || evidence.kind !== expected) {
        refuse(`${where}: conjuncts.${name} is PASS and names no ${expected} evidence`, {
          key: `conjuncts.${name}`,
          where,
          evidence_kind: expected,
        });
      }
    }
  }

  // 4 · `power`: the six keys, the unit from its alphabet, and no invented number.
  const power = requireObject(payload.power, 'power', where);
  const powerKeys = Object.keys(power);
  if (
    powerKeys.length !== POWER_KEYS.length ||
    POWER_KEYS.some((key) => !powerKeys.includes(key))
  ) {
    refuse(`${where}: power must carry exactly the six keys of the 2026-08-21 supersession`, {
      key: 'power',
      where,
      alphabet: [...POWER_KEYS],
      found: powerKeys,
    });
  }
  requireMember(power, 'ci_unit', CI_UNITS, `${where}.power`);
  for (const key of POWER_QUANTITIES) {
    const value = power[key];
    if (options.scored_run === null) {
      if (value !== null) {
        refuse(
          `${where}: power.${key} carries a value while no scored run is named`,
          { key: `power.${key}`, where },
        );
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      refuse(`${where}: power.${key} must be a finite number under a named scored run`, {
        key: `power.${key}`,
        where,
        scored_run: options.scored_run,
      });
    }
  }

  // 5 · the three closed alphabets of the terminal itself.
  const outcome = requireMember(payload, 'outcome', OUTCOMES, where);
  const interpretation = requireMember(payload, 'interpretation', INTERPRETATIONS, where);

  const failing = payload.failing_conjunct;
  if (failing !== null) {
    requireMember(payload, 'failing_conjunct', FAILING_CONJUNCTS, where);
  }

  // 6 · the row against itself.
  const verdictOf = (name: ConjunctName): string =>
    (requireObject(conjuncts[name], `conjuncts.${name}`, where).verdict as string);
  const allPass = CONJUNCT_NAMES.every((name) => verdictOf(name) === 'PASS');
  const allUnevaluable = CONJUNCT_NAMES.every((name) => verdictOf(name) === 'UNEVALUABLE');

  // (a) a promotion with a conjunct that did not pass is the exact thing the fail-closed rule of
  //     ADR-012 exists to close, and the database accepts it today — measured.
  if (outcome === 'PROMOTED' && !allPass) {
    refuse(`${where}: outcome is PROMOTED while a conjunct did not pass`, {
      key: 'outcome',
      where,
    });
  }
  if (failing === null && outcome !== 'PROMOTED') {
    refuse(`${where}: failing_conjunct is null and the outcome is not PROMOTED`, {
      key: 'failing_conjunct',
      where,
    });
  }
  if (failing !== null && outcome === 'PROMOTED') {
    refuse(`${where}: outcome is PROMOTED and a failing conjunct is still named`, {
      key: 'failing_conjunct',
      where,
    });
  }

  // (b) naming a conjunct that passed puts on the screen, as the one that failed, a conjunct that
  //     approved.
  if (typeof failing === 'string' && (CONJUNCT_NAMES as readonly string[]).includes(failing)) {
    if (verdictOf(failing as ConjunctName) === 'PASS') {
      refuse(`${where}: failing_conjunct names a conjunct whose verdict is PASS`, {
        key: 'failing_conjunct',
        where,
        conjunct: failing,
      });
    }
  }

  // (c) `precondition_underpowered` is the state of `02_SPEC.md:1150`, and that state has exactly one
  //     interpretation because the alphabet has no value meaning "not evaluated".
  if (failing === 'precondition_underpowered' && interpretation !== 'UNDERPOWERED') {
    refuse(`${where}: precondition_underpowered with an interpretation other than UNDERPOWERED`, {
      key: 'interpretation',
      where,
    });
  }

  // (d) an abort names its own conjunct and carries its reason; the trigger requires the reason and
  //     this requires the pairing.
  if (failing === 'aborted_before_evaluation') {
    if (outcome !== 'ABORTED') {
      refuse(`${where}: aborted_before_evaluation with an outcome other than ABORTED`, {
        key: 'outcome',
        where,
      });
    }
    if (payload.abort_reason === undefined || payload.abort_reason === null) {
      refuse(`${where}: an aborted attempt must name its abort_reason`, {
        key: 'abort_reason',
        where,
        missing_key: 'abort_reason',
      });
    }
  }
  if (outcome === 'ABORTED' && (payload.abort_reason === undefined || payload.abort_reason === null)) {
    refuse(`${where}: an aborted attempt must name its abort_reason`, {
      key: 'abort_reason',
      where,
      missing_key: 'abort_reason',
    });
  }

  // (e) four unevaluable conjuncts leave exactly two things a failure can be called.
  if (allUnevaluable && failing !== 'precondition_underpowered' && failing !== 'aborted_before_evaluation') {
    refuse(
      `${where}: every conjunct is UNEVALUABLE, so failing_conjunct can only be precondition_underpowered or aborted_before_evaluation`,
      { key: 'failing_conjunct', where },
    );
  }

  // (f) the candidate and the incumbent, and the reason that has to agree with them. One constant
  //     produces both, so this can only fire on a caller that wrote them separately.
  const c2 = requireObject(conjuncts.delta_positive, 'conjuncts.delta_positive', where);
  const declaresNoCandidate =
    typeof c2.reason === 'string' && c2.reason.includes(NO_CANDIDATE_PROPOSED.marker);

  if (candidate === incumbent) {
    if (c2.verdict !== 'UNEVALUABLE' || !declaresNoCandidate) {
      refuse(
        `${where}: candidate_prompt_version_id equals incumbent_prompt_version_id without delta_positive declaring that no candidate exists`,
        { key: 'candidate_prompt_version_id', where },
      );
    }
  } else if (declaresNoCandidate) {
    refuse(
      `${where}: delta_positive declares that no candidate exists while the two identifiers differ`,
      { key: 'candidate_prompt_version_id', where },
    );
  }
}

/* ------------------------------------------------------------------------------------------------
 * 7 · The writer
 * ---------------------------------------------------------------------------------------------- */

/**
 * The column sentinels of the terminal row.
 *
 * All ten are fixed and none is a parameter. Five of them are mechanical:
 * `ledger_nonmodel_costs_zero` requires `tokens_in`, `tokens_out`, `cost_aud`, `latency_ms` and
 * `restarts` to be zero for every class that is not `agent_call`
 * (`migrations/0002_ledger.sql:222-224`). **`restarts` is the trap:** a writer that copied the
 * chokepoint's shape would pass `runtime.restarts`, which in a restarted process is not zero, and the
 * row would die in the constraint.
 *
 * The other five are choices with reasons. `prompt_version_id` — the COLUMN — is null because it is a
 * real foreign key and the `evolve` agent has no registered row. `ticket_id` is null because a
 * terminal carrying one would enter that ticket's evidence panel through `ledger_ticket_idx`
 * (`migrations/0002_ledger.sql:238`) and inside Act 1 would read as something that happened to that
 * customer. `split_id` is null because no split is sealed. `confidence` is null because a promotion
 * attempt is not a model call. `cum_tokens` is CARRIED and not incremented: a row that spends nothing
 * advances nothing.
 */
function terminalRowContent(
  pair: PromotionPair,
  head: { seq: number; cum_tokens: number } | null,
  stateDigest: string,
): LedgerRowContent {
  return {
    run_id: pair.run_id,
    seq: (head?.seq ?? 0) + 1,
    org_id: pair.claims.org_id,
    ticket_id: null,
    // Fixed by `ledger_agent_identity`. Not a parameter: see the header.
    agent: 'evolve',
    prompt_version_id: null,
    model_requested: null,
    model_returned: null,
    sampling: null,
    seed: null,
    input_hash: null,
    input_path: null,
    prompt_hash: null,
    response_hash: null,
    state_hash: stateDigest,
    split_id: null,
    toolchain: pair.toolchain,
    restarts: 0,
    tokens_in: 0,
    tokens_out: 0,
    cost_aud: '0.000000',
    latency_ms: 0,
    cum_tokens: head?.cum_tokens ?? 0,
    class: 'promotion_attempt',
    output: pair.terminal as Json,
    confidence: null,
    ts: pair.ts,
  };
}

/**
 * Files one promotion attempt: its `start` row and its terminal, in that order, as a resumable pair.
 *
 * The whole of both payloads is checked first. Only then is the reader consulted, and only then is
 * anything written — so a caller that hands over an invalid terminal beside a valid start reaches the
 * database not at all.
 */
export async function appendPromotionPair(
  store: LedgerStore,
  reader: PromotionLedgerReader,
  pair: PromotionPair,
): Promise<FiledPair> {
  const orgId = pair.claims?.org_id;
  if (typeof orgId !== 'string' || orgId.trim() === '') {
    refuse('the writer runs under a session: claims must carry an org_id', { key: 'claims.org_id' });
  }
  if (typeof pair.run_id !== 'string' || pair.run_id.trim() === '') {
    refuse('a run must be named', { key: 'run_id' });
  }
  if (typeof pair.ts !== 'string' || pair.ts.trim() === '') {
    refuse('ts is supplied by the writer and never defaulted', { key: 'ts' });
  }

  const start = requireObject(pair.start as Json, 'start', 'pair');
  const terminal = requireObject(pair.terminal as Json, 'terminal', 'pair');

  validateStartPayload(start, pair.ts);
  validatePromotionAttemptPayload(terminal, {
    scored_run: pair.scored_run,
    evidence: pair.evidence,
  });

  const attemptId = start.attempt_id as string;
  if (terminal.attempt_id !== attemptId) {
    refuse('the start and its terminal name two different attempts', {
      key: 'attempt_id',
      start: attemptId,
      terminal: terminal.attempt_id,
    });
  }

  const stateDigest = stateHash(pair.state);

  // Pre-read. A complete pair is returned untouched; a half pair is completed. Both are a resume of
  // one attempt and neither is a second one, which is what the derived identity buys.
  const standing = await reader.findAttempt(orgId, attemptId);
  if (standing.start && standing.terminal) {
    return {
      attempt_id: attemptId,
      run_id: standing.start.run_id,
      start: standing.start,
      terminal: standing.terminal,
      action: 'already_filed',
    };
  }

  let startRow: AppendedRow | FiledRow;
  if (standing.start) {
    startRow = standing.start;
  } else {
    startRow = await appendSystemRow(store, {
      run_id: pair.run_id,
      org_id: orgId,
      ticket_id: null,
      class: 'start',
      output: start as Json,
      state: pair.state,
      toolchain: pair.toolchain,
      ts: pair.ts,
    });
  }

  let terminalRow: AppendedRow | FiledRow;
  try {
    terminalRow = await store.append(pair.run_id, orgId, (head) =>
      terminalRowContent(pair, head, stateDigest),
    );
  } catch (error) {
    // Re-read before propagating. If the pair is standing, the append lost a race with a writer that
    // had already filed it, and the honest answer is the pair rather than a failure.
    const again = await reader.findAttempt(orgId, attemptId);
    if (again.start && again.terminal) {
      return {
        attempt_id: attemptId,
        run_id: again.start.run_id,
        start: again.start,
        terminal: again.terminal,
        action: 'already_filed',
      };
    }
    if (error instanceof GatewayError) {
      throw new GatewayError(error.code, error.message, { ...error.detail, attempt_id: attemptId });
    }
    throw error;
  }

  return {
    attempt_id: attemptId,
    run_id: pair.run_id,
    start: startRow,
    terminal: terminalRow,
    action: standing.start ? 'resumed' : 'filed',
  };
}

/* ------------------------------------------------------------------------------------------------
 * 8 · The capsule
 * ---------------------------------------------------------------------------------------------- */

export type CapsuleInput = {
  claims: LedgerClaims;
  /**
   * Resolved against `prompt_version` by the caller, never typed and never inserted. The rule is
   * `ensurePromptLineage`'s: the row whose `schema_hash` equals the one this build publishes,
   * ordering by `generation desc`.
   */
  incumbent_prompt_version_id: string;
  /** `git rev-parse HEAD` of a clean tree. Forty hexadecimal characters or the row is refused. */
  code_sha: string;
  /** One instant, for both rows. */
  ts: string;
  state: { schema_version: string; ruleset_hash: string; kb_snapshot: string };
  toolchain: Json;
};

/**
 * The signed combination, built from the constants above and from nothing else.
 *
 * **One instant for both rows, and that is what happened.** The attempt evaluated nothing, so it
 * took no time; two rows at one instant is the truth and `seq` is what orders them. An invented
 * duration would be a number nobody measured.
 *
 * **`budget_reserved` is zero** because this capsule starts no generation and reserves nothing. The
 * database accepts it — JSON `0` is not JSON null — and the alternative would be the pre-registered
 * `B_max`, which is a pre-registration number and those are sealed until I25.
 */
export function capsulePair(input: CapsuleInput): PromotionPair {
  const orgId = input.claims.org_id;
  const attempt_id = attemptIdFor(orgId);

  return {
    claims: input.claims,
    run_id: capsuleRunIdFor(orgId),
    start: {
      attempt_id,
      started_at: input.ts,
      budget_reserved: 0,
      code_sha: input.code_sha,
    },
    terminal: {
      attempt_id,
      candidate_prompt_version_id: NO_CANDIDATE_PROPOSED.candidateFrom(
        input.incumbent_prompt_version_id,
      ),
      incumbent_prompt_version_id: input.incumbent_prompt_version_id,
      conjuncts: Object.fromEntries(
        CONJUNCT_NAMES.map((name) => [
          name,
          { verdict: CAPSULE_CONJUNCTS[name].verdict, reason: CAPSULE_CONJUNCTS[name].reason },
        ]),
      ),
      failing_conjunct: CAPSULE_FAILING_CONJUNCT,
      power: { ...CAPSULE_POWER },
      outcome: CAPSULE_OUTCOME,
      interpretation: CAPSULE_INTERPRETATION,
    },
    scored_run: null,
    evidence: {},
    state: input.state,
    toolchain: input.toolchain,
    ts: input.ts,
  };
}

/** Files the capsule. The mandate of `seed/promotion_capsule.mjs` is the only caller. */
export async function filePromotionCapsule(
  store: LedgerStore,
  reader: PromotionLedgerReader,
  input: CapsuleInput,
): Promise<FiledPair> {
  return appendPromotionPair(store, reader, capsulePair(input));
}

/** The canonical text of a payload, for an operator who wants to see what would be written. */
export function payloadText(payload: Readonly<Record<string, Json>>): string {
  return canonicalJson(payload as Json);
}
