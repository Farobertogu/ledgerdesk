/**
 * Letting a document into the corpus, which is the one act in this system that changes what an
 * answer can be built from.
 *
 * ## The order, and why it is forced rather than chosen
 *
 * Two of the writes are in different transactions on different pools and no amount of preference
 * changes which comes first. `kb_admission.ledger_ref` is `not null` with a foreign key, so the row
 * of the chain must exist before the admission row can; and the chain row's `output` already carries
 * `snapshot_from` and `snapshot_to` by the published contract of its class. So:
 *
 *  1. **Derive the identity.** Not minted at random — see below.
 *  2. **The chain row**, `class = 'kb_admission'`, through the writer of rows that are not model
 *     calls. Its `state_hash` pins the **outgoing** snapshot, because the decision to admit is taken
 *     under the corpus as it stands; that is what makes this row the visible frontier between the
 *     two states. Its `ticket_id` is the gap's ticket, without which the row never appears in the
 *     panel that shows a ticket's chain and the cycle loses its central piece of evidence.
 *  3. **The advance**, taking that row's identity and nothing else. It reads the organisation, both
 *     snapshots, the gap, the approver, the provenance and the declared hash out of the row, copies
 *     the corpus, inserts the admitted body, writes the admission row and moves the pointer — all in
 *     one statement's worth of atomicity, in SQL, because a partial copy interrupted by a crash
 *     leaves a snapshot that looks complete and no constraint anywhere would notice.
 *  4. **Eviction**, as the last act.
 *
 * ## The window between 2 and 3, declared rather than hidden
 *
 * Step 2 runs on the ledger's own pool and its own transaction; step 3 runs on the application's.
 * There is no distributed transaction to be had and none is pretended, so a crash between them
 * leaves a chain row describing an admission that did not happen.
 *
 * What makes that recoverable is that the identity is **derived from the gap and the body** rather
 * than minted at random: a second attempt at the same admission proposes the same identity, the
 * pre-read finds the standing row, and the cycle continues from step 3 with it. If two attempts race
 * past the pre-read, the unique index on the chain lets one in and the loser reads the winner's row.
 * A random identifier would have made the retry write a second chain row for one fact, and the chain
 * would then hold a claim about the corpus that nothing ever performed.
 *
 * Alternatives rejected: two-phase commit across two pools, which neither the driver nor the target
 * offers; writing the admission row first, which the foreign key forbids and which would put a
 * document in the corpus before anything recorded who let it in; and a compensating delete, which
 * cannot run — the chain is append-only by trigger, which is the property being relied on.
 *
 * ## What is checked before anything is written
 *
 * The body has to survive the redactor **unchanged**. A document the redactor touches is a document
 * that would be quoted to a customer with a marker where a fact used to be, and the system prefers
 * not to admit one at all over admitting one that will be cited full of holes. It also settles what
 * `content_hash` is a hash OF: a body the redactor does not touch is the same body raw and redacted,
 * so there is only one thing it can be.
 *
 * It must not raise the injection flag, and it must fit whole inside one excerpt — a body whose
 * deciding sentence falls after the truncation would close a gap on padding.
 *
 * **None of that is the defence against a poisoned corpus. The human approver is.** The matcher is a
 * table of written patterns; it is evadable and it was evaded during this card's own review. What
 * stands between a hostile document and the corpus is a person with a name, whose identity the
 * database ties to the session that performed the admission.
 */

import type { PoolClient } from 'pg';

import { canonicalJson, sha256Hex } from '@agents/canonical.ts';
import type { Json } from '@agents/canonical.ts';
import { appendSystemRow } from '@agents/ledger/system_row.ts';
import { redact } from '@agents/redaction.ts';
import { EXCERPT_MAX } from '@agents/triage/schema.ts';

import { matchPolicyFlags, policyInput } from '@/alg/policy';
import {
  derivedUuid,
  evictRuntime,
  ledgerStore,
  refuseIfRuntimeIsStale,
  runtimeFor,
} from '@/server/agents';
import { withAppSession, type Claims } from '@/server/db';
import { AppError } from '@/server/errors';
import { requireSnapshotHead } from '@/server/kb/retrieval';

