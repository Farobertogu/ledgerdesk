/**
 * The retrieval: which articles of the knowledge base a ticket's question reaches, under the
 * snapshot in force, in an order that is total.
 *
 * ## Lexical, and that is a decision rather than a limitation
 *
 * `tsvector` is the primary layer by ADR-005. It is worse than an embedding at finding a document
 * that answers a question in different words, and better at every other property this system is
 * built on: it is deterministic, it is reproducible from the row, it needs no second service and no
 * second model, and an auditor can re-run it by typing the query. A retrieval whose results
 * depended on a vector index built at some point in the past would make "replay from the ledger"
 * true only for as long as nobody reindexed.
 *
 * ## The four things this query gets right on purpose
 *
 * **The configuration is named.** `to_tsvector('english', …)` and `to_tsquery('english', …)`, never
 * the one-argument forms. See `src/alg/retrieval.ts` for the argument in full; the short version is
 * that the one-argument form reads a *server* setting, so two clean clones would stem the same
 * query differently and return different articles.
 *
 * **The query is a disjunction, and it has to be built rather than parsed.** The obvious call is
 * `plainto_tsquery('english', <the ticket>)`, and it is wrong here in a way that fails silently at
 * first glance and loudly on inspection: `plainto_tsquery` joins the terms it finds with AND. A
 * forty-word support enquiry becomes a forty-term conjunction, which no document in any corpus
 * satisfies, so every ticket retrieves nothing and every ticket escalates on a knowledge gap that
 * is an artefact of the query builder. The system would look like it was working — escalations are
 * a legitimate outcome and the demonstration has a beat for them — while the retrieval had never
 * returned a single document in its life.
 *
 * So the lexemes are taken out of the ticket with `to_tsvector` and rebuilt into an OR of quoted
 * lexemes. Ordered by lexeme, so the query string is a function of the ticket's *content* and not
 * of its word order; quoted, so a lexeme carrying punctuation cannot be read as an operator; and
 * empty when the ticket is nothing but stop words, in which case the join yields no rows and the
 * outcome is an honest `zero_match`.
 *
 * **The order is total, and the tiebreak is collated in binary.** `rank desc, canonical_key collate
 * "C" asc, id asc`. Rank alone leaves ties to the planner, the tied rows go into the envelope in
 * that order, and the envelope's digest is the cache key — so a re-plan that swaps two tied articles
 * turns a rehearsal's cache hit into `E_REPLAY_CACHE_MISS`. The tiebreak pair cannot itself tie:
 * `(kb_snapshot, canonical_key, id)` is unique.
 *
 * `collate "C"` is the half that is easy to leave out and undoes the rest. A bare `order by` on a
 * text column sorts under the DATABASE's collation, and a linguistic collation ignores punctuation
 * at the first pass: `exports/destinations` sorts before `exports-legacy/alpha` under `en_US.utf8`
 * and after it under `C`. Canonical keys carry `/` and `-` by construction, so the tiebreak that
 * exists to make the order reproducible across clean clones was itself a property of how somebody's
 * PostgreSQL had been initialised. Byte order is the same everywhere.
 *
 * **The snapshot is a filter and not a hope.** `where kb_snapshot = <the head>`, with the head read
 * from `kb_snapshot_head` rather than derived. An article admitted under a later snapshot is
 * invisible to a run pinned to an earlier one, which is what makes the replay of that run mean
 * anything.
 *
 * **It runs under `{org_id}` with no role.** The precedent is the ledger store's: what it cannot
 * see, it cannot leak. A reader that also asserted `role` would hold the claims that open the
 * ticket write path — standing it does not need for a select, and standing that would let a defect
 * here write something. The select policies on the knowledge base tables are tenant-only for
 * exactly this reason, and the restrictive role policies 0009 adds cover insert, update and delete
 * and deliberately not select.
 *
 * ## What it returns, and what it refuses to say
 *
 * A typed outcome, never a bare count. `zero_match` and `below_threshold` are different facts —
 * the first found nothing at all, the second found something and nothing cleared the floor — and
 * only the first may ever be recorded as `kb_gap.zero_match`. They escalate identically today; the
 * distinction exists because the gap record that a later cycle re-runs to close is a record whose
 * evidence has to be true.
 *
 * And the sentence it hands a console for an empty result is the published one: a statement about
 * this corpus at this version, never a statement that no answer exists.
 */

import {
  kbIdOf,
  MIN_RANK,
  RANK_FUNCTION,
  TEXT_SEARCH_CONFIG,
  TOP_K,
  type RetrievalOutcome,
  type RetrievedSource,
} from '@/alg/retrieval';
import { withAppSession, type TenantClaims } from '@/server/db';
import { AppError } from '@/server/errors';

/**
 * The claims the retrieval runs under: an organisation, and nothing else.
 *
 * Deliberately not `componentClaims`, which also asserts a role. See the header.
 */
export function retrievalClaims(orgId: string): TenantClaims {
  return { org_id: orgId };
}

const HEAD = 'select kb_snapshot from kb_snapshot_head where org_id = $1::uuid';

/**
 * The query, with every parameter of the ordering written out.
 *
 * `$2` is the query text and `$3` the snapshot; `k` and the floor are interpolated from the
 * published constants rather than passed as parameters, because they are part of the *ruleset* and
 * the ruleset is digested into `state_hash`. A value that could arrive per call would be a value
 * two calls could differ on without the rows saying so.
 */
