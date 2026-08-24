/**
 * The two ends of the fourth channel: what is put on it, and what is allowed off it.
 *
 * ## When a record is emitted
 *
 * When the clause `draft_not_grounded` **fires** — read from the evaluation of every clause, not
 * from the reason that happens to survive the precedence. The two are different in exactly the case
 * that matters: an SLA instant that passed in the same second wins the column, and a knowledge gap
 * does not stop being one because something else got recorded beside it. Reading the stored reason
 * would lose the record precisely on the tickets that most need one.
 *
 * ## `zero_match` says what was seen, and nothing broader
 *
 * The escalation funnel has three entries and only one of them arrives from a retrieval that
 * returned nothing; its own guard is "the retrieval did not produce hits", which covers a query that
 * matched no document at all **and** a query that matched several and cleared no floor. Those are
 * different facts. `zero_match` is true only when the cycle came in by the empty-retrieval path
 * **and** the outcome was the empty one. Anything looser writes a record that overstates its own
 * evidence — and that evidence is what a later re-run is checked against, so a record that lies
 * about what it saw is worse than no record.
 *
 * ## Who supplies what
 *
 * The receiver mediated the query, so the terms, the snapshot, what came back and the rule for what
 * an absence means are its own and never travel. The channel carries the commitment, the two digests
 * that only tie, the snapshot repeated so it can be tied, the state, the diverging sources and one
 * bounded note. Every field has exactly one origin and the other side either ties it or checks that
 * it resolves — which is what makes a refusal name the side that was wrong.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { sha256Hex } from '@agents/canonical.ts';

import {
  GAP_CHANNEL_EMISSION_STATE,
  canonicalQueryForm,
  validateGapChannelRecord,
  type GapChannelRecord,
} from '@/alg/gap_channel';
import { withAppSession, type Claims } from '@/server/db';
import { AppError } from '@/server/errors';
import { committedDateFrom, gapCommitmentFor, todayUtc } from '@/server/kb/commitment';

/**
 * The digest that makes the re-run identical rather than similar.
 *
 * Terms and snapshot concatenated, exactly as the column's own contract writes it. The snapshot is
 * inside the digest on purpose: the same question asked again against a corpus that has moved is a
 * different question of the system, and the uniqueness that keeps one record per unanswered query is
 * taken over this value.
 */
export function queryDigest(terms: string, snapshot: string): string {
  return sha256Hex(`${terms}${snapshot}`);
}

/**
 * The digest of the question itself, with the corpus left out.
 *
 * This is the identity of a gap ACROSS corpora, where the digest above is its identity UNDER one.
 * The channel carries both because the receiver can recompute both, which is what makes them ties
 * rather than facts the producer asserts.
 */
export function questionDigest(terms: string): string {
  return sha256Hex(canonicalQueryForm(terms));
}

export type GapEvidence = {
  /** The query as the retrieval composed it. It never travels on the channel. */
  terms: string;
  snapshot: string;
  /** True only for a retrieval that matched no document at all. See the header. */
  zeroMatch: boolean;
  /** Identities of sources that share a key and disagree. Empty in every case but a conflict. */
  divergent: readonly string[];
};

/**
 * Builds the record the producer puts on the channel.
 *
 * The identity is minted here rather than by the database, so that a retried emission proposes the
 * same identity and the receiver's idempotence has something to be idempotent about. What comes back
 * from the receiver is what stands: a record that already existed keeps the identity it was written
 * under, and this one is discarded.
 */
export function gapChannelRecordFor(input: {
  orgId: string;
  evidence: GapEvidence;
  now: number;
}): GapChannelRecord {
  const commitment = gapCommitmentFor(input.orgId);

  return {
    gap_id: randomUUID(),
    canonical_key_sha256: questionDigest(input.evidence.terms),
    query_sha256: queryDigest(input.evidence.terms, input.evidence.snapshot),
    kb_snapshot: input.evidence.snapshot,
    owner_id: commitment.owner_id,
    committed_date: committedDateFrom(input.now, commitment.term_days),
    state: GAP_CHANNEL_EMISSION_STATE,
    divergent_kb_ids: [...input.evidence.divergent],
    note: commitment.statement,
  };
}

/** What the receiver already holds, and therefore never accepts from the channel. */
export type MediatedFacts = {
  orgId: string;
  ticketId: string;
  terms: string;
  snapshot: string;
  zeroMatch: boolean;
  /** Declared before the null rather than after it, from the published constant. */
  nullRule: string;
  /** The instant the cycle is evaluated at — one reading of the clock, never a second one. */
  now: number;
};

