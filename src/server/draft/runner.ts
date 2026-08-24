/**
 * The drafting cycle: retrieval, a draft, a verdict on the draft, and one transaction that either
 * moves a ticket towards a person's inbox or sends it to a person directly.
 *
 * ## The order, and what each alternative leaves behind
 *
 *  1. **Read.** The ticket, under the component's claims. Anything not in `TRIAGED` is abandoned
 *     without a write — the machine publishes exactly one edge into `DRAFTED` and it starts there.
 *  2. **Retrieve.** No model. The corpus of this organisation, under the snapshot in force, in a
 *     total order. This step can end the cycle.
 *  3. **Nothing found ⇒ escalate, for nothing.** `resultCount = 0` makes `effectiveGrounded` false
 *     and the `draft_not_grounded` clause fires. The ticket goes to a person having cost **zero**:
 *     no draft was written because there was nothing to write one from, and paying a model to
 *     compose an answer out of no sources is paying for the exact failure this system exists to
 *     prevent. This is the closing beat of the demonstration and it is also the cheapest path
 *     through this file.
 *  4. **Project the PAIR.** Both calls are priced against the ceiling before either is made. A
 *     projection of the draft alone would let the ceiling admit the first half of a pair and refuse
 *     the second — money spent on an answer nobody is allowed to check.
 *  5. **Draft.** With the sources, under a seed that is the attempt index.
 *  6. **Validate.** The draft under review, with the same sources.
 *  7. **One transaction.** The response row with its citations and its verdict, then
 *     `TRIAGED → DRAFTED`, then either `DRAFTED → AWAITING_AGENT` or `DRAFTED → ESCALATED`.
 *
 * ## The ticket does not enter DRAFTED until both calls have answered
 *
 * This is the ordering decision of this file and it is worth the paragraph. The tempting shape is
 * to write the draft, move the ticket to `DRAFTED`, then validate — it reads naturally, each step
 * commits what it achieved, and a crash leaves a real draft in a real state.
 *
 * It also leaves a ticket in `DRAFTED` that nothing will ever move. `DRAFTED` has exactly two exits
 * and both are the validator's; if the validation never happens — the ceiling cut between the two
 * calls, the provider timed out, the process died — the ticket sits in a state whose only way out
 * belongs to a step that already failed. There is no sweeper in this system and there is not meant
 * to be one, so a state that needs one is a state that must not be reachable.
 *
 * Holding both calls before any transition makes the stranded ticket **unrepresentable**. The cost
 * is stated rather than hidden: a crash between the two calls loses the draft's money and leaves the
 * ticket exactly where it was, which is recoverable by running the cycle again — and the re-run is
 * a cache hit, because the seed is an attempt index that restarts at zero and the input digest is
 * the same. That is the same argument the triage cycle makes for the retry counter, turned one
 * notch: the counter is not persisted here because it does not need to be, and A-6 of the record
 * explains why.
 *
 * ## The window that remains, named rather than hidden
 *
 * The two `agent_call` rows are committed inside `gateway.call()`, on the ledger's own pool and its
 * own transaction; the ticket and the response are written on the application's. There is no
 * distributed transaction to be had and none is pretended. A crash after the second call and before
 * the transaction leaves two paid rows and a ticket still in `TRIAGED`. The re-run answers both
 * calls from the chain at zero cost and completes.
 *
 * The alternatives considered and rejected: a two-phase commit across two pools, which neither the
 * driver nor the deployment target offers; writing the response row first and the ledger rows
 * afterwards, which would put an answer in front of a person before anything recorded what it cost;
 * and a compensating write, which is a sweeper wearing a different hat.
 * `test_APP_draft_atomic_with_validation` injects a failure into the database between the draft's
 * write and the verdict's and measures that nothing partial survives.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { GatewayError } from '@agents/errors.ts';
import type { GatewayResult, KbExcerpt } from '@agents/gateway.ts';
import { parseDraftEnvelope } from '@agents/draft/envelope.ts';
import { DRAFT_PROMPT_TEXT } from '@agents/draft/prompt.ts';
import { evaluateGrounding, type GroundingVerdict } from '@agents/grounding.ts';
import { AgentError } from '@agents/triage/errors.ts';
import { EXCERPT_MAX } from '@agents/triage/schema.ts';
import { parseValidateEnvelope } from '@agents/validate/envelope.ts';
import { VALIDATE_PROMPT_TEXT } from '@agents/validate/prompt.ts';
import type { Json } from '@agents/canonical.ts';

import {
  CLAUSE_STAGE,
  evaluateEscalation,
  evaluateEscalationClauses,
  type EscalationFeatures,
  type EscalationReason,
} from '@/alg/escalation';
import { featuresFromTicket } from '@/alg/features';
import { matchPolicyFlags, policyInput } from '@/alg/policy';
import { NULL_RULE, type RetrievalOutcome, type RetrievedSource } from '@/alg/retrieval';
import {
  DRAFT_SAMPLING,
  VALIDATE_SAMPLING,
  refuseIfRuntimeIsStale,
  runtimeFor,
  type OrgRuntime,
} from '@/server/agents';
import { withAppSession } from '@/server/db';
import { recordDecision, type DecisionAction } from '@/server/decisions';
import { AppError } from '@/server/errors';
import { emitGapRecord, type EmittedGap, type GapEvidence } from '@/server/kb/gap';
import { requireSnapshotHead, retrieve } from '@/server/kb/retrieval';
import { applyComponentTransitionOn, componentClaims } from '@/server/pipeline';
import { onRun } from '@/server/run_queue';
import type { TicketState } from '@/server/states';

/** The clause the whole cycle is about. Named once so no string is repeated. */
const GROUND_CLAUSE = 'draft_not_grounded';

