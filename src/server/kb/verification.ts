/**
 * The re-run, and the closure it earns.
 *
 * ## What is re-run is the QUERY, not the ticket
 *
 * A gap record stores the terms it was opened against, and this asks exactly those terms again under
 * the snapshot in force. Re-running the ticket would be a second producer of the question: a subject
 * edited in between, a body redacted differently, and the closure becomes a different search that
 * happened to succeed. `query_sha256` is a digest of the terms and the snapshot together precisely
 * so that "the same question, under the corpus that has moved" is a statement with a value behind it.
 *
 * ## It inserts an answer and it does not touch the ticket
 *
 * A new `response` row, never an update of the one before it, so both halves of the corrected cycle
 * stay readable side by side — which is the whole of the closing act. And no transition: the ticket
 * went to a person when the gap opened and it is that person's to move. A verifier that quietly
 * pulled an escalated ticket back would be undoing somebody's queue while they were reading it.
 *
 * ## Why "it found something" is not the test
 *
 * Measured on this corpus rather than reasoned about: with the admitted document in place, the query
 * that opened the gap also matches an unrelated article well above the relevance floor. A closure
 * conditioned on the re-run returning anything would therefore pass by accident here, and would
 * demonstrate exactly the failure nobody in the room could distinguish from success — an answer that
 * looks anchored and is anchored on something else.
 *
 * So the closure is conditioned on the **admitted key** appearing among the citations, and the check
 * lives inside the database function rather than here. Identity cannot be used for it: an advance
 * mints a new identity for every row it copies, so the article that answers the gap afterwards is a
 * different row from anything that existed when the gap was opened. The canonical key is copied
 * verbatim across the advance and its shape is constrained, which is what makes it the thing that
 * survives.
 *
 * **And the key is not passed to the closure — it is derived inside it.** This file reads the
 * admitted key to report what closed the gap and to tell an operator that nothing has been admitted
 * yet; it does not hand that value to the function, because a function that accepted it would close
 * a gap "on the admitted source" against whatever key its caller named. The database derives the key
 * from the admission's own article. What travels is a gap and an answer, and nothing else.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { GatewayError } from '@agents/errors.ts';
import type { KbExcerpt } from '@agents/gateway.ts';
import { parseDraftEnvelope } from '@agents/draft/envelope.ts';
import { DRAFT_PROMPT_TEXT } from '@agents/draft/prompt.ts';
import { evaluateGrounding } from '@agents/grounding.ts';
import { AgentError } from '@agents/triage/errors.ts';
import { EXCERPT_MAX } from '@agents/triage/schema.ts';
import { parseValidateEnvelope } from '@agents/validate/envelope.ts';
import { VALIDATE_PROMPT_TEXT } from '@agents/validate/prompt.ts';

import type { RetrievalOutcome, RetrievedSource } from '@/alg/retrieval';
import {
  DRAFT_SAMPLING,
  VALIDATE_SAMPLING,
  refuseIfRuntimeIsStale,
  runtimeFor,
} from '@/server/agents';
import { withAppSession, type Claims } from '@/server/db';
import { AppError } from '@/server/errors';
import { requireSnapshotHead, retrieveTerms } from '@/server/kb/retrieval';
import { onRun } from '@/server/run_queue';

export type VerificationOutcome =
  /** The corpus answered, the answer cites the admitted key, and the gap is closed. */
  | {
      outcome: 'CLOSED';
      gap_id: string;
      response_id: string;
      kb_snapshot: string;
      citations: number;
      canonical_key: string;
    }
  /** The re-run happened and the gap stays open. The answer, if there is one, is recorded anyway. */
  | {
      outcome: 'STILL_OPEN';
      gap_id: string;
      response_id: string | null;
      kb_snapshot: string;
      retrieval: RetrievalOutcome['kind'];
      /** Why it did not close, in the words a person needs. */
      because: string;
    }
  /** The system could not try. Nothing was written and the gap is untouched. */
  | { outcome: 'ABANDONED'; gap_id: string; code: string };

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

const GAP = `
  select g.id, g.org_id, g.ticket_id, g.state::text as state, g.kb_snapshot, g.query_terms,
         t.language
    from kb_gap g join ticket t on t.id = g.ticket_id
   where g.id = $1::uuid`;

