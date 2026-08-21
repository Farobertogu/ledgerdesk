/**
 * The triage cycle: the one module that makes the six increments before it compose.
 *
 * Everything it uses already existed and none of it was connected. The chokepoint could call a
 * model and chain the row; the rule could decide; the machine could publish an edge and refuse it
 * to a console; the columns could hold a verdict. What did not exist was the thing that reads a
 * ticket, asks, judges the answer and writes the consequence — and, more importantly, the thing
 * that decides **in what order** those writes happen, because the order is the only difference
 * between a system whose crashes are recoverable and one whose crashes leave states no guard
 * justifies.
 *
 * ## The order of writes, and what each alternative would leave behind
 *
 * The rule is *ledger first, ticket second, and everything about the ticket at once*:
 *
 *  1. **Read.** Ticket and account, under the component's claims. A ticket that is not in `NEW` or
 *     `REOPENED` is abandoned without a single write — which is also what makes a second trigger on
 *     an already-triaged ticket cost nothing at all.
 *  2. **Record stage.** The rule is evaluated on what the ticket's own record already settles. If a
 *     clause fires here, the ticket escalates **without a model call**: the guard on that edge says
 *     the rule fired, not that an answer was attempted, and paying for an answer nobody will read
 *     is the wrong kind of thorough. One transaction: the state, the reason, the clause and the
 *     audit row.
 *  3. **Attempt.** The gateway is called with the seed set to the persisted retry counter. A
 *     retryable failure increments that counter in a transaction of its own, **before** the next
 *     attempt, and the loop goes again.
 *  4. **Success.** One transaction carrying every write about the ticket: the six triage columns,
 *     the SLA policy and instant, the priority, the compare-and-set into `TRIAGED`, the second
 *     compare-and-set into `ESCALATED` when the verdict fires, and the audit row.
 *  5. **Exhausted.** One transaction: into `TRIAGE_FAILED`, then into `ESCALATED`, with the reason.
 *
 * Each alternative leaves a state nothing justifies. Transition before the call, and `TRIAGED`
 * means "an answer exists" while none does — the guard violated by construction. Columns in one
 * transaction and the state in another, and a crash leaves a `NEW` ticket carrying half a verdict.
 * `TRIAGED` committed and the escalation applied afterwards, and a crash loses a verdict that had
 * already fired, with no sweeper anywhere that would come back for it.
 *
 * ## The window that remains, named rather than hidden
 *
 * The `agent_call` row is committed inside `gateway.call()`, on the ledger's own pool and its own
 * transaction; the ticket is written on the application's. There is no distributed transaction to
 * be had and none is pretended. A crash between the two leaves a paid row and a ticket still in
 * `NEW` with `retries = k`.
 *
 * That is **recoverable by design, and the design is the seed**. The re-run reads the same
 * persisted counter, sends the same seed, and the cache — which is the chain itself, keyed on the
 * digest of the input, the prompt, the state and the sampling — answers with the same envelope at
 * zero cost. Same answer, same verdict, second honest row. The cache is the idempotence mechanism,
 * and it works precisely because the seed is a persisted counter and not an index in memory.
 *
 * ## Errors that transition, and errors that do not
 *
 * The published guard on `NEW → TRIAGE_FAILED` reads *"schema violation, timeout, or an empty body
 * after redaction"*. It does not say "the system could not try". So a budget cut, an invalid
 * configuration, an unknown price, a ledger that would not accept a row, a canary that did not
 * clear, a value caught on its way out — none of them moves the ticket and none of them increments
 * the counter. The ticket stays in `NEW`, ready for the next cycle, and the event has already been
 * filed by the component that raised it. Sending those to `TRIAGE_FAILED` would be an amendment to
 * a published guard, which is a dated decision and not a builder's choice.
 */

import type { PoolClient } from 'pg';

import { GatewayError } from '@agents/errors.ts';
import type { GatewayResult } from '@agents/gateway.ts';
import { AgentError } from '@agents/triage/errors.ts';
import { parseTriageEnvelope } from '@agents/triage/envelope.ts';
import { TRIAGE_PROMPT_TEXT } from '@agents/triage/prompt.ts';
import type { Json } from '@agents/canonical.ts';

