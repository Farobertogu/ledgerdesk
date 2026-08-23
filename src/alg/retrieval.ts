/**
 * The published constants of the retrieval, and the shape of what it answers.
 *
 * Everything here is a **parameter of the verdict**, which is why it lives in the algorithm layer
 * and travels into `ruleset_hash`. A draft is grounded in what the retrieval returned; the
 * retrieval returns what these constants select; so two runs under a different `k`, a different
 * ranking function or a different floor are two experiments and must not pool in one cache. Moving
 * any value below changes `ruleset_hash` once, at deploy, and is declared like any other
 * recalibration.
 *
 * This module imports nothing outside `src/alg/`, so the constants are readable by a test with no
 * database. The SQL that uses them lives in `src/server/kb/retrieval.ts`, and it is the only place
 * that touches a table.
 *
 * ## Why the text search configuration is named and never defaulted
 *
 * `to_tsvector(body)` — the one-argument form — resolves its configuration through the database
 * setting `default_text_search_config`. That is a property of the *server*, not of this system: two
 * clean clones of this repository, on two machines whose PostgreSQL was initialised with different
 * locales, would stem the same query into different lexemes and return different articles for the
 * same ticket. Every query names `'english'` explicitly, so the retrieval is a function of the
 * corpus and the query and of nothing a deployment happens to be configured with.
 *
 * ## Why the order is total
 *
 * Rank alone is a partial order: two articles with equal `ts_rank_cd` come back in whatever order
 * the plan produced, which is stable until the day the planner picks a different scan. The excerpts
 * go into the envelope in that order, the envelope is digested into `input_hash`, and the digest is
 * the cache key — so a re-plan that swaps two tied rows produces a different key for the same
 * question, and a rehearsal that expected a cache hit gets `E_REPLAY_CACHE_MISS` in front of an
 * audience. `canonical_key` then `id` breaks every tie, and neither can itself tie: the pair is
 * unique under a snapshot by the constraint 0001 declares.
 */

/**
 * The text search configuration, named in every query rather than inherited from the server.
 *
 * The corpus is English. A system serving another language adds a column saying which
 * configuration each article was written for, which is a schema change and a dated decision, not a
 * default to be quietly widened.
 */
export const TEXT_SEARCH_CONFIG = 'english';

/**
 * How many sources a draft may be built from.
 *
 * Four, and both directions of the trade are real. Fewer, and a question whose answer spans two
 * policies loses one of them. More, and the drafting prompt fills with material that is only
 * loosely related — every extra excerpt is a source the model may cite, a source the verbatim rule
 * must check, and up to 2048 more characters of somebody else's writing in a prompt whose job is to
 * answer one ticket.
 */
export const TOP_K = 4;

/** The ranking function, named because it is part of the ordering the cache key depends on. */
export const RANK_FUNCTION = 'ts_rank_cd';

/**
 * The rank at or above which a match is a match.
 *
 * A floor is needed because `ts_rank_cd` is generous with a single incidental lexeme: a ticket
 * about an unrelated subject shares "the", "and" and often one real word with any article in the
 * corpus, and a retrieval with no floor answers every question with whatever it has. The value is
 * low on purpose — this is a filter against noise, not a relevance judgement — and the case it is
 * calibrated against is the one that matters most: a genuine question the corpus does not cover
 * must come back empty rather than come back with the nearest thing.
 */
export const MIN_RANK = 0.01;

/**
 * The rule for what a null means, declared BEFORE the null rather than after it.
 *
 * `kb_gap.null_rule` is `not null` for exactly this reason: a system that decides what an absence
 * meant once it has one is a system that decides it in whichever direction is convenient. The rule
 * is fixed here, versioned with the ruleset, and copied into every gap record that is ever opened.
 */
export const NULL_RULE =
  'A null is zero lexical matches at or above the published minimum rank, against the snapshot ' +
  'named in this record, using the named text search configuration. It is a statement about this ' +
  'corpus at this version and never a statement that the fact is untrue.';

/**
 * The sentence a console shows when the retrieval returned nothing.
 *
 * Published as a constant because the two places that say it — the panel and the record of the
 * decision — must say the same thing, and because the thing they must not say is anywhere near as
 * easy to write. "We have no information about that" is a claim about the world. What actually
 * happened is that a search of a named corpus at a named version matched nothing, which is a claim
 * about the search.
 */
export const NO_MATCH_STATEMENT =
  'No lexical match was found in the knowledge base at this snapshot. That is a result about this ' +
  'corpus at this version, not a statement that no answer exists.';