/** What is known about where an admitted document came from. */
export type AdmissionProvenance = {
  /** Where it came from, as a person would name it. */
  source: string;
  /** When it was obtained, ISO 8601. */
  obtained_at: string;
  /** Whether it may be quoted to a customer, and on whose authority. */
  citability: string;
};

export type AdmissionRequest = {
  gap_id: string;
  canonical_key: string;
  title: string;
  body: string;
  /** Whether the article may be cited. No default: an absent flag is refused by the writer below. */
  citable: boolean;
  provenance: AdmissionProvenance;
};

export type AdmissionOutcome = {
  admission_id: string;
  gap_id: string;
  ticket_id: string;
  article_id: string;
  canonical_key: string;
  content_hash: string;
  snapshot_from: string;
  snapshot_to: string;
  ledger_ref: string;
  ledger_seq: number;
  /** True when a previous attempt had already written the chain row and this one reused it. */
  resumed: boolean;
};

/** The alphabet a canonical key is restricted to, transcribed from the constraint that holds it. */
const CANONICAL_KEY_SHAPE = /^[A-Za-z0-9_/-]{1,64}$/;

const GAP = `
  select g.id, g.org_id, g.ticket_id, g.state::text as state, g.kb_snapshot
    from kb_gap g where g.id = $1::uuid`;

const STANDING_ROW = `
  select id, seq from ledger_entry
   where class = 'kb_admission' and output ->> 'admission_id' = $1
   limit 1`;

const LABELS_TODAY = `
  select distinct kb_snapshot from kb_article
   where org_id = $1::uuid and kb_snapshot like $2`;

const ADVANCE = `
  select article_id::text as article_id, canonical_key, body_sha256
    from kb_snapshot_advance($1::bigint, $2::jsonb)`;

function refuse(code: 'E_FIELD_INVALID' | 'E_CONTRATO', detail: string, extra: Record<string, unknown> = {}): never {
  throw new AppError(code, 422, detail, extra);
}

/**
 * The label the corpus moves to.
 *
 * A date, because that is what a person reads on a panel beside `snapshot_from` and understands
 * without being told. A suffix when the date is taken, because a rehearsal admits twice in one
 * afternoon and the advance refuses a snapshot that already exists — correctly, and with a message
 * about existing snapshots rather than about the thing that actually happened.
 *
 * The probe and the advance are not one transaction, so two admissions racing on the same day can
 * still both choose the same label. That is safe rather than merely unlikely: the loser meets
 * `E_KB_SNAPSHOT_YA_EXISTE` from inside the advance, which is a refusal and not a corruption, and
 * the retry probes again and takes the next suffix.
 *
 * **And the case where they choose DIFFERENT labels is the one this probe cannot cover at all**,
 * which is why it is not covered here. Two admissions that read one head and mint two successors
 * would both pass this function and both advance, stranding one of the two documents. That is caught
 * where it has to be — inside the advance, on a locked pointer, as `E_KB_SNAPSHOT_MOVIDO` — because
 * no amount of probing from outside a transaction can decide it.
 */
export async function nextSnapshotLabel(
  client: PoolClient,
  orgId: string,
  now: number,
): Promise<string> {
  const base = `kb-${new Date(now).toISOString().slice(0, 10)}`;
  const taken = await client.query<{ kb_snapshot: string }>(LABELS_TODAY, [orgId, `${base}%`]);
  const used = new Set(taken.rows.map((row) => row.kb_snapshot));

  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}.${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new AppError('E_INTERNAL', 500, 'this organisation has admitted a hundred times today', {
    org_id: orgId,
  });
}

/**
 * Everything about the body that has to be true before anything is written.
 *
 * Returned as a list rather than thrown one at a time, so a document that is wrong in three ways
 * tells the person holding it about three ways.
 */