import { featuresFromTicket, formatStored, type TriageReading } from '@/alg/features';
import {
  CLAUSE_STAGE,
  evaluateEscalation,
  evaluateEscalationClauses,
  type EscalationFeatures,
  type EscalationReason,
  type PolicyFlag,
} from '@/alg/escalation';
import { matchPolicyFlags, policyInput } from '@/alg/policy';
import { computePriority } from '@/alg/priority';
import { TRIAGE_MODEL, TRIAGE_SAMPLING, triageRuntimeFor } from '@/server/agents';
import { withAppSession } from '@/server/db';
import { AppError } from '@/server/errors';
import { recordDecision, type DecisionAction } from '@/server/decisions';
import {
  applyComponentTransitionOn,
  componentClaims,
  type ComponentAssignment,
} from '@/server/pipeline';
import type { TicketState } from '@/server/states';

/**
 * A failure the cycle answers by asking again with a fresh seed.
 *
 * `E_SCHEMA` is here because a model that answered badly may answer well; `E_MODELO_INESPERADO` is
 * here because the row is already written and the pin is what raised — the call happened and can
 * happen again under the model that was asked for. `E_EMPTY_AFTER_REDACTION` is deliberately NOT
 * here: a body that redacted to nothing will redact to nothing again, and retrying it four times
 * is four ways of learning the same thing.
 */
const RETRYABLE = new Set(['E_SCHEMA', 'E_PROVIDER_TIMEOUT', 'E_PROVIDER_FAILED', 'E_MODELO_INESPERADO']);

/**
 * A failure that says the system could not try, which is not one of the three the guard on
 * `NEW → TRIAGE_FAILED` publishes. The ticket does not move and the counter does not advance.
 */
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
]);

/** The states a triage cycle may start from — the two the machine gives the triage agent. */
const TRIAGEABLE: readonly TicketState[] = ['NEW', 'REOPENED'];

/** How many times a transaction is rebuilt after losing the head of the audit chain. */
const CHAIN_ATTEMPTS = 3;

export type TriageOutcome =
  /** The ticket was not in a state this agent has an edge out of. Nothing was read further. */
  | { outcome: 'SKIPPED'; status: TicketState }
  /** The record settled it before any model was asked. */
  | { outcome: 'ESCALATED_AT_RECORD'; reason: EscalationReason; clause: string }
  /** An answer arrived, was judged, and the ticket moved. */
  | { outcome: 'TRIAGED'; escalated: boolean; reason: EscalationReason | null; clause: string | null }
  /** Every attempt failed, and the ticket carries the reason it did. */
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
};

const READ = `
  select t.id, t.org_id, t.status, t.subject, t.body_raw, t.language, t.retries,
         t.created_at, t.sla_due_at, a.tier, a.value_band
    from ticket t
    join account a on a.id = t.account_id
   where t.id = $1`;

export type TriageOptions = {
  /** The instant the cycle is evaluated at. One instant for the whole cycle, never one per read. */
  now?: number;
};

/**
 * The queue that makes "one writer per run" a property rather than a hope.
 *
 * The ledger's append loop is six immediate attempts with no backoff, and it reads the head before
 * the trigger takes its lock. A dozen cycles racing on one run can exhaust those six with the
 * model's answer already paid for — the money is gone and the row that would account for it is the
 * thing that failed. Serialising the cycles of a run costs latency and buys that away.
 *
 * Held on `globalThis` for the same reason the pools are: a hot reload that dropped the map would
 * quietly allow two writers again, in the one environment where nobody is watching for it.
 */
const globalForQueue = globalThis as unknown as {
  ledgerdeskTriageQueue?: Map<string, Promise<unknown>>;
};

function queues(): Map<string, Promise<unknown>> {
  globalForQueue.ledgerdeskTriageQueue ??= new Map();
  return globalForQueue.ledgerdeskTriageQueue;
}

/**
 * One triage cycle over one ticket, behind the queue of its run.
 *
 * A cycle that throws does not poison the queue: the tail is the settled promise, so the next
 * cycle waits for this one to finish and not for it to succeed.
 */
export async function runTriageCycle(
  orgId: string,
  ticketId: string,
  options: TriageOptions = {},
): Promise<TriageOutcome> {
  const runtime = await triageRuntimeFor(orgId);
  const queue = queues();
  const previous = queue.get(runtime.run_id) ?? Promise.resolve();

  const mine = previous.then(() => triageCycle(orgId, ticketId, options));
  queue.set(
    runtime.run_id,
    mine.then(
      () => undefined,
      () => undefined,
    ),
  );
  return mine;
}