/**
 * A failure the cycle answers by asking again with a fresh seed.
 *
 * `E_NO_GROUNDING` is deliberately absent, and its absence is a decision rather than an oversight.
 * A model that cited a source it was never given has not made a transient mistake — it has
 * fabricated a reference, and asking it again under another seed buys a different fabrication at
 * the same price. Four attempts would be four ways of learning the same thing. It escalates on the
 * first occurrence.
 */
const RETRYABLE = new Set(['E_SCHEMA', 'E_PROVIDER_TIMEOUT', 'E_PROVIDER_FAILED', 'E_MODEL_UNEXPECTED']);

/** A failure that says the system could not try. The ticket does not move. */
const SYSTEMIC = new Set([
  'E_BUDGET_EXHAUSTED',
  'E_CONFIG_INVALID',
  'E_MODEL_PRICE_UNKNOWN',
  'E_LEDGER_WRITE_FAILED',
  'E_INPUT_PATH_MISSING',
  'E_REPLAY_CACHE_MISS',
  'E_CANARY_NOT_REDACTED',
  'E_CANARY_EGRESS',
  'E_CANARY_IN_RESPONSE',
  'E_PII_EGRESS',
  'E_PII_IN_RESPONSE',
  'E_EMPTY_AFTER_REDACTION',
]);

/** The one state the machine gives the drafting agent an edge out of. */
const DRAFTABLE: readonly TicketState[] = ['TRIAGED'];

/** How many times a transaction is rebuilt after losing the head of the audit chain. */
const CHAIN_ATTEMPTS = 3;

export type DraftOutcome =
  /** The ticket was not in a state this agent has an edge out of. Nothing was read further. */
  | { outcome: 'SKIPPED'; status: TicketState }
  /** The corpus could not answer it. No model was called and nothing was spent. */
  | {
      outcome: 'ESCALATED_NO_SOURCES';
      reason: EscalationReason;
      clause: string;
      retrieval: RetrievalOutcome['kind'];
    }
  /** A grounded draft exists and the ticket is waiting for a person to approve it. */
  | { outcome: 'DRAFTED'; response_id: string; grounded: true; citations: number }
  /** A draft exists, it is not grounded, and the ticket went to a person with it. */
  | {
      outcome: 'ESCALATED_NOT_GROUNDED';
      reason: EscalationReason;
      clause: string;
      response_id: string;
      unsupported: readonly string[];
    }
  /** No usable draft was produced. The ticket went to a person with the reason it did. */
  | { outcome: 'FAILED'; reason: EscalationReason; clause: string; code: string }
  /** The system could not try. The ticket is untouched. */
  | { outcome: 'ABANDONED'; code: string };

type TicketRow = {
  id: string;
  org_id: string;
  status: TicketState;
  subject: string;
  body_raw: string;
  language: string;
  retries: number;
  created_at: Date;
  sla_due_at: Date | null;
  tier: string;
  value_band: number;
  customer_name: string | null;
  account_reference: string | null;
};