const OWNER_RESOLVES = `
  select 1 from app_user where id = $1::uuid and org_id = $2::uuid`;

const OPEN = `
  select kb_gap_open($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::boolean, $7, $8, $9::uuid, $10::date,
                     $11, $12::uuid[], $13::bigint) as gap_id`;

function refuse(detail: string, extra: Record<string, unknown> = {}): never {
  throw new AppError('E_CONTRATO', 422, `the gap channel refused a record: ${detail}`, extra);
}

/**
 * Takes one record off the channel and writes the gap it describes.
 *
 * Runs on the caller's client, inside the caller's transaction, for the reason every other write of
 * this cycle does: the record, the transition it belongs to and the decision that explains it commit
 * together or none of them does. A gap recorded beside a ticket that never escalated, or an
 * escalation with no record of what could not be answered, are both worse than either failing.
 *
 * **The record is refused whole or accepted whole.** Nothing is trimmed to fit and nothing absent is
 * filled in. Both repairs look kind and are the same mistake: the first stores words nobody wrote,
 * the second invents the commitment the channel exists to carry.
 */
export async function openGapFromChannel(
  client: PoolClient,
  record: GapChannelRecord,
  mediated: MediatedFacts,
): Promise<string> {
  const violations = validateGapChannelRecord(record);
  if (violations.length > 0) {
    refuse(violations.map((entry) => entry.detail).join('; '), {
      fields: violations.map((entry) => entry.field),
    });
  }

  // A record born in any other state would close a gap through the channel, which is the one thing
  // the closure requirement forbids. The other two values exist because the field mirrors the
  // record's column, and neither is emissible.
  if (record.state !== GAP_CHANNEL_EMISSION_STATE) {
    refuse(`a record is emitted ${GAP_CHANNEL_EMISSION_STATE} and this one arrived ${record.state}`, {
      field: 'state',
    });
  }

  // The two ties. The receiver recomputes from what it searched with and compares; it does not read
  // the digests to learn anything, and a mismatch means the producer hashed a different question
  // from the one about to be recorded.
  if (record.kb_snapshot !== mediated.snapshot) {
    refuse('the snapshot on the record is not the one the query ran against', { field: 'kb_snapshot' });
  }
  if (record.query_sha256 !== queryDigest(mediated.terms, mediated.snapshot)) {
    refuse('the query digest does not tie to the terms this receiver searched with', {
      field: 'query_sha256',
    });
  }
  if (record.canonical_key_sha256 !== questionDigest(mediated.terms)) {
    refuse('the canonical key digest does not tie to the question this receiver mediated', {
      field: 'canonical_key_sha256',
    });
  }

  // A commitment that has already run out is not a commitment. The database refuses a record born
  // overdue as well; this is the earlier line, and it is the one that can name the artefact rather
  // than the column — a commitment whose term has lapsed is an authoring fact, not a row shape.
  if (record.committed_date < todayUtc(mediated.now)) {
    refuse(`the commitment is dated ${record.committed_date}, which has already passed`, {
      field: 'committed_date',
    });
  }

  // The owner is validated, never invented. "Live" is "the row exists": `app_user` publishes no
  // other state, so a person who has left is removed rather than flagged, and this is the check that
  // notices a commitment naming somebody who is gone.
  const owner = await client.query(OWNER_RESOLVES, [record.owner_id, mediated.orgId]);
  if (owner.rowCount !== 1) {
    refuse('the owner does not resolve to a live user of this organisation', {
      field: 'owner_id',
      owner_id: record.owner_id,
    });
  }

  const written = await client.query<{ gap_id: string }>(OPEN, [
    record.gap_id,
    mediated.orgId,
    mediated.ticketId,
    mediated.terms,
    mediated.snapshot,
    mediated.zeroMatch,
    record.query_sha256,
    // `p_question_sha256`: the second identity, and it is the SAME value the channel calls
    // `canonical_key_sha256` — the digest of the question with the corpus left out. The two names
    // are not an accident: on the channel it is one of the two fields whose only job is to tie, and
    // in `kb_gap` it is the column a partial unique index uses to decide whether a question asked
    // again is the same episode. Named here so that a reader following either name finds the other.
    record.canonical_key_sha256,
    record.owner_id,
    record.committed_date,
    mediated.nullRule,
    record.divergent_kb_ids.length > 0 ? [...record.divergent_kb_ids] : null,
    null,
  ]);

  const gapId = written.rows[0]?.gap_id;
  if (!gapId) {
    throw new AppError('E_INTERNAL', 500, 'the gap writer returned no identity', {
      ticket_id: mediated.ticketId,
    });
  }
  return gapId;
}