async function triageCycle(
  orgId: string,
  ticketId: string,
  options: TriageOptions = {},
): Promise<TriageOutcome> {
  const now = options.now ?? Date.now();
  const runtime = await triageRuntimeFor(orgId);

  // --- 1 · read -------------------------------------------------------------------------------
  const ticket = await withAppSession(componentClaims(orgId), async (client) => {
    const result = await client.query<TicketRow>(READ, [ticketId]);
    return result.rows[0] ?? null;
  });

  if (!ticket) {
    throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no ticket with that id is visible to this component', {
      ticket_id: ticketId,
    });
  }
  if (!TRIAGEABLE.includes(ticket.status)) {
    return { outcome: 'SKIPPED', status: ticket.status };
  }

  const createdAt = ticket.created_at.getTime();

  // Computed once and reused by both evaluations. Two different strings could flip a flag between
  // the record stage and the post-triage stage, and the ticket's reason would then depend on which
  // evaluation happened to see it.
  const policyFlags = matchPolicyFlags(policyInput(ticket.subject, ticket.body_raw));

  const account = { tier: ticket.tier, valueBand: ticket.value_band };
  const ticketFacts = {
    id: ticket.id,
    createdAt,
    slaDueAt: ticket.sla_due_at ? ticket.sla_due_at.getTime() : null,
    language: ticket.language,
    retries: ticket.retries,
  };

  // --- 2 · the record stage -------------------------------------------------------------------
  const atRecord = featuresFromTicket({
    ticket: ticketFacts,
    account,
    triage: null,
    redactedBodyLength: null,
    policyFlags,
  });
  const recordVerdict = evaluateEscalation(atRecord.features, now, runtime.thresholds);

  if (recordVerdict.escalate && recordVerdict.reason && recordVerdict.clause) {
    // The sentinels of the adapter are what make this assertion hold: an untriaged ticket carries
    // severity 1 and a null sentiment and confidence, so no clause of a later stage can fire here.
    // If one ever did, the sentinels would have stopped being sentinels and this is where to find
    // out, rather than in a ticket escalated for a confidence nobody produced.
    const stage = CLAUSE_STAGE[recordVerdict.clause];
    if (stage !== 'record') {
      throw new Error(
        `the record stage fired ${recordVerdict.clause}, which is decidable only at the ${stage} stage`,
      );
    }

    await inTransaction(orgId, async (client) => {
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: ticket.status,
        to: 'ESCALATED',
        owner: 'escalation-rule',
        assign: {
          escalation_reason: recordVerdict.reason,
          escalation_clause: recordVerdict.clause,
        },
      });
      await fileDecision(client, {
        orgId,
        ticketId: ticket.id,
        action: 'TICKET_ESCALATED',
        runtime,
        features: atRecord.features,
        now,
        reason: recordVerdict.reason,
        clause: recordVerdict.clause,
        stage: 'record',
      });
    });

    return {
      outcome: 'ESCALATED_AT_RECORD',
      reason: recordVerdict.reason,
      clause: recordVerdict.clause,
    };
  }

  // --- 3 · the attempts -----------------------------------------------------------------------
  let retries = ticket.retries;
  let emptyAfterRedaction = false;
  let lastCode = '';
  let answer: { result: GatewayResult; reading: NonNullable<TriageReading> } | null = null;

  for (;;) {
    let result: GatewayResult;
    try {
      result = await runtime.gateway.call({
        agent: 'triage',
        org_id: orgId,
        ticket_id: ticket.id,
        prompt_version_id: runtime.prompt_version_id,
        prompt_text: TRIAGE_PROMPT_TEXT,
        // The body as the customer wrote it. The gateway redacts it and no caller is trusted to
        // have done so; the subject is not sent, because the envelope the contract publishes has
        // one field for the enquiry and `body_redacted` is the redaction of `body_raw`.
        body: ticket.body_raw,
        locale: ticket.language,
        model_requested: TRIAGE_MODEL,
        sampling: { ...TRIAGE_SAMPLING },
        // The persisted counter, which is what makes a re-run after a crash a cache hit.
        seed: retries,
        input_path: `db://ticket/${ticket.id}#body_raw`,
        pin_model: true,
      });
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      lastCode = error.code;

      if (SYSTEMIC.has(error.code)) {
        return { outcome: 'ABANDONED', code: error.code };
      }
      if (error.code === 'E_EMPTY_AFTER_REDACTION') {
        emptyAfterRedaction = true;
        break;
      }
      if (!RETRYABLE.has(error.code)) {
        // A code the register grew without this set growing with it. Failing loudly beats guessing
        // which half of the partition it belongs to.
        throw error;
      }

      retries = await bumpRetries(orgId, ticket.id, ticket.status);
      if (retries > runtime.thresholds.maxRetries) break;
      continue;
    }

    try {
      const envelope = parseTriageEnvelope(result.response_text);
      answer = {
        result,
        reading: {
          category: envelope.triage.category,
          severity: envelope.triage.severity,
          sentiment: envelope.triage.sentiment,
          confidence: envelope.confidence,
        },
      };
      break;
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      lastCode = error.code;
      retries = await bumpRetries(orgId, ticket.id, ticket.status);
      if (retries > runtime.thresholds.maxRetries) break;
    }
  }

  // --- 4 · the answer, judged and written in one transaction -----------------------------------
  if (answer) {
    return applyAnswer({
      orgId,
      ticket,
      ticketFacts: { ...ticketFacts, retries },
      account,
      policyFlags,
      now,
      runtime,
      result: answer.result,
      reading: answer.reading,
    });
  }

  // --- 5 · exhausted --------------------------------------------------------------------------
  const atFailure = featuresFromTicket({
    ticket: { ...ticketFacts, retries },
    account,
    triage: null,
    // Zero is a value with a meaning: nothing survived redaction, so there is nothing to be
    // confident about, and the rule reads the effective confidence as 0.
    redactedBodyLength: emptyAfterRedaction ? 0 : null,
    policyFlags,
  });
  const failureVerdict = evaluateEscalation(atFailure.features, now, runtime.thresholds);

  if (!failureVerdict.escalate || !failureVerdict.reason || !failureVerdict.clause) {
    // TRIAGE_FAILED with no clause would be a dead state: nothing else in the machine moves a
    // ticket out of it. Either the retry counter is past its budget or the body redacted to
    // nothing, so one of the two clauses always holds — and if neither does, that is a defect in
    // this file and not a ticket to abandon quietly.
    throw new Error(
      `triage of ${ticket.id} failed with ${lastCode} and no escalation clause fires, which would strand it`,
    );
  }

  const reason = failureVerdict.reason;
  const clause = failureVerdict.clause;

  await inTransaction(orgId, async (client) => {
    // REOPENED has no edge to TRIAGE_FAILED — the machine publishes REOPENED → TRIAGED and
    // REOPENED → ESCALATED and nothing else — so a re-triage that fails escalates directly. The
    // retry counter survives the reopen by the published guard of that edge, which is what makes
    // the RETRY clause still true on the second pass.
    if (ticket.status === 'REOPENED') {
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: 'REOPENED',
        to: 'ESCALATED',
        owner: 'escalation-rule',
        assign: { escalation_reason: reason, escalation_clause: clause },
      });
    } else {
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: ticket.status,
        to: 'TRIAGE_FAILED',
        owner: 'triage-agent',
      });
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: 'TRIAGE_FAILED',
        to: 'ESCALATED',
        owner: 'escalation-rule',
        assign: { escalation_reason: reason, escalation_clause: clause },
      });
    }

    await fileDecision(client, {
      orgId,
      ticketId: ticket.id,
      action: 'TICKET_ESCALATED',
      runtime,
      features: atFailure.features,
      now,
      reason,
      clause,
      stage: 'failure',
      code: lastCode,
    });
  });

  return { outcome: 'FAILED', reason, clause, code: lastCode };
}