/**
 * The read, and the two columns that are deliberately null.
 *
 * This is the first agent whose output goes back to a person, so it is the first place where a
 * model repeating a customer's own name into a reply would be a value leaving the tenant by the
 * shortest possible route. The mechanism for that is `literals`: the tenant's own record of values
 * no pattern can recognise — a name, an address on file — handed to the chokepoint and removed by
 * exact match before anything leaves.
 *
 * **The schema holds no such value today, and these columns say so rather than substituting one.**
 * `app_user` carries an identifier, an organisation, a role and a locale; `account` carries a tier
 * and a value band. There is no name anywhere. The obvious thing to reach for is the account's
 * identifier, and it is the wrong thing twice: an identifier is not personal data, so removing it
 * protects nobody, and every value in the `literals` array is also SEARCHED for in the outbound
 * payload — so a value put there for the look of it is a value that can abort a call it had no
 * business being in.
 *
 * So the plumbing is wired and the array is empty. The day a name column lands, this query is where
 * it is read and nothing else has to change.
 */
const READ = `
  select t.id, t.org_id, t.status, t.subject, t.body_raw, t.language, t.retries,
         t.created_at, t.sla_due_at, a.tier, a.value_band,
         null::text as customer_name,
         null::text as account_reference
    from ticket t
    join account a on a.id = t.account_id
   where t.id = $1`;

export type DraftOptions = {
  /** The instant the cycle is evaluated at. One instant for the whole cycle, never one per read. */
  now?: number;
};

/**
 * One drafting cycle over one ticket, behind the queue of its run.
 *
 * The queue is `src/server/run_queue.ts` — the same one the triage cycle uses, and the reason it
 * is a module rather than a block of code repeated here.
 */
export async function runDraftCycle(
  orgId: string,
  ticketId: string,
  options: DraftOptions = {},
): Promise<DraftOutcome> {
  const runtime = await runtimeFor(orgId);
  return onRun(runtime.run_id, () => draftCycle(runtime, orgId, ticketId, options));
}

