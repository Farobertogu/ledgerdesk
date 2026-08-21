/**
 * The single point at which anything in this system speaks to a model.
 *
 * There is one of these and there is meant to be one of these. `ci/seam_check.mjs` enforces the
 * half of that sentence a check can enforce — no provider SDK may be imported from any other file
 * in the tree — and the design enforces the other half by leaving no second path: the redaction,
 * the canary, the ceiling, the cache and the ledger row are not five services an agent may compose
 * in the right order, they are one function, and calling the model *is* calling it.
 *
 * That is the whole argument for the shape of this file. A redactor that each agent invokes before
 * its own call is a redactor that the next agent forgets, and the guarantee degrades from a
 * property of the system to a property of whoever wrote the newest caller. Here the only way to
 * reach a provider is through a pipeline that has already redacted.
 *
 * ## The pipeline, in the order it runs
 *
 *  1. **Redact.** The call arrives with the raw body. It is redacted here and nowhere else, so
 *     that "the redacted body is the only body that travels" is true by construction rather than
 *     by convention. The knowledge-base excerpts go through the same pass.
 *  2. **Plant and clear the canary.** A synthetic address is planted in the tenant-side material of
 *     *this* call, and the redactor must remove it. If the marker is not where the canary was, the
 *     redactor did not fire on a value that was known to be personal, and the call is refused
 *     before anything leaves. This is an attestation per invocation, not a unit test that passed
 *     once: it measures the redactor on the same pass that is about to produce a payload.
 *  3. **Cache.** The digest of the redacted input, with the prompt version and the sampling
 *     parameters, is looked up in the chain. A hit answers from the response already recorded, with
 *     no provider call and no cost — which is also why the lookup precedes the ceiling: a call that
 *     spends nothing is not a call the ceiling has any business refusing.
 *  4. **Ceiling.** Consumption is recomputed from the chain, never from a counter this process
 *     holds, and the projected cost of the call is added to it. Over the cut, the call is refused
 *     with a typed error and no row is written, because no call was made.
 *  5. **Scan the egress.** The payload that is about to leave is serialised and searched for the
 *     canary token and for every literal the redactor removed. Anything found aborts the call
 *     before the provider is touched. Step 2 already makes the direct route impossible; this step
 *     is the net under the field somebody adds next year and forgets to route through the redactor.
 *  6. **Call, under a deadline.**
 *  7. **Scan the response.** The same two searches, on the way back. A response carrying the canary
 *     or a removed literal is never persisted.
 *  8. **Write the row.** One `agent_call` row, with the reproducibility block filled from what
 *     actually happened, linked into the chain.
 *
 * ## Where a row is written, and where one is not
 *
 * A row is written when, and only when, a response exists — freshly produced or served from the
 * chain. A refusal writes nothing: the eight columns that describe a model call have no honest
 * value for a call that was never made, `ledger_class` is closed at nine values and none of them
 * describes a refusal, and inventing one to hold this would be inventing a schema. The refusal is
 * typed, it is raised to the caller, and the caller — which owns the ticket and its audit trail —
 * is where it becomes visible.
 */

import { randomBytes } from 'node:crypto';

import {
  audToMicro,
  canonicalJson,
  digestOf,
  formatAud,
  formatConfidence,
  sha256Hex,
} from './canonical.ts';
import type { Json } from './canonical.ts';
import { GatewayError } from './errors.ts';
import { findLeak, marker, redact, withoutMarkers } from './redaction.ts';
import type { RedactionKind, Removal } from './redaction.ts';
import { stateHash } from './ledger/row.ts';
import type { LedgerRowContent } from './ledger/row.ts';
import type { LedgerHead, LedgerStore } from './ledger/store.ts';

// ---------------------------------------------------------------------------
// The provider contract
// ---------------------------------------------------------------------------

/**
 * The whole of what a provider is: one function from a typed request to a typed response.
 *
 * It is this narrow on purpose. Everything a provider might otherwise be trusted with — what may
 * be sent, what it costs, what is recorded, whether the call happens at all — is decided above it
 * by the pipeline, so a provider cannot widen the guarantees by being clever and cannot narrow them
 * by being careless. Swapping one for another is swapping one function.
 */
