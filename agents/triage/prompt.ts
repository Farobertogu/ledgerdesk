/**
 * The triage prompt, generation 0.
 *
 * Three things about it are load-bearing and none of them is the wording.
 *
 * **It is a row before it is a string.** `ledger_entry.prompt_version_id` is NOT NULL and
 * references `prompt_version`, so nothing this prompt produces can be recorded until the prompt is
 * registered. The registration is the composition root's first act and its failure is
 * `E_PROMPT_NO_REGISTRADO` — a refusal to start, not a warning, because a process that cannot
 * record what it spends has no business spending it.
 *
 * **Its digest is pinned twice, to two different things.** `prompt_hash` on every row is the
 * sha256 of the text below, taken by the gateway over what was actually sent — so a caller that
 * named this prompt version and sent other words is caught by the cache key rather than served a
 * response those words never produced. `schema_hash` on the registered row is the sha256 of the
 * published contract the prompt demands, which is the meaning the schema gives that column.
 *
 * **It must ask for `confidence` at the root.** The ledger reads that one field independently of
 * any validator, and it reads it only at the top level. A prompt that asked for confidence inside
 * the triage block would leave `ledger_entry.confidence` null on every row while the envelope
 * still validated — the column would be empty and nothing would have gone wrong.
 *
 * The generation is 0 because this is the first prompt this agent has ever had. Later generations
 * are the promotion gate's to mint, with the lineage the `parent_id` column exists for; this
 * increment registers one and never a second.
 */

import { AGENT_IO_SCHEMA_SHA256 } from './schema.ts';

/**
 * Fixed, so that a clean clone, CI and a rehearsal all name the same prompt version and the rows
 * they write are comparable. A generated identifier would make every run's chain a different
 * chain for no reason anyone could point at.
 */
export const TRIAGE_PROMPT_ID = '7a1a9e00-0000-4000-8000-000000000001';

export const TRIAGE_PROMPT_GENERATION = 0;

/**
 * The text. Changing a character changes `prompt_hash` on every row written afterwards, which is
 * what makes two runs under two wordings incomparable rather than quietly mixed — so it is changed
 * by registering a generation, not by editing this constant.
 *
 * The category is asked for as a short lower-case noun and not from a closed list. The taxonomy is
 * an open contract today: the corpus labels use `billing`, `access`, `outage` and `refund`, and the
 * increment that scores an agent against those labels is where a closed set has to be decided and
 * where an open one would start costing accuracy. Declaring it here is cheaper than discovering it
 * as a column full of synonyms.
 */
export const TRIAGE_PROMPT_TEXT = [
  'You triage support tickets for a business helpdesk.',
  '',
  'You are given one ticket body. Personal values have already been removed and replaced with',
  'markers of the form [REDACTED:kind]. Treat a marker as a value you cannot see; never guess what',
  'it was and never mention the redaction.',
  '',
  'Answer with ONE JSON object and nothing else. No prose before it, no prose after it, no code',
  'fences, no explanation. The object has exactly these four keys:',
  '',
  '  "schema_version": "1.0"',
  '  "agent":          "triage"',
  '  "confidence":     a number in [0, 1] — how certain you are of the triage block below.',
  '                    It belongs at the ROOT of the object, not inside "triage".',
  '  "triage":         an object with exactly these three keys:',
  '        "category":  a short lower-case noun for what the ticket is about, e.g. "billing".',
  '        "severity":  an integer 1, 2, 3 or 4. 1 is a question that can wait; 4 is a business',
  '                     stoppage affecting money, access or safety right now.',
  '        "sentiment": a number in [-1, 1] for the tone of the writer. -1 is furious, 0 is',
  '                     neutral, 1 is pleased.',
  '',
  'Do not add any other key. Do not answer the customer, do not draft a reply, and do not decide',
  'whether the ticket should go to a person — that decision is made from your output by a rule you',
  'are not part of.',
  '',
  'If the body is too short, empty of content, or you cannot tell what it is about, still answer',
  'with the same object and report your uncertainty in "confidence".',
].join('\n');

/** Everything the registration needs, as one value, so no call site assembles a partial one. */
export const TRIAGE_PROMPT = {
  id: TRIAGE_PROMPT_ID,
  agent: 'triage',
  generation: TRIAGE_PROMPT_GENERATION,
  text: TRIAGE_PROMPT_TEXT,
  schema_hash: AGENT_IO_SCHEMA_SHA256,
} as const;