async function draftCycle(
  runtime: OrgRuntime,
  orgId: string,
  ticketId: string,
  options: DraftOptions,
): Promise<DraftOutcome> {
  const now = options.now ?? Date.now();

  // --- 1 · read ---------------------------------------------------------------------------------
  const ticket = await withAppSession(componentClaims(orgId), async (client) => {
    const result = await client.query<TicketRow>(READ, [ticketId]);
    return result.rows[0] ?? null;
  });

  if (!ticket) {
    throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no ticket with that id is visible to this component', {
      ticket_id: ticketId,
    });
  }
  if (!DRAFTABLE.includes(ticket.status)) {
    return { outcome: 'SKIPPED', status: ticket.status };
  }

  const policyFlags = matchPolicyFlags(policyInput(ticket.subject, ticket.body_raw));
  const account = { tier: ticket.tier, valueBand: ticket.value_band };
  const ticketFacts = {
    id: ticket.id,
    createdAt: ticket.created_at.getTime(),
    slaDueAt: ticket.sla_due_at ? ticket.sla_due_at.getTime() : null,
    language: ticket.language,
    retries: ticket.retries,
  };

  // --- 2 · retrieve, with no model in the path --------------------------------------------------
  //
  // The head is read fresh, and the runtime is holding the label it was built with. After an
  // admission that did not evict, those two disagree and every row this cycle writes would name a
  // corpus the retrieval did not read. Compared here, before anything is searched or spent.
  const snapshot = await requireSnapshotHead(orgId);
  refuseIfRuntimeIsStale(runtime, snapshot);

  const found = await retrieve({
    orgId,
    subject: ticket.subject,
    body: ticket.body_raw,
    snapshot,
    excerptMax: EXCERPT_MAX,
  });

  // --- 3 · nothing found: escalate, having spent nothing -----------------------------------------
  if (found.kind !== 'hits') {
    return escalateWithoutGrounding({
      runtime,
      orgId,
      ticket,
      ticketFacts,
      account,
      policyFlags,
      now,
      retrieval: { resultCount: 0 },
      // `zero_match` is true here only when the outcome was the empty one. This branch is also
      // reached by a retrieval that matched documents and cleared no floor, and recording that as
      // "nothing matched" would be a record overstating the evidence a later re-run is checked
      // against. The guard covers both; the field distinguishes them.
      gap: {
        terms: found.terms,
        snapshot: found.snapshot,
        zeroMatch: found.kind === 'zero_match',
        divergent: [],
      },
      outcome: (reason, clause) => ({
        outcome: 'ESCALATED_NO_SOURCES',
        reason,
        clause,
        retrieval: found.kind,
      }),
      detail: {
        retrieval_kind: found.kind,
        kb_snapshot: found.snapshot,
        result_count: 0,
        // The query terms are the ticket's own words and do not travel into an append-only table.
        // What travels is the shape of the answer, which is what an audit of "why was nothing
        // found" actually needs.
        best_rank: found.kind === 'below_threshold' ? found.bestRank : null,
      },
    });
  }

  const sources = found.sources;
  const literals = [ticket.customer_name, ticket.account_reference].filter(
    (value): value is string => typeof value === 'string' && value.trim().length >= 8,
  );
  const kb_context: KbExcerpt[] = sources.map((source) => ({
    kb_id: source.kb_id,
    excerpt: source.excerpt,
  }));

  // The identity is minted here, before either call, because the validation call's `input_path`
  // names the draft it is reviewing and a path that named a row not yet inserted would be a path
  // nobody could follow back.
  const responseId = randomUUID();

  // --- 4 · the pair, priced before either half is made -------------------------------------------
  try {
    await runtime.gateway.wouldAdmit(orgId, [
      {
        model_requested: runtime.models.draft,
        prompt_text: DRAFT_PROMPT_TEXT,
        body: ticket.body_raw,
        kb_context,
        sampling: { ...DRAFT_SAMPLING },
      },
      {
        model_requested: runtime.models.validate,
        prompt_text: VALIDATE_PROMPT_TEXT,
        // The draft does not exist yet, so its length is estimated at the bound the contract puts
        // on it. Over-estimating is the conservative direction for a ceiling.
        body: 'x'.repeat(DRAFT_SAMPLING.max_tokens * 4),
        kb_context,
        sampling: { ...VALIDATE_SAMPLING },
      },
    ]);
  } catch (error) {
    if (error instanceof GatewayError && SYSTEMIC.has(error.code)) {
      return { outcome: 'ABANDONED', code: error.code };
    }
    throw error;
  }

  // --- 5 and 6 · the two calls ------------------------------------------------------------------
  let attempt = 0;
  let lastCode = '';
  let produced: {
    draft: GatewayResult;
    text: string;
    citations: readonly string[];
    sourcesAsSent: readonly KbExcerpt[];
  } | null = null;

  for (;;) {
    let result: GatewayResult;
    try {
      result = await runtime.gateway.call({
        agent: 'draft',
        org_id: orgId,
        ticket_id: ticket.id,
        prompt_version_id: runtime.prompts.draft,
        prompt_text: DRAFT_PROMPT_TEXT,
        body: ticket.body_raw,
        literals,
        kb_context,
        locale: ticket.language,
        model_requested: runtime.models.draft,
        sampling: { ...DRAFT_SAMPLING },
        // A-6: the attempt index inside this loop, not a persisted counter. After a crash the loop
        // restarts at zero, the digest is the one the chain already holds, and the re-run is a
        // cache hit at zero cost. `ticket.retries` stays the triage cycle's alone — a failed draft
        // must not spend the retry budget that `retry_budget_exhausted` reads.
        seed: attempt,
        input_path: `db://ticket/${ticket.id}#body_raw+kb/${snapshot}`,
        pin_model: true,
      });
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      lastCode = error.code;
      if (SYSTEMIC.has(error.code)) return { outcome: 'ABANDONED', code: error.code };
      if (!RETRYABLE.has(error.code)) throw error;
      attempt += 1;
      if (attempt > runtime.thresholds.maxRetries) break;
      continue;
    }

    try {
      const envelope = parseDraftEnvelope(result.response_text, result.kb_context_redacted);
      produced = {
        draft: result,
        text: envelope.draft.text,
        citations: envelope.draft.kb_ids,
        sourcesAsSent: result.kb_context_redacted,
      };
      break;
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      lastCode = error.code;
      if (error.code === 'E_NO_GROUNDING') {
        // Not retryable, by the decision above. The draft stood on something it was never given.
        break;
      }
      attempt += 1;
      if (attempt > runtime.thresholds.maxRetries) break;
    }
  }

  if (!produced) {
    return escalateWithoutGrounding({
      runtime,
      orgId,
      ticket,
      ticketFacts,
      account,
      policyFlags,
      now,
      retrieval: { resultCount: found.resultCount },
      // **No record.** Sources were found and no usable draft came back after every attempt: that is
      // a provider that could not answer, not a corpus that could not. The clause fires because the
      // cycle reports `grounded: false` unconditionally on this path, and filing a knowledge gap on
      // it would put a permanent record about the CORPUS into the chain every time a model timed
      // out — and the re-run that is supposed to close it would have nothing to close against.
      gap: null,
      outcome: (reason, clause) => ({ outcome: 'FAILED', reason, clause, code: lastCode }),
      detail: {
        retrieval_kind: found.kind,
        kb_snapshot: snapshot,
        result_count: found.resultCount,
        failure_code: lastCode,
      },
    });
  }

  let verdictResult: GatewayResult;
  try {
    verdictResult = await runtime.gateway.call({
      agent: 'validate',
      org_id: orgId,
      ticket_id: ticket.id,
      prompt_version_id: runtime.prompts.validate,
      prompt_text: VALIDATE_PROMPT_TEXT,
      // The DRAFT is what this call is about. `input_path` says so and the prompt says so; the
      // customer's own words are not part of the relation being judged and do not travel here.
      body: produced.text,
      literals,
      kb_context,
      locale: ticket.language,
      model_requested: runtime.models.validate,
      sampling: { ...VALIDATE_SAMPLING },
      seed: 0,
      input_path: `db://ticket/${ticket.id}#draft/${responseId}+kb/${snapshot}`,
      pin_model: true,
    });
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    if (SYSTEMIC.has(error.code)) return { outcome: 'ABANDONED', code: error.code };
    return escalateWithoutGrounding({
      runtime,
      orgId,
      ticket,
      ticketFacts,
      account,
      policyFlags,
      now,
      retrieval: { resultCount: found.resultCount },
      // No record, for the reason the branch above gives: the validation never answered, so nothing
      // was learned about whether the corpus can support the draft.
      gap: null,
      outcome: (reason, clause) => ({ outcome: 'FAILED', reason, clause, code: error.code }),
      detail: { stage: 'validate', failure_code: error.code, kb_snapshot: snapshot },
    });
  }

  let modelSaysGrounded = false;
  let unsupported: readonly string[] = [];
  try {
    const verdict = parseValidateEnvelope(verdictResult.response_text);
    modelSaysGrounded = verdict.validate.grounded;
    unsupported = verdict.validate.unsupported_claims;
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    // A verdict this build cannot read is not a verdict. The fifth conjunct is withheld, which is
    // the fail-closed direction: the draft is recorded, it is not grounded, and a person reads it.
    modelSaysGrounded = false;
    unsupported = [];
    lastCode = error.code;
  }

  // --- the conjunction --------------------------------------------------------------------------
  const grounding = evaluateGrounding({
    // The sources AS THEY TRAVELLED, which is what the model saw and what the digest covers.
    sources: produced.sourcesAsSent.map((entry) => ({ kb_id: entry.kb_id, excerpt: entry.excerpt })),
    citations: produced.citations,
    draftText: produced.text,
    modelSaysGrounded,
  });

  const { features } = featuresFromTicket({
    ticket: ticketFacts,
    account,
    triage: null,
    redactedBodyLength: produced.draft.body_redacted.length,
    retrieval: { resultCount: found.resultCount },
    validation: { grounded: grounding.grounded },
    policyFlags,
  });

  const verdict = evaluateEscalation(features, now, runtime.thresholds);
  const clauses = evaluateEscalationClauses(features, now, runtime.thresholds);
  const groundClauseFired = clauses.some((outcome) => outcome.clause === GROUND_CLAUSE && outcome.fired);

  assertGroundStage();
  if (grounding.grounded && groundClauseFired) {
    throw new Error('the grounding clause fired on a draft the conjunction reports as grounded');
  }
  if (!grounding.grounded && !groundClauseFired) {
    throw new Error('the draft is not grounded and the clause that exists to say so did not fire');
  }

  // --- 7 · one transaction ----------------------------------------------------------------------
  const citedArticles = sources.filter((source) => produced.citations.includes(source.kb_id));

  /**
   * The sources a conflict named, as identities.
   *
   * The predicate groups by canonical key and the record references articles, so the keys are
   * resolved back through what the retrieval returned. It stays empty in every ordinary case: the
   * predicate is computed and recorded and does nothing else, and a gap born of a conflict is the
   * reserved ninth escalation index, which this card does not take.
   */
  const divergentArticles = sources
    .filter((source) => grounding.conflicting_keys.includes(source.canonical_key))
    .map((source) => source.article_id);

  let gapId: string | null = null;
  let gapRefused: string | null = null;

  await inTransaction(orgId, async (client) => {
    await insertResponse(client, {
      responseId,
      ticketId: ticket.id,
      text: produced.text,
      snapshot,
      grounded: grounding.grounded,
      draftRef: produced.draft.ledger.id,
      validateRef: verdictResult.ledger.id,
      cited: citedArticles,
      unsupported,
    });

    await applyComponentTransitionOn(client, {
      ticketId: ticket.id,
      from: 'TRIAGED',
      to: 'DRAFTED',
      owner: 'draft-agent',
    });

    if (grounding.grounded) {
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: 'DRAFTED',
        to: 'AWAITING_AGENT',
        // The validator presents itself HERE and only here. The escalation out of `DRAFTED` is the
        // rule's edge and carries the rule's owner, whatever the diagram's arrows suggest —
        // `applyComponentTransitionOn` throws a programmer error on a mismatched owner rather than
        // writing a state whose guard nobody with standing evaluated.
        owner: 'grounding-validator',
      });
    } else {
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: 'DRAFTED',
        to: 'ESCALATED',
        owner: 'escalation-rule',
        assign: {
          escalation_reason: verdict.reason,
          escalation_clause: verdict.clause,
        },
      });

      // The second of the two emission sites. A draft exists and it is not anchored, so the corpus
      // did not answer the question — and it answered with something, which is why this record does
      // not claim that nothing matched. Same transaction as the transition, for the same reason.
      const gap = await emitGapRecord(client, {
        orgId,
        ticketId: ticket.id,
        evidence: {
          terms: found.terms,
          snapshot,
          zeroMatch: false,
          divergent: divergentArticles,
        },
        nullRule: NULL_RULE,
        now,
      });
      gapId = gap.gap_id;
      gapRefused = gap.refused;
    }

    await fileDecision(client, {
      orgId,
      ticketId: ticket.id,
      action: grounding.grounded ? 'TICKET_DRAFTED' : 'TICKET_ESCALATED',
      runtime,
      features,
      now,
      reason: grounding.grounded ? null : verdict.reason,
      clause: grounding.grounded ? null : verdict.clause,
      stage: 'draft',
      detail: {
        response_id: responseId,
        kb_snapshot: snapshot,
        result_count: found.resultCount,
        citations: [...produced.citations],
        conjuncts: { ...grounding.conjuncts },
        unsupported_citations: [...grounding.unsupported_citations],
        conflicting_keys: [...grounding.conflicting_keys],
        draft_ledger_row_hash: produced.draft.ledger.row_hash,
        validate_ledger_row_hash: verdictResult.ledger.row_hash,
        gap_id: gapId,
        gap_refused: gapRefused,
      },
    });

    await fileDecision(client, {
      orgId,
      ticketId: ticket.id,
      action: 'TICKET_VALIDATED',
      runtime,
      features,
      now,
      reason: null,
      clause: null,
      stage: 'validate',
      detail: {
        response_id: responseId,
        grounded: grounding.grounded,
        // The model's answer and the arithmetic, separately, so an auditor can see which of the
        // five conjuncts decided it. A single boolean would hide the whole design.
        model_agrees: modelSaysGrounded,
        conjuncts: { ...grounding.conjuncts },
        unsupported_claim_count: unsupported.length,
        failure_code: lastCode || null,
      },
    });
  });

  if (grounding.grounded) {
    return {
      outcome: 'DRAFTED',
      response_id: responseId,
      grounded: true,
      citations: produced.citations.length,
    };
  }
  return {
    outcome: 'ESCALATED_NOT_GROUNDED',
    reason: verdict.reason as EscalationReason,
    clause: verdict.clause as string,
    response_id: responseId,
    unsupported,
  };
}