type ApplyInput = {
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
  policyFlags: readonly PolicyFlag[];
  now: number;
  runtime: Awaited<ReturnType<typeof triageRuntimeFor>>;
  result: GatewayResult;
  reading: NonNullable<TriageReading>;
};

/**
 * The success path: everything the ticket learns from one answer, written at once.
 *
 * The two compare-and-sets are two statements and one transaction. The intermediate `TRIAGED` is
 * never committed, so it is never visible to a console, a query or another cycle — there is no
 * history table for it to be absent from, and no sweeper would ever have to come looking for a
 * ticket stranded between the two.
 */
async function applyAnswer(input: ApplyInput): Promise<TriageOutcome> {
  const { orgId, ticket, now, runtime, reading } = input;

  // The SLA policy is chosen from the account's tier and the severity the answer assigned, which
  // is the first moment either is known. The instant is created_at plus the policy's first-response
  // window — the convention the seeded policy family is written in.
  const policy = await withAppSession(componentClaims(orgId), async (client) => {
    const result = await client.query<{ id: string; first_response_minutes: number }>(
      'select id, first_response_minutes from sla_policy where tier = $1 and severity = $2',
      [ticket.tier, reading.severity],
    );
    return result.rows[0] ?? null;
  });

  const slaDueAt = policy
    ? input.ticketFacts.createdAt + policy.first_response_minutes * 60_000
    : null;

  const { features, stored } = featuresFromTicket({
    ticket: { ...input.ticketFacts, slaDueAt },
    account: input.account,
    triage: reading,
    redactedBodyLength: input.result.body_redacted.length,
    policyFlags: input.policyFlags,
  });

  if (!stored) throw new Error('an answer was validated and produced no stored reading');

  const priority = computePriority(features, now).storedScore;
  const verdict = evaluateEscalation(features, now, runtime.thresholds);

  const assign: ComponentAssignment = {
    category: stored.category,
    severity: stored.severity,
    // Fixed-scale decimals travel as text, at the scale the column declares, so the value judged
    // and the value stored are the same value and not two roundings of one.
    sentiment: formatStored(stored.sentiment),
    confidence: formatStored(stored.confidence),
    body_redacted: input.result.body_redacted,
    sla_policy_id: policy ? policy.id : null,
    sla_due_at: slaDueAt === null ? null : new Date(slaDueAt).toISOString(),
    priority: priority.toFixed(6),
  };

  await inTransaction(orgId, async (client) => {
    await applyComponentTransitionOn(client, {
      ticketId: ticket.id,
      from: ticket.status,
      to: 'TRIAGED',
      owner: 'triage-agent',
      assign,
    });

    if (verdict.escalate && verdict.reason && verdict.clause) {
      await applyComponentTransitionOn(client, {
        ticketId: ticket.id,
        from: 'TRIAGED',
        to: 'ESCALATED',
        owner: 'escalation-rule',
        assign: { escalation_reason: verdict.reason, escalation_clause: verdict.clause },
      });
    }

    await fileDecision(client, {
      orgId,
      ticketId: ticket.id,
      action: verdict.escalate ? 'TICKET_ESCALATED' : 'TICKET_TRIAGED',
      runtime,
      features,
      now,
      reason: verdict.reason,
      clause: verdict.clause,
      stage: 'triage',
      ledger: input.result.ledger.row_hash,
    });
  });

  return {
    outcome: 'TRIAGED',
    escalated: verdict.escalate,
    reason: verdict.reason,
    clause: verdict.clause,
  };
}

