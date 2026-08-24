/**
 * Everything the read-only panel shows about one ticket, read under the session's own claims.
 *
 * **Read-only, and the absence of the other verbs is not a gap.** There is no edit, no approve and
 * no send here, and the reason they are missing is not that the console for them has not been built
 * yet — it is that `0009` made them unrepresentable from this side. A trigger refuses `SENT` without
 * a response carrying an approver and a sent instant, and a restrictive policy refuses any update
 * of `response` from a session with no subject, which is every component in this system. The
 * missing buttons are a consequence of that, not a substitute for it.
 *
 * **Read through the policies, never around them.** Every query below runs under the caller's
 * claims, so what the panel can show is exactly what the database will show anybody else holding
 * that session. None of them carries a tenant predicate, and that is deliberate: the policies
 * decide, so a forgotten `where` cannot leak another organisation's rows.
 */

import { withAppSession, type Claims } from '@/server/db';
import { kbIdOf } from '@/alg/retrieval';

/** One citation, as a person reads it: what was cited, what it is called, under which snapshot. */
export type CitationLine = {
  kb_id: string;
  canonical_key: string;
  title: string;
  kb_snapshot: string;
};

/** One drafted answer with its verdict. The newest is the one in force; the rest are history. */
export type DraftLine = {
  id: string;
  draft: string;
  created_at: string;
  kb_snapshot: string | null;
  grounded: boolean | null;
  validated_at: string | null;
  approved_by: string | null;
  sent_at: string | null;
  citations: CitationLine[];
  /**
   * What the validator would not support, quoted from the draft.
   *
   * Beside the draft rather than in the audit chain: these are sentences a person wrote about a
   * customer's problem, the draft above already holds every one of them, and the chain is the one
   * table in this system where nothing that anybody wrote is ever allowed to land.
   */
  unsupported_claims: string[];
};

/** One row of the chain, as the demonstration projects it. */
export type LedgerLine = {
  seq: number;
  agent: string;
  class: string;
  model_requested: string | null;
  cost_aud: string;
  latency_ms: number;
  state_hash: string;
  cache_hit: boolean;
  input_path: string | null;
  ts: string;
};

/** One knowledge gap recorded against this ticket, shown beside the escalation it produced. */
export type GapLine = {
  id: string;
  kb_snapshot: string;
  zero_match: boolean;
  state: string;
  null_rule: string;
  closed_by_check_at: string | null;
  not_documentable_reason: string | null;
  /**
   * Who owns closing it and by when — the two human facts the record carries.
   *
   * They are on screen because the act this card exists to show is a person being handed a piece of
   * work with a name and a date on it. A queue of gaps with neither is a list of things nobody
   * agreed to do.
   */
  owner_id: string;
  owner_role: string;
  committed_date: string;
};

/**
 * One admission, read BY THE GAP it answered rather than by the ticket.
 *
 * The distinction is not pedantry: an admission is a fact about the corpus, and the ticket is where
 * it happens to be visible because the gap that prompted it belongs to one. Reading it by ticket
 * would make the panel wrong the first time one admission answers a gap raised on another ticket.
 */
export type AdmissionLine = {
  id: string;
  gap_id: string;
  approved_by: string;
  /** The approver's role, joined here so the panel shows a standing rather than an identifier. */
  approver_role: string;
  snapshot_from: string;
  snapshot_to: string;
  /** The digest of the admitted body. Shown short; the full value is on the element's title. */
  content_hash: string;
  provenance_source: string;
  admitted_at: string;
  /** What was admitted, when the article is still readable under the snapshot it entered. */
  canonical_key: string | null;
  title: string | null;
};

/** What a drafting cycle decided, when there is no response row to show for it. */
export type RetrievalLine = {
  action: string;
  ts: string;
  reason: string | null;
  clause: string | null;
  retrieval_kind: string | null;
  result_count: number | null;
  kb_snapshot: string | null;
};

export type TicketEvidence = {
  drafts: DraftLine[];
  ledger: LedgerLine[];
  gaps: GapLine[];
  /** Every admission made against a gap of this ticket, newest first. */
  admissions: AdmissionLine[];
  /** The drafting cycle's own decisions, newest first. Empty until a cycle has run. */
  retrievals: RetrievalLine[];
};

const DRAFTS = `
  select r.id, r.draft, r.created_at, r.kb_snapshot, r.grounded, r.validated_at,
         r.approved_by::text as approved_by, r.sent_at, r.unsupported_claims
    from response r
   where r.ticket_id = $1::uuid
   order by r.created_at desc, r.id desc`;