/**
 * The published stage of the grounding clause, checked rather than assumed.
 *
 * The triage cycle makes the mirror assertion at the record stage — "a clause fired here that is
 * decidable only later" — and this is the same instrument pointed the other way: the clause this
 * whole file exists to fire must still be a draft-stage clause. If somebody moves it in the
 * published table, the failure surfaces here, named, rather than as a ticket escalated at intake
 * for a retrieval nobody ran.
 */
function assertGroundStage(): void {
  const stage = CLAUSE_STAGE[GROUND_CLAUSE];
  if (stage !== 'draft') {
    throw new Error(
      `${GROUND_CLAUSE} is published as a ${stage}-stage clause, and the drafting cycle evaluates it at the draft stage`,
    );
  }
}

type EscalateInput = {
  runtime: OrgRuntime;
  orgId: string;
  ticket: TicketRow;
  ticketFacts: {
    id: string;
    createdAt: number;
    slaDueAt: number | null;
    language: string;
    retries: number;
  };
  account: { tier: unknown; valueBand: unknown };
  policyFlags: ReturnType<typeof matchPolicyFlags>;
  now: number;
  retrieval: { resultCount: number };
  /**
   * What the record of the unanswered question stands on, or `null` when there is no gap to record.
   *
   * **The domain of the emission is narrower than the domain of the clause, and the difference is
   * the whole of this field.** All three entries into this funnel fire `draft_not_grounded`, because
   * all three report `grounded: false`. Only one kind of them is a statement about the CORPUS: the
   * retrieval that found nothing usable. The other two are a provider that could not answer, and
   * filing a knowledge gap on those would fill the record with permanent claims about the corpus
   * every time a model timed out — claims a re-run could never close, because nothing about the
   * corpus was ever established.
   *
   * The caller supplies it because only the caller knows which of the three ways in it took.
   */
  gap: GapEvidence | null;
  outcome: (reason: EscalationReason, clause: string) => DraftOutcome;
  detail: Json;
};