export function admissibilityViolations(request: AdmissionRequest): string[] {
  const problems: string[] = [];

  if (!CANONICAL_KEY_SHAPE.test(request.canonical_key)) {
    problems.push(
      `the canonical key '${request.canonical_key}' is outside the published alphabet, and an ` +
        'identifier built from it is one the envelope validator refuses',
    );
  }
  if (request.title.trim() === '' || request.body.trim() === '') {
    problems.push('a document with no title or no body is not a document');
  }

  // Characters, because that is the unit the excerpt is cut in and the unit the envelope bounds.
  if (request.body.length > EXCERPT_MAX) {
    problems.push(
      `the body is ${request.body.length} characters and an excerpt carries ${EXCERPT_MAX}; a ` +
        'document that does not travel whole would be cited with its ending missing',
    );
  }

  const pass = redact(request.body, []);
  if (pass.text !== request.body) {
    problems.push(
      `the redactor removes ${pass.removed.length} value(s) from this body, so every citation of it ` +
        'would quote a marker where a fact used to be',
    );
  }

  const flags = matchPolicyFlags(policyInput(request.title, request.body));
  if (flags.includes('injection')) {
    problems.push('the deterministic matcher reads this body as an attempt to instruct a model');
  }

  return problems;
}

/**
 * Admits one document into one organisation's corpus, under the claims of the person approving it.
 *
 * **The session is the approval.** `auth.uid()` has to be the approver the chain row names, and the
 * advance refuses the call otherwise — so the machine actor, which carries an organisation and a
 * role and no subject, cannot reach this at all. There is no session it can present that satisfies
 * the tie, which is a stronger statement than a role check and is the reason the tie is written that
 * way rather than as one.
 */