/** One gap as a route needs it before it decides anything: enough to answer "may you see this". */
export type VisibleGap = {
  id: string;
  org_id: string;
  ticket_id: string;
  state: string;
  kb_snapshot: string;
};

const VISIBLE = `
  select g.id, g.org_id::text as org_id, g.ticket_id::text as ticket_id, g.state::text as state,
         g.kb_snapshot
    from kb_gap g where g.id = $1::uuid`;

/**
 * The gap this session can see, or null.
 *
 * Read under the session's own claims and with no tenant predicate of its own, so what comes back is
 * what the policies allow and a forgotten `where` cannot widen it. A row that does not exist and a
 * row this session may not see answer identically, for the reason every route in this system gives:
 * telling them apart confirms that another organisation's record exists to somebody not allowed to
 * know it does.
 */
export async function gapVisibleTo(claims: Claims, gapId: string): Promise<VisibleGap | null> {
  return withAppSession(claims, async (client) => {
    const found = await client.query<VisibleGap>(VISIBLE, [gapId]);
    return found.rows[0] ?? null;
  });
}

/** What the emission left behind: an identity, or the reason there is not one. */
export type EmittedGap = {
  gap_id: string | null;
  /** Null when the record was written. Otherwise the code the receiver or the writer refused with. */
  refused: string | null;
};

/**
 * The whole emission: the producer builds a record, the receiver validates it and writes it —
 * **inside a savepoint, so that nothing it refuses can bring down the escalation that invoked it.**
 *
 * ## Why the savepoint is not defensive dressing
 *
 * This runs inside the transaction that moves the ticket to `ESCALATED` and files the decision. In
 * PostgreSQL any failed statement poisons the whole transaction — a plain `try` around it would
 * catch the error and then every statement after it would fail with *current transaction is
 * aborted*. So a refusal here does not merely lose the record: **it loses the escalation**, and the
 * ticket is left in the state it started in, with nothing to move it. There is no sweeper in this
 * system and there is deliberately not meant to be one, so a ticket that needs one is a ticket
 * stranded for good.
 *
 * The rule this is the implementation of: **what the writer refuses must never take down the
 * transition that called it.** The escalation is a fact about the ticket; the record is evidence
 * about that fact. Losing the evidence is bad and is reported. Losing the fact is worse and is now
 * unrepresentable.
 *
 * What the refusal costs instead: the decision filed beside the transition carries `gap_id: null`
 * and the code, so the chain says *this escalation produced no record and here is why*. The one
 * realistic cause is a commitment naming somebody who has left, which is exactly what the receiver's
 * validation exists to catch and exactly the thing a person has to fix in the artefact.
 *
 * One function because the two halves belong to one moment, and separate parameters because the two
 * halves must not share a source. What the producer knows arrives as `evidence` and a commitment it
 * reads; what the receiver knows arrives as `mediated`; and the digests are computed twice, once on
 * each side, which is the whole point of a tie.
 */
export async function emitGapRecord(
  client: PoolClient,
  input: { orgId: string; ticketId: string; evidence: GapEvidence; nullRule: string; now: number },
): Promise<EmittedGap> {
  await client.query('savepoint gap_record');

  try {
    const record = gapChannelRecordFor({
      orgId: input.orgId,
      evidence: input.evidence,
      now: input.now,
    });

    const gap_id = await openGapFromChannel(client, record, {
      orgId: input.orgId,
      ticketId: input.ticketId,
      terms: input.evidence.terms,
      snapshot: input.evidence.snapshot,
      zeroMatch: input.evidence.zeroMatch,
      nullRule: input.nullRule,
      now: input.now,
    });

    await client.query('release savepoint gap_record');
    return { gap_id, refused: null };
  } catch (error) {
    await client.query('rollback to savepoint gap_record');
    return { gap_id: null, refused: refusalCodeOf(error) };
  }
}

/**
 * The name a refusal is filed under.
 *
 * A typed code where there is one, the database's own code where the refusal came from a constraint,
 * and a last resort that is still a name rather than a sentence: the decision detail is read by a
 * tally as well as by a person, and prose in it is prose nobody can count.
 */
function refusalCodeOf(error: unknown): string {
  if (error instanceof AppError) return error.code;
  const candidate = error as { code?: string; message?: string };
  if (typeof candidate?.code === 'string' && candidate.code !== '') return candidate.code;
  const named = typeof candidate?.message === 'string' ? candidate.message.match(/E_[A-Z_]+/) : null;
  return named ? named[0] : 'E_INTERNAL';
}