/**
 * The path taken when no grounded draft exists, whatever the reason.
 *
 * One function for three cases — nothing retrieved, no usable draft after the attempts, a
 * validation that never answered — because all three produce the same fact about the ticket: it
 * cannot be answered from the corpus, so a person answers it. What differs is the detail filed
 * beside it, and that is a parameter.
 *
 * **`validation: {grounded: false}` and not a null.** There is no draft, so there is nothing
 * grounded, and that is a fact the rule can act on rather than an absence it should ignore. The
 * null is for "this step has not run"; here it has run and produced nothing.
 */
async function escalateWithoutGrounding(input: EscalateInput): Promise<DraftOutcome> {
  const { features } = featuresFromTicket({
    ticket: input.ticketFacts,
    account: input.account,
    triage: null,
    redactedBodyLength: null,
    retrieval: input.retrieval,
    validation: { grounded: false },
    policyFlags: input.policyFlags,
  });

  const verdict = evaluateEscalation(features, input.now, input.runtime.thresholds);
  const clauses = evaluateEscalationClauses(features, input.now, input.runtime.thresholds);

  assertGroundStage();

  // The gap clause must have FIRED, whatever survived the precedence. Which reason is stored is the
  // precedence's business — an SLA that expired in the same second is a real fact and may well be
  // the one worth recording — but the thing that must be true is that the system noticed the
  // knowledge gap. `evaluateEscalationClauses` is where a later increment reads it from, for the
  // same reason: a gap does not stop being a gap because another clause won the column.
  const groundFired = clauses.some((outcome) => outcome.clause === GROUND_CLAUSE && outcome.fired);
  if (!groundFired) {
    throw new Error(
      `no grounded draft exists for ${input.ticket.id} and ${GROUND_CLAUSE} did not fire, which would strand it`,
    );
  }
  if (!verdict.escalate || !verdict.reason || !verdict.clause) {
    throw new Error(`${GROUND_CLAUSE} fired for ${input.ticket.id} and the rule reports no escalation`);
  }

  const reason = verdict.reason;
  const clause = verdict.clause;

  await inTransaction(input.orgId, async (client) => {
    await applyComponentTransitionOn(client, {
      ticketId: input.ticket.id,
      from: input.ticket.status,
      to: 'ESCALATED',
      owner: 'escalation-rule',
      assign: { escalation_reason: reason, escalation_clause: clause },
    });

    // The record of the unanswered question, in the same transaction as the transition and the
    // decision. It is emitted because the clause FIRED, which is read above from every clause
    // evaluated rather than from the reason that survived the precedence — a knowledge gap does not
    // stop being one because an SLA expired in the same second and won the column.
    //
    // The emission cannot fail this transaction: it runs inside a savepoint of its own, and a
    // refusal comes back as a code to be filed rather than as an exception that would roll the
    // escalation back and leave the ticket in a state nothing would ever move it out of.
    const gap: EmittedGap = input.gap
      ? await emitGapRecord(client, {
          orgId: input.orgId,
          ticketId: input.ticket.id,
          evidence: input.gap,
          nullRule: NULL_RULE,
          now: input.now,
        })
      : { gap_id: null, refused: null };

    await fileDecision(client, {
      orgId: input.orgId,
      ticketId: input.ticket.id,
      action: 'TICKET_ESCALATED',
      runtime: input.runtime,
      features,
      now: input.now,
      reason,
      clause,
      stage: 'draft',
      // The escalation's own row names the record it rests on, which is what makes "one record per
      // escalation" a countable fact of an append-only chain rather than a sentence somebody has to
      // trust. A refusal is named for the same reason: an escalation that produced no record says so
      // and says why, instead of looking like one that never needed one.
      detail: {
        ...(input.detail as Record<string, Json>),
        gap_id: gap.gap_id,
        gap_refused: gap.refused,
      },
    });
  });

  return input.outcome(reason, clause);
}