/**
 * The citations of one answer, with the article they name.
 *
 * The join is on the composite key, not on the identifier alone. That is the whole value of the
 * reference `0009` declares: a citation names an article **under a snapshot**, and reading it back
 * under the same pair is what makes the title on screen the title of the document that was actually
 * cited rather than of whatever now stands at that identity.
 */
const CITATIONS = `
  select c.kb_article_id::text as kb_article_id, c.kb_snapshot, a.canonical_key, a.title
    from response_citation c
    join kb_article a on a.id = c.kb_article_id and a.kb_snapshot = c.kb_snapshot
   where c.response_id = $1::uuid
   order by a.canonical_key collate "C" asc, a.id asc`;

const LEDGER = `
  select l.seq, l.agent::text as agent, l.class::text as class, l.model_requested,
         l.cost_aud::text as cost_aud, l.latency_ms, l.state_hash, l.input_path, l.ts,
         coalesce((l.output -> 'cache' ->> 'hit')::boolean, false) as cache_hit
    from ledger_entry l
   where l.ticket_id = $1::uuid
   order by l.seq asc`;

const GAPS = `
  select g.id::text as id, g.kb_snapshot, g.zero_match, g.state::text as state, g.null_rule,
         g.closed_by_check_at, g.not_documentable_reason,
         g.owner_id::text as owner_id, u.role::text as owner_role, g.committed_date
    from kb_gap g
    join app_user u on u.id = g.owner_id
   where g.ticket_id = $1::uuid
   order by g.created_at desc`;

/**
 * The admissions made against a set of gaps.
 *
 * The approver is joined to their role, because the person reading this panel needs to know that a
 * supervisor let the document in and not that some identifier did. The article is joined on the
 * composite key so that the title shown is the title of the document as it stands under the snapshot
 * it entered, rather than of whatever now stands at that identity.
 *
 * A LEFT join on the article: `article_id` is nullable, and a row written before this migration — or
 * by a fixture — is still a real admission and belongs on the panel with its key unknown rather than
 * absent from it.
 */
const ADMISSIONS = `
  select m.id::text as id, m.gap_id::text as gap_id, m.approved_by::text as approved_by,
         u.role::text as approver_role, m.snapshot_from, m.snapshot_to, m.content_hash,
         m.provenance ->> 'source' as provenance_source, m.admitted_at,
         a.canonical_key, a.title
    from kb_admission m
    join app_user u on u.id = m.approved_by
    left join kb_article a on a.id = m.article_id and a.kb_snapshot = m.snapshot_to
   where m.gap_id = any($1::uuid[])
   order by m.admitted_at desc`;

/**
 * The drafting cycle's decisions, from the organisation's audit chain.
 *
 * The chain is where a verdict survives being overwritten: the columns hold one reason at a time
 * and a re-drafted ticket overwrites them, whereas every decision ever taken is still here in
 * order. It is also the only record of a cycle that produced no response row at all — a retrieval
 * that matched nothing writes no draft, so the chain is where "this ticket was asked and the corpus
 * had no answer" is stated.
 *
 * What is NOT here, by the rule this table lives under: any part of the body, the subject, the
 * draft or a retrieved excerpt. Identifiers, counts, booleans and digests only.
 */
const DECISIONS = `
  select e.action, e.ts, e.detail
    from audit_event e
   where e.object_type = 'ticket' and e.object_id = $1
   order by e.id desc`;

type DecisionRow = {
  action: string;
  ts: Date;
  detail: {
    stage?: string;
    reason?: string | null;
    clause?: string | null;
    retrieval_kind?: string | null;
    result_count?: number | null;
    kb_snapshot?: string | null;
    response_id?: string | null;
    unsupported_claim_count?: number | null;
  };
};

type AdmissionRow = {
  id: string;
  gap_id: string;
  approved_by: string;
  approver_role: string;
  snapshot_from: string;
  snapshot_to: string;
  content_hash: string;
  provenance_source: string | null;
  admitted_at: Date;
  canonical_key: string | null;
  title: string | null;
};

/**
 * A calendar day rendered as one.
 *
 * The driver hands a `date` column back as a `Date` at local midnight, so `toISOString` on it names
 * the day BEFORE in any zone EAST of UTC — local midnight in Sydney is the previous afternoon in
 * UTC. That is the direction this project runs in, which is why the reading is written down rather
 * than left to be re-derived: an earlier version of this sentence had the hemisphere backwards and
 * described a failure that cannot happen here. What was committed to is a day, and this is how a day
 * is written down.
 */
