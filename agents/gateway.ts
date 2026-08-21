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
 *  2. **Plant and clear the canaries.** One synthetic value per shaped rule in the dictionary is
 *     planted in the tenant-side material of *this* call, and the redactor must remove all of them.
 *     If the tail is not exactly the markers those values should have become, some rule did not
 *     fire on a value of its own kind, and the call is refused before anything leaves. A single
 *     canary would have attested to a single rule; this attests to the dictionary, per invocation.
 *  3. **Cache.** The digest of the redacted input, with the prompt version, the prompt text, the
 *     state and the sampling parameters, is looked up in the chain. A hit answers from the response
 *     already recorded, with no provider call and no cost — which is also why the lookup precedes
 *     the ceiling: a call that spends nothing is not a call the ceiling has any business refusing.
 *  4. **Ceiling.** Consumption is recomputed from the chain, never from a counter this process
 *     holds, plus what this process has committed to and not yet recorded. Over the cut, the call
 *     is refused with a typed error and no row is written, because no call was made.
 *  5. **Scan the egress.** The object that is about to be handed across is serialised whole and
 *     searched for every canary and for every literal the redactor removed. Anything found aborts
 *     the call before the provider is touched. Step 2 already makes the direct route impossible;
 *     this step is the net under the field somebody adds next year and forgets to redact.
 *  6. **Call, under a deadline.**
 *  7. **Scan the response.** The same two searches, on the way back. A response carrying a canary
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
 *
 * **The case that rule does not cover, named rather than left to be discovered.** A call whose
 * deadline passes may have been completed and billed on the far side, and there is no row to say
 * so: the chain would under-count real consumption, and a ceiling recomputed from the chain would
 * cut late by that much, cumulatively. What this file does about it is hold the projection against
 * the ceiling for the life of the process instead of releasing it — the error is then always the
 * conservative one. What it cannot do is survive a restart, because the only honest home for
 * "a call was attempted and its outcome is unknown" is a row, and no value of `ledger_class` says
 * that. Opening the alphabet a tenth time is a dated decision, not a builder's choice.
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
import type { AuditSink } from './audit.ts';
import { CANARY_CONTRIBUTION, plant, survivingKinds } from './canary.ts';
import { GatewayError } from './errors.ts';
import type { GatewayErrorCode } from './errors.ts';
import { MIN_LITERAL_LENGTH, findLeak, redact, withoutMarkers } from './redaction.ts';
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
  /**
   * Where the security events go. Not optional: a sink a caller may leave out is a sink the next
   * caller leaves out, and what vanishes then is exactly the record nobody would notice missing.
   */
  audit: AuditSink;
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

/**
 * The codes that are security events rather than operational ones.
 *
 * The first five are the controls of this component firing: the redactor stopped working, or
 * something was caught on its way out, or on its way back. The sixth is the ceiling cutting, which
 * is not a failure of a control but is the kind of fact an operator has to be able to find later
 * without reading a process log that has since rotated.
 *
 * What is deliberately absent: `E_PROVIDER_FAILED` and `E_PROVIDER_TIMEOUT` (the far side had a bad
 * day, which is operational), `E_LEDGER_WRITE_FAILED` (likewise, and filing it through the same
 * database that just refused a write is a poor plan), and the three configuration codes, which are
 * defects in a caller and are found by the caller failing.
 */