type InsertResponseInput = {
  responseId: string;
  ticketId: string;
  text: string;
  snapshot: string;
  grounded: boolean;
  draftRef: string;
  validateRef: string;
  cited: readonly RetrievedSource[];
  unsupported: readonly string[];
};

/**
 * The answer and its citations, written together.
 *
 * A re-draft after an admission INSERTS a new row rather than updating the one before it. Both stay
 * readable, the current one is the newest by `created_at`, and the closing act of the demonstration
 * — the same question answered badly and then well — is two rows a panel can put side by side. An
 * update would have destroyed the first half of that evidence in the act of producing the second.
 *
 * The citation rows carry the snapshot as well as the article, so the composite foreign key can
 * refuse a citation of an article under a snapshot it does not exist in.
 */
async function insertResponse(client: PoolClient, input: InsertResponseInput): Promise<void> {
  await client.query(
    `insert into response (id, ticket_id, draft, kb_snapshot, grounded, validated_at,
                           draft_ledger_ref, validate_ledger_ref, unsupported_claims)
     values ($1::uuid, $2::uuid, $3, $4, $5, now(), $6::bigint, $7::bigint, $8::jsonb)`,
    [
      input.responseId,
      input.ticketId,
      input.text,
      input.snapshot,
      input.grounded,
      input.draftRef,
      input.validateRef,
      JSON.stringify(input.unsupported),
    ],
  );

  for (const source of input.cited) {
    await client.query(
      `insert into response_citation (response_id, kb_article_id, kb_snapshot)
       values ($1::uuid, $2::uuid, $3)`,
      [input.responseId, source.article_id, input.snapshot],
    );
  }
}