function searchSql(): string {
  const document = `to_tsvector('${TEXT_SEARCH_CONFIG}', a.title || ' ' || a.body)`;
  const rank = `${RANK_FUNCTION}(${document}, q.query)`;

  return `
    with lexemes as (
      select string_agg(quote_literal(lexeme), ' | ' order by lexeme) as expression
        from unnest(to_tsvector('${TEXT_SEARCH_CONFIG}', $1)) as t(lexeme, positions, weights)
    ),
    q as (
      select to_tsquery('${TEXT_SEARCH_CONFIG}', expression) as query
        from lexemes
       where expression is not null
    )
    select a.id, a.canonical_key, a.title, a.body, ${rank}::text as rank
      from kb_article a
     cross join q
     where a.kb_snapshot = $2
       and ${document} @@ q.query
     order by ${rank} desc, a.canonical_key collate "C" asc, a.id asc
     limit ${TOP_K}`;
}

type ArticleRow = {
  id: string;
  canonical_key: string;
  title: string;
  body: string;
  rank: string;
};


/**
 * The query text a ticket asks with.
 *
 * Subject and body, in that order, exactly as the policy matcher composes its own input — one
 * string, computed once. `to_tsvector('english', …)` does the stemming and the stop-word removal
 * when the query is built out of it, so nothing here strips or normalises: a hand-rolled cleanup
 * would be a second opinion about what the words are, and the one that counts is the one the index
 * was built with.
 *
 * The RAW body, not the redacted one. The redacted body has markers where values were, and a marker
 * is not a word: a ticket whose subject is a customer's name and an invoice number would retrieve
 * against `[REDACTED:literal] [REDACTED:id]`. The query never leaves the database — the text is a
 * bind parameter to the `to_tsvector` that extracts its lexemes, on the same connection — so this is
 * not a value travelling anywhere.
 */
export function queryTermsFor(subject: string, body: string): string {
  return `${subject}\n${body}`;
}

/** The snapshot in force for an organisation, read from the pointer and never derived. */
export async function snapshotHeadFor(orgId: string): Promise<string | null> {
  return withAppSession(retrievalClaims(orgId), async (client) => {
    const result = await client.query<{ kb_snapshot: string }>(HEAD, [orgId]);
    return result.rows[0]?.kb_snapshot ?? null;
  });
}

export type RetrieveInput = {
  orgId: string;
  subject: string;
  body: string;
  /** The snapshot to search. Passed in rather than read here: one run, one snapshot per cycle. */
  snapshot: string;
  /** How much of an article travels. Bounded by the envelope contract; see the caller. */
  excerptMax: number;
};

/**
 * Searches the corpus of one organisation under one snapshot.
 *
 * The excerpt is the article's body truncated to the contract's bound, and the truncation is at the
 * bound rather than at a word boundary: a boundary rule is a second producer of the text a citation
 * is checked against, and the overlap and verbatim comparisons both work on whatever actually
 * travelled. A body inside the bound — which every seeded article is — travels whole.
 */
export async function retrieve(input: RetrieveInput): Promise<RetrievalOutcome> {
  const terms = queryTermsFor(input.subject, input.body);

  const rows = await withAppSession(retrievalClaims(input.orgId), async (client) => {
    const result = await client.query<ArticleRow>(searchSql(), [terms, input.snapshot]);
    return result.rows;
  });

  if (rows.length === 0) {
    return { kind: 'zero_match', terms, snapshot: input.snapshot, resultCount: 0, sources: [] };
  }

  const cleared = rows.filter((row) => Number(row.rank) >= MIN_RANK);
  if (cleared.length === 0) {
    return {
      kind: 'below_threshold',
      terms,
      snapshot: input.snapshot,
      resultCount: 0,
      sources: [],
      // The rows came back ordered by rank descending, so the first is the best one seen.
      bestRank: (rows[0] as ArticleRow).rank,
    };
  }

  const sources: RetrievedSource[] = cleared.map((row) => ({
    kb_id: kbIdOf(row.canonical_key, row.id),
    article_id: row.id,
    canonical_key: row.canonical_key,
    title: row.title,
    excerpt: row.body.slice(0, input.excerptMax),
    rank: row.rank,
  }));

  return {
    kind: 'hits',
    terms,
    snapshot: input.snapshot,
    resultCount: sources.length,
    sources,
  };
}

/**
 * The snapshot in force, or a typed refusal.
 *
 * An organisation with no head is a database that was seeded before 0009 or an organisation created
 * without one. Either way the honest answer is a refusal naming the migration, not a fall back to
 * the `kb:none` sentinel — a run that cited a corpus while recording that it had none would be
 * unreplayable in the exact way `state_hash` exists to prevent.
 */
export async function requireSnapshotHead(orgId: string): Promise<string> {
  const head = await snapshotHeadFor(orgId);
  if (!head) {
    throw new AppError(
      'E_INTERNAL',
      500,
      'this organisation has no knowledge-base snapshot in force, so nothing can be retrieved for it',
      { org_id: orgId, migration: '0009' },
    );
  }
  return head;
}