function dateOnly(value: Date): string {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function evidenceFor(claims: Claims, ticketId: string): Promise<TicketEvidence> {
  return withAppSession(claims, async (client) => {
    const drafts = await client.query<{
      id: string;
      draft: string;
      created_at: Date;
      kb_snapshot: string | null;
      grounded: boolean | null;
      validated_at: Date | null;
      approved_by: string | null;
      sent_at: Date | null;
      unsupported_claims: unknown;
    }>(DRAFTS, [ticketId]);

    const decisions = await client.query<DecisionRow>(DECISIONS, [ticketId]);

    const withCitations: DraftLine[] = [];
    for (const row of drafts.rows) {
      const cited = await client.query<{
        kb_article_id: string;
        kb_snapshot: string;
        canonical_key: string;
        title: string;
      }>(CITATIONS, [row.id]);

      withCitations.push({
        id: row.id,
        draft: row.draft,
        created_at: row.created_at.toISOString(),
        kb_snapshot: row.kb_snapshot,
        grounded: row.grounded,
        validated_at: row.validated_at ? row.validated_at.toISOString() : null,
        approved_by: row.approved_by,
        sent_at: row.sent_at ? row.sent_at.toISOString() : null,
        citations: cited.rows.map((citation) => ({
          // Rebuilt through `kbIdOf`, the one function that mints these — so the identifier on
          // screen is spelled exactly as the model was given it, separators removed and all. A
          // panel that rebuilt it by hand would show a spelling nobody could match against a ledger
          // row, and the reason the separators are gone is in `kbIdOf` rather than repeated here.
          kb_id: kbIdOf(citation.canonical_key, citation.kb_article_id),
          canonical_key: citation.canonical_key,
          title: citation.title,
          kb_snapshot: citation.kb_snapshot,
        })),
        unsupported_claims: Array.isArray(row.unsupported_claims)
          ? row.unsupported_claims.filter((claim): claim is string => typeof claim === 'string')
          : [],
      });
    }

    const ledger = await client.query<{
      seq: string;
      agent: string;
      class: string;
      model_requested: string | null;
      cost_aud: string;
      latency_ms: number;
      state_hash: string;
      input_path: string | null;
      ts: Date;
      cache_hit: boolean;
    }>(LEDGER, [ticketId]);

    const gaps = await client.query<{
      id: string;
      kb_snapshot: string;
      zero_match: boolean;
      state: string;
      null_rule: string;
      closed_by_check_at: Date | null;
      not_documentable_reason: string | null;
      owner_id: string;
      owner_role: string;
      committed_date: Date;
    }>(GAPS, [ticketId]);

    // By gap, and only when there is a gap. An empty list would make the query a scan over every
    // admission the tenant holds for no result at all.
    const gapIds = gaps.rows.map((row) => row.id);
    const admissions = gapIds.length === 0
      ? { rows: [] as AdmissionRow[] }
      : await client.query<AdmissionRow>(ADMISSIONS, [gapIds]);

    return {
      drafts: withCitations,
      ledger: ledger.rows.map((row) => ({
        seq: Number(row.seq),
        agent: row.agent,
        class: row.class,
        model_requested: row.model_requested,
        cost_aud: row.cost_aud,
        latency_ms: row.latency_ms,
        state_hash: row.state_hash,
        cache_hit: row.cache_hit,
        input_path: row.input_path,
        ts: row.ts.toISOString(),
      })),
      gaps: gaps.rows.map((row) => ({
        id: row.id,
        kb_snapshot: row.kb_snapshot,
        zero_match: row.zero_match,
        state: row.state,
        null_rule: row.null_rule,
        closed_by_check_at: row.closed_by_check_at ? row.closed_by_check_at.toISOString() : null,
        not_documentable_reason: row.not_documentable_reason,
        owner_id: row.owner_id,
        owner_role: row.owner_role,
        // A `date` column arrives as a Date at local midnight; the calendar day is what was
        // committed to, so it is rendered as one rather than as an instant in some zone.
        committed_date: dateOnly(row.committed_date),
      })),
      admissions: admissions.rows.map((row) => ({
        id: row.id,
        gap_id: row.gap_id,
        approved_by: row.approved_by,
        approver_role: row.approver_role,
        snapshot_from: row.snapshot_from,
        snapshot_to: row.snapshot_to,
        content_hash: row.content_hash,
        provenance_source: row.provenance_source ?? 'not stated',
        admitted_at: row.admitted_at.toISOString(),
        canonical_key: row.canonical_key,
        title: row.title,
      })),
      retrievals: decisions.rows
        .filter((row) => row.detail.stage === 'draft' || row.detail.stage === 'validate')
        .map((row) => ({
          action: row.action,
          ts: row.ts.toISOString(),
          reason: row.detail.reason ?? null,
          clause: row.detail.clause ?? null,
          retrieval_kind: row.detail.retrieval_kind ?? null,
          result_count: row.detail.result_count ?? null,
          kb_snapshot: row.detail.kb_snapshot ?? null,
        })),
    };
  });
}