type DecisionInput = {
  orgId: string;
  ticketId: string;
  action: DecisionAction;
  runtime: OrgRuntime;
  features: EscalationFeatures;
  now: number;
  reason: EscalationReason | null;
  clause: string | null;
  stage: 'draft' | 'validate';
  detail: Json;
};

/**
 * The decision, as the chain records it.
 *
 * Every clause is here, fired or not, for the reason the triage cycle files them: the columns keep
 * one reason and an audit needs the rest. The ruleset digest is here because a verdict is only
 * reproducible under the rules that produced it, and the retrieval's parameters are inside that
 * digest now.
 *
 * **Not here: any part of the body, the subject, the draft, or a retrieved excerpt.** Identifiers,
 * counts, booleans and digests travel. A drafted reply is a piece of writing about a customer's
 * problem, and an append-only table is the worst possible place to discover one.
 */
async function fileDecision(client: PoolClient, input: DecisionInput): Promise<void> {
  const evaluated = evaluateEscalationClauses(input.features, input.now, input.runtime.thresholds);

  const detail: Json = {
    stage: input.stage,
    reason: input.reason,
    clause: input.clause,
    clauses: evaluated.map((outcome) => ({
      clause: outcome.clause,
      reason: outcome.reason,
      fired: outcome.fired,
    })),
    ruleset_hash: input.runtime.ruleset_hash,
    run_id: input.runtime.run_id,
    evaluated_at: new Date(input.now).toISOString(),
    ...(input.detail as Record<string, Json>),
  };

  await recordDecision(client, {
    orgId: input.orgId,
    action: input.action,
    ticketId: input.ticketId,
    detail,
    ts: new Date(input.now).toISOString(),
  });
}

/** `23505` on the audit chain's one-child-per-head index, or the trigger saying the same thing. */
function isChainConflict(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string };
  if (candidate?.code === '23505') return true;
  return typeof candidate?.message === 'string' && candidate.message.includes('E_LEDGER_CHAIN_BROKEN');
}

/**
 * One transaction under the component's claims, rebuilt if it loses the head of the audit chain.
 *
 * The retry is safe precisely because the unit is one transaction: a rollback puts the ticket back
 * in the state the compare-and-set was written against, so the rebuilt attempt applies the same
 * edges against the same `from`, and the response row it inserted is rolled back with it.
 */
async function inTransaction(
  orgId: string,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < CHAIN_ATTEMPTS; attempt += 1) {
    try {
      await withAppSession(componentClaims(orgId), work);
      return;
    } catch (error) {
      if (!isChainConflict(error)) throw error;
      lastError = error;
    }
  }

  throw new AppError('E_INTERNAL', 500, 'the audit chain could not be extended for this decision', {
    org_id: orgId,
    attempts: CHAIN_ATTEMPTS,
    reason: lastError instanceof Error ? lastError.message : String(lastError),
  });
}