const ADMITTED_KEY = `
  select a.canonical_key, m.snapshot_to
    from kb_admission m join kb_article a on a.id = m.article_id and a.kb_snapshot = m.snapshot_to
   where m.gap_id = $1::uuid
   order by m.admitted_at desc
   limit 1`;

const INSERT_RESPONSE = `
  insert into response (id, ticket_id, draft, kb_snapshot, grounded, validated_at,
                        draft_ledger_ref, validate_ledger_ref, unsupported_claims)
  values ($1::uuid, $2::uuid, $3, $4, $5, now(), $6::bigint, $7::bigint, $8::jsonb)`;

const INSERT_CITATION = `
  insert into response_citation (response_id, kb_article_id, kb_snapshot)
  values ($1::uuid, $2::uuid, $3)`;

const CLOSE = `select kb_gap_close_by_verification($1::uuid, $2::uuid)`;

type GapRow = {
  id: string;
  org_id: string;
  ticket_id: string;
  state: string;
  kb_snapshot: string;
  query_terms: string;
  language: string;
};

/**
 * Re-runs the question one gap was opened against, and closes it if the answer earns it.
 *
 * Behind the run's own queue, like every other cycle: the chain is per run and two writers on one
 * run contend for its head.
 */
export async function verifyGap(claims: Claims, gapId: string): Promise<VerificationOutcome> {
  const runtime = await runtimeFor(claims.org_id);
  return onRun(runtime.run_id, () => verify(claims, gapId));
}