export interface ModelProvider {
  (request: ProviderRequest, options: ProviderOptions): Promise<ProviderResponse>;
}

export type Sampling = {
  temperature: number;
  top_p: number;
  max_tokens: number;
  stop?: readonly string[];
};

/** Exactly what leaves this process. Anything not on this object does not travel. */
export type ProviderRequest = {
  model: string;
  system: string;
  user: string;
  sampling: Sampling;
  seed: number | null;
};

export type ProviderOptions = {
  /** Aborted when the deadline passes. A provider that ignores it is still cut off by the race. */
  signal: AbortSignal;
};

export type ProviderResponse = {
  /** The id the RESPONSE carried, which is not necessarily the one that was asked for. */
  model: string;
  text: string;
  tokens_in: number;
  tokens_out: number;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Prices are held in Australian dollars per thousand tokens, and they are configuration. */
export type ModelPrice = {
  input_aud_per_1k: number;
  output_aud_per_1k: number;
};

/**
 * The ceiling, in the two figures the requirement carries: a cap that is never to be crossed and a
 * cut at which spending stops by itself. They are separate numbers because they answer separate
 * questions — the cut is where the breaker trips, the cap is the headroom that makes tripping at
 * the cut survivable.
 */
export type BudgetCeiling = {
  cap_aud: number;
  cut_aud: number;
  /** `run` measures this session; `term` measures everything the chain can see. */
  scope: 'run' | 'term';
};

export type GatewayConfig = {
  provider: ModelProvider;
  /** The pinned identity of the provider implementation. Travels into `toolchain.model_sdk`. */
  provider_id: string;
  store: LedgerStore;
  run_id: string;
  /** The three values whose digest is `state_hash`: two rows with different ones are incomparable. */
  state: { schema_version: string; ruleset_hash: string; kb_snapshot: string };
  toolchain: { app: string; ruleset: string };
  pricing: Record<string, ModelPrice>;
  budget: BudgetCeiling;
  timeout_ms?: number;
  /** How many times the process behind this gateway has been restarted, for the column of that name. */
  restarts?: number;
  cache?: boolean;
  now?: () => Date;
  /** Injectable so a test can pin the token. Never injected in production. */
  canary_token?: () => string;
};

export type CallingAgent = 'triage' | 'draft' | 'validate' | 'evolve';

export type KbExcerpt = { kb_id: string; excerpt: string };

export type GatewayCall = {
  agent: CallingAgent;
  org_id: string;
  ticket_id: string | null;
  prompt_version_id: string;
  /** The text of the registered prompt version. Its digest becomes `prompt_hash`. */
  prompt_text: string;
  /** The raw body. It is redacted here; no caller is trusted to have done it. */
  body: string;
  /** Values the tenant already knows are personal — a customer's name, an address on file. */
  literals?: readonly string[];
  kb_context?: readonly KbExcerpt[];
  locale: string;
  model_requested: string;
  sampling: Sampling;
  seed: number | null;
  /** The exact path of the input consumed, for the column that makes a replay possible. */
  input_path: string;
  split_id?: string | null;
  /** When true, a response from another model is an error and not merely a recorded fact. */
  pin_model?: boolean;
};

export type GatewayResult = {
  response_text: string;
  model_returned: string;
  /** The only body that travelled. Callers persist this; they never persist the raw one. */
  body_redacted: string;
  redaction: Record<RedactionKind, number>;
  cached: boolean;
  cost_aud: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  input_hash: string;
  ledger: { id: string; seq: number; row_hash: string };
};

export type Gateway = {
  call(request: GatewayCall): Promise<GatewayResult>;
};

// ---------------------------------------------------------------------------
// The canary
// ---------------------------------------------------------------------------

/**
 * The canary is planted in the shape of the thing it is testing.
 *
 * A token with a redaction rule of its own would prove only that the canary rule works. Planted as
 * an address, it is removed by the same rule that removes a customer's address, so its survival is
 * evidence about that rule and not about a rule written to make the test pass. The domain is the
 * reserved `.invalid`, which resolves nowhere by definition, so a canary that somehow escaped could
 * not become traffic.
 */
const CANARY_MARK = '\n<<ledgerdesk-canary>> ';

function canaryAddress(token: string): string {
  return `ld-canary-${token}@canary.invalid`;
}

function defaultCanaryToken(): string {
  return randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

/** Sampling as a total value, so its digest is defined whether or not `stop` was given. */
function samplingJson(sampling: Sampling): Json {
  return {
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    max_tokens: sampling.max_tokens,
    stop: sampling.stop ? [...sampling.stop] : null,
  };
}

/**
 * A token estimate, used only to decide whether a call may be made. Four characters to a token is
 * the usual rough figure and it is rough; it is never what is recorded, because what is recorded is
 * the count the provider reported.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function priceMicro(tokens: number, audPer1k: number): number {
  return Math.ceil((tokens * audToMicro(audPer1k)) / 1000);
}

/**
 * The confidence the response declared, if it declared one in the form the agent contract requires.
 *
 * The gateway does not validate the agent envelope — that is the agent's contract with its own
 * schema, and forcing it here would put a second, quieter validator in the path. What it does is
 * read the one field the ledger has a column for, and only when the field is unambiguous.
 */
function declaredConfidence(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as { confidence?: unknown }).confidence;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return formatConfidence(value);
}

// ---------------------------------------------------------------------------
// The gateway
// ---------------------------------------------------------------------------

export function createGateway(config: GatewayConfig): Gateway {
  if (!config.run_id) {
    throw new GatewayError('E_CONFIG_INVALID', 'the gateway has no run to write into');
  }
  if (!config.provider_id) {
    throw new GatewayError('E_CONFIG_INVALID', 'the provider is not identified, so nothing pins it');
  }
  if (!(config.budget.cut_aud > 0) || !(config.budget.cap_aud >= config.budget.cut_aud)) {
    throw new GatewayError(
      'E_CONFIG_INVALID',
      'the ceiling must cut at a positive amount, at or below the cap',
      { cap_aud: config.budget.cap_aud, cut_aud: config.budget.cut_aud },
    );
  }

  const timeoutMs = config.timeout_ms ?? 30_000;
  if (!(timeoutMs > 0)) {
    throw new GatewayError('E_CONFIG_INVALID', 'the deadline must be a positive number of ms');
  }

  const cacheEnabled = config.cache ?? true;
  const restarts = config.restarts ?? 0;
  const now = config.now ?? (() => new Date());
  const mintCanary = config.canary_token ?? defaultCanaryToken;
  const cutMicro = audToMicro(config.budget.cut_aud);

  // Computed once: neither the state nor the toolchain changes between calls of one process, and a
  // digest recomputed per call would invite the two to drift within a single run.
  const state_hash = stateHash(config.state);
  const toolchain: Json = {
    app: config.toolchain.app,
    node: process.versions.node,
    model_sdk: config.provider_id,
    ruleset: config.toolchain.ruleset,
  };

  async function call(request: GatewayCall): Promise<GatewayResult> {
    if (!request.input_path || !request.input_path.trim()) {
      throw new GatewayError(
        'E_INPUT_PATH_MISSING',
        'the call named no input path, so its row could not be replayed',
        { agent: request.agent, ticket_id: request.ticket_id },
      );
    }

    const price = config.pricing[request.model_requested];
    if (!price) {
      throw new GatewayError(
        'E_MODEL_PRICE_UNKNOWN',
        'no price is declared for the requested model, so the call could not be charged',
        { model_requested: request.model_requested },
      );
    }

    // --- 1 and 2 · redact, with the canary planted in this very pass -------------------------
    const canaryToken = mintCanary();
    const planted = `${request.body}${CANARY_MARK}${canaryAddress(canaryToken)}`;
    const redacted = redact(planted, request.literals ?? []);

    const expectedTail = `${CANARY_MARK}${marker('email')}`;
    if (!redacted.text.endsWith(expectedTail)) {
      throw new GatewayError(
        'E_CANARY_NOT_REDACTED',
        'the canary planted in this call survived the redactor, so nothing was sent',
        { agent: request.agent, ticket_id: request.ticket_id },
      );
    }
    const body_redacted = redacted.text.slice(0, redacted.text.length - expectedTail.length);

    // A body that redacted to markers and whitespace has not been redacted, it has been emptied,
    // and there is no enquiry left to answer. It is refused here so the caller can escalate it to
    // a person, which is the only correct destination for a ticket with nothing in it.
    if (!withoutMarkers(body_redacted).trim()) {
      throw new GatewayError(
        'E_EMPTY_AFTER_REDACTION',
        'nothing survived redaction, so there is no body to send',
        { agent: request.agent, ticket_id: request.ticket_id },
      );
    }

    // The excerpts take the same pass. They come from the knowledge base rather than from the
    // customer, which is a reason to expect them clean and not a reason to exempt them.
    const removals: Removal[] = [...redacted.removed];
    // The canary is not the tenant's data and is not counted as though it were. The pass above
    // removed exactly one address this call planted itself, and the published summary — which ends
    // up in the row and on a privacy panel — describes the ticket, not the instrumentation.
    const counts = { ...redacted.counts, email: redacted.counts.email - 1 };
    const kb_context = (request.kb_context ?? []).map((entry) => {
      const pass = redact(entry.excerpt, request.literals ?? []);
      removals.push(...pass.removed);
      for (const kind of Object.keys(pass.counts) as RedactionKind[]) {
        counts[kind] += pass.counts[kind];
      }
      return { kb_id: entry.kb_id, excerpt: pass.text };
    });

    // --- 3 · the input, its digest, and the cache --------------------------------------------
    //
    // The envelope always carries `kb_context`, as an empty array when there is none. A digest
    // needs a total function, and letting "absent" and "empty" produce two digests would split the
    // cache of a call that is the same call.
    const envelope: Json = {
      schema_version: '1.0',
      agent: request.agent,
      prompt_version_id: request.prompt_version_id,
      ticket_id: request.ticket_id,
      body_redacted,
      kb_context: kb_context.map((entry) => ({ kb_id: entry.kb_id, excerpt: entry.excerpt })),
      locale: request.locale,
    };
    const input_hash = digestOf(envelope);
    const prompt_hash = sha256Hex(request.prompt_text);
    const sampling = samplingJson(request.sampling);

    if (cacheEnabled) {
      const startedAt = performance.now();
      const hit = await config.store.findCached(request.org_id, {
        input_hash,
        prompt_version_id: request.prompt_version_id,
        prompt_hash,
        model_requested: request.model_requested,
        sampling,
        seed: request.seed,
      });
      if (hit) {
        // The same two searches a fresh response gets. The text was cleared once already, when it
        // was first written; it is cleared again here because the call it is answering is a
        // different call, with its own canary and its own list of removed values.
        assertResponseIsClean(hit.response_text, canaryToken, removals, request);

        const latency_ms = Math.max(0, Math.round(performance.now() - startedAt));
        const appended = await config.store.append(config.run_id, request.org_id, (head) =>
          buildRow(head, {
            request,
            input_hash,
            prompt_hash,
            sampling,
            model_returned: hit.model_returned,
            response_hash: hit.response_hash,
            response_text: hit.response_text,
            tokens_in: 0,
            tokens_out: 0,
            cost_micro: 0,
            latency_ms,
            counts,
            confidence: hit.confidence,
            cache: { hit: true, source_seq: hit.seq },
          }),
        );

        return {
          response_text: hit.response_text,
          model_returned: hit.model_returned,
          body_redacted,
          redaction: counts,
          cached: true,
          cost_aud: formatAud(0),
          tokens_in: 0,
          tokens_out: 0,
          latency_ms,
          input_hash,
          ledger: { id: appended.id, seq: appended.seq, row_hash: appended.row_hash },
        };
      }
    }

    // --- 4 · the ceiling, recomputed from the chain --------------------------------------------
    const scope = { run_id: config.budget.scope === 'run' ? config.run_id : null };
    const spentMicro = await config.store.spentMicroAud(request.org_id, scope);

    const system = request.prompt_text;
    const user = renderUserMessage(body_redacted, kb_context);

    // The projection uses `max_tokens` for the response, which is the most the call can cost. A
    // breaker that projected an average would trip after the cut rather than at it.
    const projectedMicro =
      spentMicro +
      priceMicro(estimateTokens(system) + estimateTokens(user), price.input_aud_per_1k) +
      priceMicro(request.sampling.max_tokens, price.output_aud_per_1k);

    if (spentMicro >= cutMicro || projectedMicro > cutMicro) {
      throw new GatewayError(
        'E_BUDGET_EXHAUSTED',
        'the call would take consumption past the cut, so it was not made',
        {
          spent_aud: formatAud(spentMicro),
          projected_aud: formatAud(projectedMicro),
          cut_aud: formatAud(cutMicro),
          scope: config.budget.scope,
        },
      );
    }

    // --- 5 · what is about to leave, searched before it leaves ---------------------------------
    const providerRequest: ProviderRequest = {
      model: request.model_requested,
      system,
      user,
      sampling: request.sampling,
      seed: request.seed,
    };
    const outbound = canonicalJson({
      model: providerRequest.model,
      system: providerRequest.system,
      user: providerRequest.user,
      sampling,
      seed: providerRequest.seed,
    });

    if (outbound.includes(canaryToken)) {
      throw new GatewayError(
        'E_CANARY_EGRESS',
        'the canary was found in the payload, so the payload was not sent',
        { agent: request.agent, ticket_id: request.ticket_id },
      );
    }
    const leaking = findLeak(outbound, removals);
    if (leaking) {
      throw new GatewayError(
        'E_PII_EGRESS',
        'a redacted value was found in the payload, so the payload was not sent',
        { agent: request.agent, ticket_id: request.ticket_id, kind: leaking.kind },
      );
    }

    // --- 6 · the call, under a deadline ---------------------------------------------------------
    const startedAt = performance.now();
    const response = await callProvider(config.provider, providerRequest, timeoutMs);
    const latency_ms = Math.max(0, Math.round(performance.now() - startedAt));

    // --- 7 · the response, searched before it is persisted --------------------------------------
    assertResponseIsClean(response.text, canaryToken, removals, request);

    // --- 8 · the row ----------------------------------------------------------------------------
    const cost_micro =
      priceMicro(response.tokens_in, price.input_aud_per_1k) +
      priceMicro(response.tokens_out, price.output_aud_per_1k);
    const response_hash = sha256Hex(response.text);

    const appended = await config.store.append(config.run_id, request.org_id, (head) =>
      buildRow(head, {
        request,
        input_hash,
        prompt_hash,
        sampling,
        model_returned: response.model,
        response_hash,
        response_text: response.text,
        tokens_in: response.tokens_in,
        tokens_out: response.tokens_out,
        cost_micro,
        latency_ms,
        counts,
        confidence: declaredConfidence(response.text),
        cache: { hit: false, source_seq: null },
      }),
    );

    // The row is written first and the pin raises after it, in that order and not the other. A
    // model that answered under another name still answered, still cost money and still produced
    // the text a reader may later need to account for; refusing to record it would hide the very
    // event the pin exists to make visible.
    if (request.pin_model && response.model !== request.model_requested) {
      throw new GatewayError(
        'E_MODELO_INESPERADO',
        'the response carried a model other than the one pinned; the row is written',
        {
          model_requested: request.model_requested,
          model_returned: response.model,
          ledger_row_hash: appended.row_hash,
          ledger_seq: appended.seq,
        },
      );
    }

    return {
      response_text: response.text,
      model_returned: response.model,
      body_redacted,
      redaction: counts,
      cached: false,
      cost_aud: formatAud(cost_micro),
      tokens_in: response.tokens_in,
      tokens_out: response.tokens_out,
      latency_ms,
      input_hash,
      ledger: { id: appended.id, seq: appended.seq, row_hash: appended.row_hash },
    };
  }

  type RowFacts = {
    request: GatewayCall;
    input_hash: string;
    prompt_hash: string;
    sampling: Json;
    model_returned: string;
    response_hash: string;
    response_text: string;
    tokens_in: number;
    tokens_out: number;
    cost_micro: number;
    latency_ms: number;
    counts: Record<RedactionKind, number>;
    confidence: string | null;
    cache: { hit: boolean; source_seq: number | null };
  };

  function buildRow(head: LedgerHead | null, facts: RowFacts): LedgerRowContent {
    const { request } = facts;
    return {
      run_id: config.run_id,
      seq: (head?.seq ?? 0) + 1,
      org_id: request.org_id,
      ticket_id: request.ticket_id,
      agent: request.agent,
      prompt_version_id: request.prompt_version_id,
      model_requested: request.model_requested,
      model_returned: facts.model_returned,
      sampling: facts.sampling,
      seed: request.seed,
      input_hash: facts.input_hash,
      input_path: request.input_path,
      prompt_hash: facts.prompt_hash,
      response_hash: facts.response_hash,
      state_hash,
      split_id: request.split_id ?? null,
      toolchain,
      restarts,
      tokens_in: facts.tokens_in,
      tokens_out: facts.tokens_out,
      cost_aud: formatAud(facts.cost_micro),
      latency_ms: facts.latency_ms,
      cum_tokens: (head?.cum_tokens ?? 0) + facts.tokens_in + facts.tokens_out,
      class: 'agent_call',
      output: {
        response: facts.response_text,
        // Counts and kinds, never the values: the row is read by the quality side and shown on a
        // privacy panel, and neither of those is a place for the customer's address.
        redaction: { ...facts.counts },
        // The canary is not named here either. What the row records is that it cleared.
        canary: 'cleared',
        cache: { hit: facts.cache.hit, source_seq: facts.cache.source_seq },
      },
      confidence: facts.confidence,
      ts: now().toISOString(),
    };
  }

  return { call };
}

/**
 * The user message: the redacted body, and the excerpts the call was allowed to cite.
 *
 * Kept as one function so that the string the provider receives has exactly one author. A caller
 * that assembled its own would be assembling something the redactor never saw.
 */
function renderUserMessage(body: string, kb: readonly KbExcerpt[]): string {
  if (kb.length === 0) return body;
  const sources = kb.map((entry) => `[${entry.kb_id}] ${entry.excerpt}`).join('\n');
  return `${body}\n\n--- sources ---\n${sources}`;
}

async function callProvider(
  provider: ModelProvider,
  request: ProviderRequest,
  timeoutMs: number,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new GatewayError('E_PROVIDER_TIMEOUT', 'the provider did not answer inside the deadline', {
          timeout_ms: timeoutMs,
        }),
      );
    }, timeoutMs);
  });

  try {
    // The race, and not the signal alone: a provider that never looks at the signal would otherwise
    // hold the call open for as long as it liked.
    const response = await Promise.race([provider(request, { signal: controller.signal }), deadline]);
    assertProviderResponse(response);
    return response;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('E_PROVIDER_FAILED', 'the provider call failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A response is persisted only after it has been shown to carry neither the canary nor any value
 * the redactor removed on the way out. Both are exact-string searches, so neither can produce the
 * false positive a pattern rerun would.
 */
function assertResponseIsClean(
  text: string,
  canaryToken: string,
  removals: readonly Removal[],
  request: GatewayCall,
): void {
  if (text.includes(canaryToken)) {
    throw new GatewayError(
      'E_CANARY_IN_RESPONSE',
      'the response carried the canary, so it was not persisted',
      { agent: request.agent, ticket_id: request.ticket_id },
    );
  }
  const returning = findLeak(text, removals);
  if (returning) {
    throw new GatewayError(
      'E_PII_IN_RESPONSE',
      'the response carried a redacted value, so it was not persisted',
      { agent: request.agent, ticket_id: request.ticket_id, kind: returning.kind },
    );
  }
}

function assertProviderResponse(value: unknown): asserts value is ProviderResponse {
  const candidate = value as Partial<ProviderResponse> | null;
  if (
    !candidate ||
    typeof candidate.model !== 'string' ||
    typeof candidate.text !== 'string' ||
    !Number.isInteger(candidate.tokens_in) ||
    !Number.isInteger(candidate.tokens_out)
  ) {
    throw new GatewayError(
      'E_PROVIDER_FAILED',
      'the provider answered with something that is not a response',
    );
  }
}