const SECURITY_EVENTS: ReadonlySet<GatewayErrorCode> = new Set<GatewayErrorCode>([
  'E_CANARY_NOT_REDACTED',
  'E_CANARY_EGRESS',
  'E_PII_EGRESS',
  'E_CANARY_IN_RESPONSE',
  'E_PII_IN_RESPONSE',
  'E_BUDGET_EXHAUSTED',
]);

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

  // The three components of `state_hash` are required and required to be non-empty. The column
  // exists so that two rows carrying the same `input_hash` under different conditions are known to
  // be incomparable, and a component left as the empty string makes every run agree about a
  // condition none of them declared. Where there is no knowledge base yet, the honest value is the
  // sentinel `kb:none` — a value that says so, not an absence that says nothing.
  for (const key of ['schema_version', 'ruleset_hash', 'kb_snapshot'] as const) {
    if (!config.state[key] || !config.state[key].trim()) {
      throw new GatewayError(
        'E_CONFIG_INVALID',
        `state.${key} is empty, so state_hash would describe a condition nobody declared`,
        { component: key },
      );
    }
  }

  const cacheEnabled = config.cache ?? true;
  const restarts = config.restarts ?? 0;
  const now = config.now ?? (() => new Date());
  const mintCanary = config.canary_token ?? defaultCanaryToken;
  const cutMicro = audToMicro(config.budget.cut_aud);

  /**
   * What this process has committed to spending but has not yet recorded.
   *
   * The chain is the authority on what was spent, and it can only become the authority once a row
   * is written — which is after the provider has answered. Between the ceiling check and that row
   * there is a window, and two calls crossing it together would each read a consumption figure that
   * did not include the other. Each would be under the cut; together they could be over it, and the
   * money is gone before either row exists.
   *
   * So a call reserves its projection here before it leaves and releases it when its row is in the
   * chain. Within one process the ceiling is then exact under any concurrency. Across processes it
   * is not, and the bound is stated rather than implied: the overshoot cannot exceed the number of
   * processes writing to the run, less one, times the largest projection among them. That bound is
   * what the requirement's two figures are for — the cut is where spending stops, the cap is the
   * headroom that absorbs what was already in flight when it did.
   */
  let inFlightMicro = 0;

  // Computed once: neither the state nor the toolchain changes between calls of one process, and a
  // digest recomputed per call would invite the two to drift within a single run.
  const state_hash = stateHash(config.state);
  const toolchain: Json = {
    app: config.toolchain.app,
    node: process.versions.node,
    model_sdk: config.provider_id,
    ruleset: config.toolchain.ruleset,
  };

  async function run(request: GatewayCall): Promise<GatewayResult> {
    // Literals are refused, not silently dropped. Before this, a caller passing a value below the
    // threshold got a redactor that quietly ignored it — a fail-open where the caller believed a
    // value was covered and it was not, which is the worst shape a privacy control can take.
    for (const literal of request.literals ?? []) {
      if (literal.trim().length < MIN_LITERAL_LENGTH) {
        throw new GatewayError(
          'E_CONFIG_INVALID',
          `a literal shorter than ${MIN_LITERAL_LENGTH} characters is refused rather than ignored`,
          { literal_length: literal.trim().length, minimum: MIN_LITERAL_LENGTH },
        );
      }
    }

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

    // --- 1 and 2 · redact, with a canary per rule planted in this very pass -------------------
    const canaryToken = mintCanary();
    const canaries = plant(canaryToken);
    const redacted = redact(`${request.body}${canaries.block}`, request.literals ?? []);

    if (!redacted.text.endsWith(canaries.expectedTail)) {
      // The tail comparison is the verdict; this call is only to name the rule, so the error can
      // say which pattern stopped firing instead of leaving an operator to bisect the dictionary.
      throw new GatewayError(
        'E_CANARY_NOT_REDACTED',
        'a canary planted in this call survived the redactor, so nothing was sent',
        {
          agent: request.agent,
          ticket_id: request.ticket_id,
          kinds: survivingKinds(redacted.text, canaryToken),
        },
      );
    }
    const body_redacted = redacted.text.slice(
      0,
      redacted.text.length - canaries.expectedTail.length,
    );

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
    // The canaries are not the tenant's data and are not counted as though they were. The pass
    // above removed exactly the values this call planted itself, and the published summary — which
    // ends up in the row and on a privacy panel — describes the ticket, not the instrumentation.
    const counts = { ...redacted.counts };
    for (const kind of Object.keys(counts) as RedactionKind[]) {
      counts[kind] -= CANARY_CONTRIBUTION[kind] ?? 0;
    }
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
        state_hash,
        model_requested: request.model_requested,
        sampling,
        seed: request.seed,
      });
      if (hit) {
        // The same two searches a fresh response gets. The text was cleared once already, when it
        // was first written; it is cleared again here because the call it is answering is a
        // different call, with its own canary and its own list of removed values.
        assertResponseIsClean(hit.response_text, [canaryToken, ...canaries.values], removals, request);

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
    const callMicro =
      priceMicro(estimateTokens(system) + estimateTokens(user), price.input_aud_per_1k) +
      priceMicro(request.sampling.max_tokens, price.output_aud_per_1k);
    const committedMicro = spentMicro + inFlightMicro;
    const projectedMicro = committedMicro + callMicro;

    if (committedMicro >= cutMicro || projectedMicro > cutMicro) {
      throw new GatewayError(
        'E_BUDGET_EXHAUSTED',
        'the call would take consumption past the cut, so it was not made',
        {
          spent_aud: formatAud(spentMicro),
          in_flight_aud: formatAud(inFlightMicro),
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
    // Serialised from the object that is about to be handed across, and not rebuilt field by field
    // from the values that went into it. The difference is the whole value of the step: a field
    // added to `ProviderRequest` next year — a subject line, a tool list, a metadata bag — is
    // covered by this scan the moment it exists, whereas a hand-listed projection would have gone
    // on passing while the new field carried whatever it carried. `JSON.stringify` reaches every
    // string at every depth, which is the property required here; the canonical form is not, since
    // nothing downstream compares this text to anything.
    const outbound = JSON.stringify(providerRequest);

    for (const value of [canaryToken, ...canaries.values]) {
      if (outbound.includes(value)) {
        throw new GatewayError(
          'E_CANARY_EGRESS',
          'a canary was found in the payload, so the payload was not sent',
          { agent: request.agent, ticket_id: request.ticket_id },
        );
      }
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
    //
    // The reservation is taken before the request leaves and is given back only when the outcome is
    // known. A deadline that passes is not an outcome: the provider may have completed the work and
    // billed for it, and this side cannot tell. Money that may have been spent and cannot be
    // recorded is held against the ceiling for the life of the process rather than forgotten, so
    // the error the ceiling makes is always the conservative one. A provider that refused the
    // request outright did not run it, and that reservation is released.
    inFlightMicro += callMicro;
    let response: ProviderResponse;
    const startedAt = performance.now();
    try {
      response = await callProvider(config.provider, providerRequest, timeoutMs);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== 'E_PROVIDER_TIMEOUT') {
        // The provider function threw without producing a response, so nothing was generated and
        // nothing was billed. Holding this against the ceiling would leak budget on every
        // connection that was refused.
        inFlightMicro -= callMicro;
        throw error;
      }
      error.detail.unrecorded_aud = formatAud(callMicro);
      throw error;
    }
    const latency_ms = Math.max(0, Math.round(performance.now() - startedAt));

    // --- 7 · the response, searched before it is persisted --------------------------------------
    assertResponseIsClean(response.text, [canaryToken, ...canaries.values], removals, request);

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

    // The reservation is given back here and only here: from this line on the chain carries the
    // real figure, so holding the projection as well would count the call twice. Every path that
    // leaves before this point keeps it, because every one of them is a path where the provider
    // answered — or may have — and no row says so.
    inFlightMicro -= callMicro;

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

  /**
   * The ceiling cutting is worth recording once per run, not once per refusal.
   *
   * After the breaker trips, every subsequent call is refused by the same fact. Filing each one
   * would turn the audit chain — which is append-only, so nothing can be tidied away afterwards —
   * into a list of the same event repeated until somebody noticed. The first cut is the event; the
   * rest are its consequence.
   */
  let budgetCutRecorded = false;

  async function recordSecurityEvent(error: GatewayError, request: GatewayCall): Promise<void> {
    if (error.code === 'E_BUDGET_EXHAUSTED') {
      if (budgetCutRecorded) return;
      budgetCutRecorded = true;
    }

    // Assembled field by field from values that are known not to be literals, rather than by
    // spreading whatever the error carried. A row of the audit table quoting the address it caught
    // would put that address in an append-only table by way of the control that stopped it.
    const detail: Json = {
      run_id: config.run_id,
      agent: request.agent,
      model_requested: request.model_requested,
      kind: (error.detail.kind as string | undefined) ?? null,
      kinds: (error.detail.kinds as string[] | undefined) ?? null,
      spent_aud: (error.detail.spent_aud as string | undefined) ?? null,
      in_flight_aud: (error.detail.in_flight_aud as string | undefined) ?? null,
      cut_aud: (error.detail.cut_aud as string | undefined) ?? null,
      scope: (error.detail.scope as string | undefined) ?? null,
    };

    try {
      await config.audit.record({
        org_id: request.org_id,
        // Null on purpose: the writer is the system's own path to the model, not a person. The
        // column is nullable precisely so that a machine actor is not given somebody's identity.
        actor_id: null,
        action: error.code,
        object_type: request.ticket_id ? 'ticket' : 'run',
        object_id: request.ticket_id ?? config.run_id,
        detail,
        ts: now().toISOString(),
      });
    } catch (auditError) {
      // Best effort, and the semantics are the point: the caller must see the failure that actually
      // happened. A redaction failure that could not be filed is still a redaction failure, and
      // replacing it with a database error would trade a security signal for an infrastructure one.
      console.error(
        `[gateway] the security event ${error.code} could not be filed:`,
        auditError instanceof Error ? auditError.message : String(auditError),
      );
    }
  }

  async function call(request: GatewayCall): Promise<GatewayResult> {
    try {
      return await run(request);
    } catch (error) {
      // One place, not six. A code added to SECURITY_EVENTS is filed from the day it is added,
      // rather than from the day somebody remembers to wire it at its own throw site.
      if (error instanceof GatewayError && SECURITY_EVENTS.has(error.code)) {
        await recordSecurityEvent(error, request);
      }
      throw error;
    }
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
  canaryValues: readonly string[],
  removals: readonly Removal[],
  request: GatewayCall,
): void {
  for (const value of canaryValues) {
    if (text.includes(value)) {
      throw new GatewayError(
        'E_CANARY_IN_RESPONSE',
        'the response carried a canary, so it was not persisted',
        { agent: request.agent, ticket_id: request.ticket_id },
      );
    }
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