/**
 * The retry counter, advanced in a transaction of its own and before the next attempt.
 *
 * Two reasons it is persisted rather than held in this loop, and both matter. The seed is the
 * counter, so a counter that did not move would ask the same question with the same key and the
 * cache would serve the same invalid envelope back for as long as anyone retried — a fixed point
 * at temperature zero. And a counter that lived only in memory would restart at zero after a
 * crash, so a re-run would repeat the whole budget instead of resuming it.
 *
 * The compare-and-set is on the state: a console that moved the ticket while the model was
 * answering wins, and this side stops rather than advancing a counter on a row it no longer owns.
 */
async function bumpRetries(orgId: string, ticketId: string, from: TicketState): Promise<number> {
  return withAppSession(componentClaims(orgId), async (client) => {
    const result = await client.query<{ retries: number }>(
      'update ticket set retries = retries + 1 where id = $1 and status = $2 returning retries',
      [ticketId, from],
    );
    if (result.rowCount !== 1) {
      throw new AppError('E_TRANSITION_STALE', 409, 'the ticket changed state while triage was running', {
        ticket_id: ticketId,
        expected_from: from,
      });
    }
    return result.rows[0].retries;
  });
}

type DecisionInput = {
  orgId: string;
  ticketId: string;
  action: DecisionAction;
  runtime: Awaited<ReturnType<typeof triageRuntimeFor>>;
  features: EscalationFeatures;
  now: number;
  reason: EscalationReason | null;
  clause: string | null;
  stage: 'record' | 'triage' | 'failure';
  code?: string;
  ledger?: string;
};

/**
 * The decision, as the chain records it.
 *
 * Every clause is here, fired or not, because the columns keep one reason and an audit needs the
 * rest — and because a reopened ticket escalated a second time overwrites the columns while the
 * chain keeps both. The ruleset digest is here because a verdict is only reproducible under the
 * rules that produced it.
 *
 * Not here: any part of the body, the subject, or the flags the matcher raised. The flags are
 * recomputed from the body and the published table by whoever needs them; putting them in an
 * append-only row would be the closest this system ever came to storing what a customer wrote in a
 * table nobody can edit.
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
    failure_code: input.code ?? null,
    ledger_row_hash: input.ledger ?? null,
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
 * edges against the same `from`. Retrying only the audit row would mean committing a verdict whose
 * record had failed, which is the one outcome this arrangement exists to prevent.
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