/**
 * The identifier that travels to a model and comes back as a citation.
 *
 * `<canonical_key>:<article id, with its hyphens removed>`. The key is in front because it is what
 * a person reads on a panel and what the conflict predicate groups by; the identity is behind it
 * because two articles can share a key and a citation has to name one row.
 *
 * ## Why the hyphens come out, which is not cosmetic
 *
 * A UUID is written as `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`, and the middle of that is
 * `dddd-dddd-dddd` whenever those groups happen to be all digits — which is **exactly** the shape
 * of a card number in the redaction dictionary, and it is the shape every identifier this
 * repository seeds by hand happens to have.
 *
 * The failure that produces is one of the nastiest kinds this system can have, and it was found by
 * a test rather than reasoned about in advance. Identifiers are not tenant material and are not
 * redacted, correctly — redacting a citation would destroy the thing a citation is. But the egress
 * scan searches the whole outbound payload for every literal the redactor removed from the material
 * that *is* tenant data. So a customer who writes a reference number shaped like `0000-4000-8000`
 * has that run removed from their body as a card, and the scan then finds the same fourteen
 * characters inside an article identifier that was never theirs. The call aborts with
 * `E_PII_EGRESS`, the ticket can never be drafted, and an operator sees a privacy error about a
 * value the customer did type and the system did remove, in a payload that leaked nothing.
 *
 * With the hyphens gone the identifier is a run of alphanumerics with no separator anywhere in it,
 * and **no rule in the dictionary can match any part of it**: the card and BSB rules need
 * separators or a bounded digit run, the phone rules need a leading `+`, a bracket, or a word
 * boundary that a continuous run does not offer, the IBAN rule needs two capitals and two digits,
 * the email rule needs an `@`, and the labelled rules need their label. That is a property of the
 * shape rather than of any particular value, which is what makes it safe for identifiers this
 * system has not minted yet. `test_KB_seeded_articles_survive_redaction` measures it over the real
 * corpus.
 */
export function kbIdOf(canonicalKey: string, articleId: string): string {
  return `${canonicalKey}:${articleId.replace(/-/g, '')}`;
}

/** One retrieved source, as everything downstream of the query sees it. */
export type RetrievedSource = {
  /** `<canonical_key>:<article id>` — the identifier that travels to the model and into a citation. */
  kb_id: string;
  /** The article's own identity, for the composite reference a citation row carries. */
  article_id: string;
  canonical_key: string;
  title: string;
  excerpt: string;
  /** The rank the ordering used, as text at the precision it was compared at. */
  rank: string;
};

/**
 * What a retrieval answers: a typed outcome, never a bare count.
 *
 * The two ways of returning nothing are different facts and the difference is load-bearing
 * downstream. `zero_match` means the query matched no document at all; `below_threshold` means it
 * matched and nothing cleared the floor. Both escalate under `GROUND` — the rule reads
 * `resultCount = 0` either way — but only `zero_match` may be recorded as `kb_gap.zero_match`, and
 * a gap record that overstated its own evidence is the record the re-run is supposed to close
 * against. A row that lies about what it saw is worse than no row.
 *
 * `terms` and `snapshot` travel in the form `kb_gap.query_terms` and `kb_gap.kb_snapshot` expect,
 * so the receiver recomputes `query_sha256` from what it was handed rather than deriving the query
 * a second time from the ticket — two producers of one digest is one producer too many.
 */
export type RetrievalOutcome =
  | { kind: 'zero_match'; terms: string; snapshot: string; resultCount: 0; sources: [] }
  | {
      kind: 'below_threshold';
      terms: string;
      snapshot: string;
      resultCount: 0;
      sources: [];
      /** The best rank seen, so an operator can tell "nearly" from "nothing". */
      bestRank: string;
    }
  | {
      kind: 'hits';
      terms: string;
      snapshot: string;
      resultCount: number;
      sources: readonly RetrievedSource[];
    };

/** The retrieval's parameters, in the form the ruleset digest is taken over. */
export type RetrievalDescription = {
  textSearchConfig: string;
  topK: number;
  rank: string;
  minRank: number;
  nullRule: string;
};

export function retrievalDescription(): RetrievalDescription {
  return {
    textSearchConfig: TEXT_SEARCH_CONFIG,
    topK: TOP_K,
    rank: RANK_FUNCTION,
    minRank: MIN_RANK,
    nullRule: NULL_RULE,
  };
}