async function verify(claims: Claims, gapId: string): Promise<VerificationOutcome> {
  const orgId = claims.org_id;
  const runtime = await runtimeFor(orgId);

  const snapshot = await requireSnapshotHead(orgId);
  refuseIfRuntimeIsStale(runtime, snapshot);

  const gap = await withAppSession(claims, async (client) => {
    const found = await client.query<GapRow>(GAP, [gapId]);
    return found.rows[0] ?? null;
  });

  if (!gap) {
    throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no gap with that id is visible to this session', {
      gap_id: gapId,
    });
  }
  if (gap.state !== 'OPEN') {
    return {
      outcome: 'STILL_OPEN',
      gap_id: gap.id,
      response_id: null,
      kb_snapshot: snapshot,
      retrieval: 'zero_match',
      because: `this gap is ${gap.state}, so there is nothing to verify`,
    };
  }

  // The key the closure will be checked against, read from the admission that answered this gap.
  // Absent means nothing has been admitted yet, and re-running would spend two model calls to learn
  // what one query already says.
  const admitted = await withAppSession(claims, async (client) => {
    const found = await client.query<{ canonical_key: string; snapshot_to: string }>(ADMITTED_KEY, [
      gap.id,
    ]);
    return found.rows[0] ?? null;
  });

  if (!admitted) {
    return {
      outcome: 'STILL_OPEN',
      gap_id: gap.id,
      response_id: null,
      kb_snapshot: snapshot,
      retrieval: 'zero_match',
      because: 'no material has been admitted against this gap, so the corpus has not changed',
    };
  }

  const found = await retrieveTerms({
    orgId,
    // The terms the record stored, not terms recomposed from the ticket. See the header.
    terms: gap.query_terms,
    snapshot,
    excerptMax: EXCERPT_MAX,
  });

  if (found.kind !== 'hits') {
    return {
      outcome: 'STILL_OPEN',
      gap_id: gap.id,
      response_id: null,
      kb_snapshot: snapshot,
      retrieval: found.kind,
      because: 'the same question still matches nothing in the corpus at the snapshot in force',
    };
  }

  const sources = found.sources;
  const kb_context: KbExcerpt[] = sources.map((source) => ({
    kb_id: source.kb_id,
    excerpt: source.excerpt,
  }));
  const responseId = randomUUID();

  let draft;
  try {
    draft = await runtime.gateway.call({
      agent: 'draft',
      org_id: orgId,
      ticket_id: gap.ticket_id,
      prompt_version_id: runtime.prompts.draft,
      prompt_text: DRAFT_PROMPT_TEXT,
      body: gap.query_terms,
      literals: [],
      kb_context,
      locale: gap.language,
      model_requested: runtime.models.draft,
      sampling: { ...DRAFT_SAMPLING },
      seed: 0,
      input_path: `db://kb_gap/${gap.id}#query_terms+kb/${snapshot}`,
      pin_model: true,
    });
  } catch (error) {
    if (error instanceof GatewayError && SYSTEMIC.has(error.code)) {
      return { outcome: 'ABANDONED', gap_id: gap.id, code: error.code };
    }
    throw error;
  }

  let text: string;
  let citations: readonly string[];
  try {
    const envelope = parseDraftEnvelope(draft.response_text, draft.kb_context_redacted);
    text = envelope.draft.text;
    citations = envelope.draft.kb_ids;
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    return {
      outcome: 'STILL_OPEN',
      gap_id: gap.id,
      response_id: null,
      kb_snapshot: snapshot,
      retrieval: found.kind,
      because: `the answer did not satisfy the published contract (${error.code})`,
    };
  }

  let verdictResult;
  try {
    verdictResult = await runtime.gateway.call({
      agent: 'validate',
      org_id: orgId,
      ticket_id: gap.ticket_id,
      prompt_version_id: runtime.prompts.validate,
      prompt_text: VALIDATE_PROMPT_TEXT,
      body: text,
      literals: [],
      kb_context,
      locale: gap.language,
      model_requested: runtime.models.validate,
      sampling: { ...VALIDATE_SAMPLING },
      seed: 0,
      input_path: `db://kb_gap/${gap.id}#rerun/${responseId}+kb/${snapshot}`,
      pin_model: true,
    });
  } catch (error) {
    if (error instanceof GatewayError && SYSTEMIC.has(error.code)) {
      return { outcome: 'ABANDONED', gap_id: gap.id, code: error.code };
    }
    throw error;
  }

  let modelSaysGrounded = false;
  let unsupported: readonly string[] = [];
  try {
    const verdict = parseValidateEnvelope(verdictResult.response_text);
    modelSaysGrounded = verdict.validate.grounded;
    unsupported = verdict.validate.unsupported_claims;
  } catch (error) {
    if (!(error instanceof AgentError)) throw error;
    modelSaysGrounded = false;
  }

  const grounding = evaluateGrounding({
    sources: draft.kb_context_redacted.map((entry) => ({ kb_id: entry.kb_id, excerpt: entry.excerpt })),
    citations,
    draftText: text,
    modelSaysGrounded,
  });

  const cited = sources.filter((source) => citations.includes(source.kb_id));

  // The answer is recorded whether or not it closes anything: a re-run that produced an ungrounded
  // reply is a fact about the corpus after the admission, and losing it would leave the record of
  // the cycle claiming the re-run never happened.
  await withAppSession(claims, async (client) => {
    await writeResponse(client, {
      responseId,
      ticketId: gap.ticket_id,
      text,
      snapshot,
      grounded: grounding.grounded,
      draftRef: draft.ledger.id,
      validateRef: verdictResult.ledger.id,
      cited,
      unsupported,
    });
  });

  if (!grounding.grounded) {
    return {
      outcome: 'STILL_OPEN',
      gap_id: gap.id,
      response_id: responseId,
      kb_snapshot: snapshot,
      retrieval: found.kind,
      because: 'the re-run produced an answer the grounding conjunction does not accept',
    };
  }

  // The closure. Every one of its four conditions is checked inside the function, against rows, so a
  // caller that got here holding a wrong belief is refused by the database rather than believed.
  try {
    await withAppSession(claims, async (client) => {
      await client.query(CLOSE, [gap.id, responseId]);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'STILL_OPEN',
      gap_id: gap.id,
      response_id: responseId,
      kb_snapshot: snapshot,
      retrieval: found.kind,
      because: `the closure was refused: ${message}`,
    };
  }

  return {
    outcome: 'CLOSED',
    gap_id: gap.id,
    response_id: responseId,
    kb_snapshot: snapshot,
    citations: cited.length,
    canonical_key: admitted.canonical_key,
  };
}

async function writeResponse(
  client: PoolClient,
  input: {
    responseId: string;
    ticketId: string;
    text: string;
    snapshot: string;
    grounded: boolean;
    draftRef: string;
    validateRef: string;
    cited: readonly RetrievedSource[];
    unsupported: readonly string[];
  },
): Promise<void> {
  await client.query(INSERT_RESPONSE, [
    input.responseId,
    input.ticketId,
    input.text,
    input.snapshot,
    input.grounded,
    input.draftRef,
    input.validateRef,
    JSON.stringify(input.unsupported),
  ]);

  for (const source of input.cited) {
    await client.query(INSERT_CITATION, [input.responseId, source.article_id, input.snapshot]);
  }
}