export async function admitMaterial(
  claims: Claims,
  request: AdmissionRequest,
): Promise<AdmissionOutcome> {
  const orgId = claims.org_id;
  const runtime = await runtimeFor(orgId);

  const head = await requireSnapshotHead(orgId);
  refuseIfRuntimeIsStale(runtime, head);

  const problems = admissibilityViolations(request);
  if (problems.length > 0) {
    refuse('E_CONTRATO', `this document is not admissible: ${problems.join('; ')}`, {
      canonical_key: request.canonical_key,
      problems,
    });
  }

  // The body is not touched by the redactor, so the raw body and the redacted one are the same
  // string and there is exactly one thing this can be a digest of.
  const contentHash = sha256Hex(request.body);

  const gap = await withAppSession(claims, async (client) => {
    const found = await client.query<{
      id: string;
      org_id: string;
      ticket_id: string;
      state: string;
      kb_snapshot: string;
    }>(GAP, [request.gap_id]);
    return found.rows[0] ?? null;
  });

  if (!gap) {
    throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no gap with that id is visible to this session', {
      gap_id: request.gap_id,
    });
  }
  if (gap.state !== 'OPEN') {
    refuse('E_FIELD_INVALID', `this gap is ${gap.state}, and material is admitted against an open one`, {
      gap_id: gap.id,
      state: gap.state,
    });
  }

  // **The gap's own snapshot is deliberately NOT compared against the head.** An earlier draft
  // refused an admission whenever the corpus had moved since the gap was opened, and the effect was
  // to make the whole system serial: with two gaps open, admitting for the first left the second
  // permanently unadmittable, for a reason nobody could act on. A gap does not pin the corpus that
  // answers it — it records a question that went unanswered. `snapshot_from` below is the head
  // because that is a fact of the ADVANCE, which copies the corpus in force; it is not a claim about
  // when the gap was raised.

  const admissionId = derivedUuid(`ledgerdesk:admission:${gap.id}:${contentHash}`);

  const snapshotTo = await withAppSession(claims, (client) =>
    nextSnapshotLabel(client, orgId, Date.now()),
  );

  const output: Json = {
    admission_id: admissionId,
    gap_id: gap.id,
    approved_by: claims.sub,
    snapshot_from: head,
    snapshot_to: snapshotTo,
    content_hash: contentHash,
    provenance_source: request.provenance.source,
    // The whole provenance travels here and the admission row is written FROM it, so the chain and
    // the row cannot disagree about where a document came from.
    provenance: {
      source: request.provenance.source,
      obtained_at: request.provenance.obtained_at,
      citability: request.provenance.citability,
    },
    canonical_key: request.canonical_key,
    citable: request.citable,
    body_bytes: Buffer.byteLength(request.body, 'utf8'),
  };

  /**
   * The chain row this identity already has, if any.
   *
   * Read twice, and the second read is the point. Before the write it recognises a previous attempt
   * that got this far and stopped. After a failed write it distinguishes the two things a refusal
   * can mean: a chain under contention, or **this identity already having a row** — the unique index
   * on `output->>'admission_id'` refusing a second one for a fact that already happened. The writer
   * cannot tell those apart from the error alone, because the store reports every `23505` on the
   * chain the same way, so it asks the table instead.
   */
  const standingRow = async (): Promise<{ id: string; seq: string } | null> =>
    withAppSession(claims, async (client) => {
      const found = await client.query<{ id: string; seq: string }>(STANDING_ROW, [admissionId]);
      return found.rows[0] ?? null;
    });

  // Step 2, with the recovery it is designed for.
  const standing = await standingRow();

  /** The chain row this admission hangs off, however it came to exist. */
  let chainRow: { id: string; seq: number };
  let resumed = false;

  if (standing) {
    chainRow = { id: standing.id, seq: Number(standing.seq) };
    resumed = true;
  } else {
    try {
      const appended = await appendSystemRow(ledgerStore(), {
        run_id: runtime.run_id,
        org_id: orgId,
        // Without this the row does not appear beside the ticket, and the frontier between the two
        // states stops being visible in the one place a person looks for it.
        ticket_id: gap.ticket_id,
        class: 'kb_admission',
        output,
        // **The runtime's own state, taken and not rebuilt.** This row and the model rows around it
        // are the two halves of one chain, and the evidence of the whole cycle is that they differ
        // in exactly one state with this row on the side that decided. Composed here from three
        // parts it would be a second producer of that fact, free to disagree with the first for a
        // reason no reader could see; taken from the runtime it is the same object the chokepoint
        // pinned, so the two rows cannot disagree at all.
        //
        // It carries the corpus the decision was taken UNDER, not the one this admission is about to
        // produce — `refuseIfRuntimeIsStale` above has already established that the label the
        // runtime holds is the one in force, so this is the corpus that answered nothing, which is
        // what makes the row the visible frontier between the two states.
        state: runtime.state,
        // Written out rather than passed through: the row's toolchain is a JSON value and the
        // runtime's is a typed pair, and naming the two fields is what keeps them one fact.
        toolchain: { app: runtime.toolchain.app, ruleset: runtime.toolchain.ruleset },
        ts: new Date().toISOString(),
      });
      chainRow = { id: appended.id, seq: appended.seq };
    } catch (error) {
      // Two attempts raced past the read above and the index let one of them in. The loser asks
      // which row stands and continues with it — that is what "a retry finds its own row instead of
      // writing a second one" means, and it is the reason the index exists at all. A refusal that
      // was really contention leaves no row, and then the error is the answer.
      const raced = await standingRow();
      if (!raced) throw error;
      chainRow = { id: raced.id, seq: Number(raced.seq) };
      resumed = true;
    }
  }

  const ledgerRef = chainRow.id;
  const ledgerSeq = chainRow.seq;

  // The material, as the one-element list the advance's contract takes. One document per admission,
  // because one admission names one article.
  const admittedMaterial: Json = [
    {
      canonical_key: request.canonical_key,
      title: request.title,
      body: request.body,
      citable: request.citable,
    },
  ];

  // Step 3. One transaction, and everything in it derived from the row written above.
  const admitted = await withAppSession(claims, async (client) => {
    const result = await client.query<{
      article_id: string;
      canonical_key: string;
      body_sha256: string;
    }>(ADVANCE, [ledgerRef, canonicalJson(admittedMaterial)]);
    return result.rows[0] ?? null;
  });

  if (!admitted) {
    throw new AppError('E_INTERNAL', 500, 'the advance wrote nothing and reported no failure', {
      admission_id: admissionId,
    });
  }

  // Step 4, and last. Until this runs, every runtime in this process is holding the label the corpus
  // has just left — and the cycle refuses to run on one, loudly, rather than citing one corpus while
  // recording another.
  evictRuntime(orgId);

  return {
    admission_id: admissionId,
    gap_id: gap.id,
    ticket_id: gap.ticket_id,
    article_id: admitted.article_id,
    canonical_key: admitted.canonical_key,
    content_hash: admitted.body_sha256,
    snapshot_from: head,
    snapshot_to: snapshotTo,
    ledger_ref: ledgerRef,
    ledger_seq: ledgerSeq,
    resumed,
  };
}
