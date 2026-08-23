/**
 * The triage prompt, in the two generations it has had.
 *
 * Three things about it are load-bearing and none of them is the wording.
 *
 * **It is a row before it is a string.** `ledger_entry.prompt_version_id` is NOT NULL and
 * references `prompt_version`, so nothing this prompt produces can be recorded until the prompt is
 * registered. The registration happens while an organisation's runtime is being built, after the
 * privilege preflight and before any gateway exists, and its failure is `E_PROMPT_NO_REGISTRADO` —
 * a refusal to build that runtime at all, not a warning, because a process that cannot record what
 * it spends has no business spending it. The refusal is not cached, so a database corrected a
 * minute later is not reported as broken until somebody restarts the server.
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
 * **There are two generations, and the words are the same in both.** That is unusual enough to be
 * worth stating plainly: a generation is normally a new wording, and this one is not. The output
 * contract these words demand gained the drafting agent's block and the bounds that go with it, so
 * `AGENT_IO_SCHEMA_SHA256` moved — and `schema_hash` is a column of an immutable row. Editing
 * generation 0 to carry the new digest is exactly what the immutability trigger exists to refuse,
 * and it would also be a lie: the rows written under generation 0 were written against the old
 * contract and still are. So generation 0 stays byte for byte as it was, with the digest it was
 * registered under pinned below, and generation 1 stands beside it carrying the new one.
 *
 * The consequence, declared: the cache key includes `prompt_version_id`, so every triage answer
 * recorded under generation 0 stops being reachable as a cache hit the moment this build runs. The
 * rows are still there and still readable — nothing is destroyed — but the first triage of each
 * ticket under this build is a fresh call. `state_hash` moves in the same release for two other
 * reasons besides, so this is not the only thing emptying that cache.
 *
 * Later generations after this one are the promotion gate's to mint.
 */

import { assertLineage, type PromptRegistration } from '../prompt_version.ts';
import { AGENT_IO_SCHEMA_SHA256 } from './schema.ts';

/**
 * Fixed, so that a clean clone, CI and a rehearsal all name the same prompt version and the rows
 * they write are comparable. A generated identifier would make every run's chain a different
 * chain for no reason anyone could point at.
 */
export const TRIAGE_PROMPT_ID = '7a1a9e00-0000-4000-8000-000000000001';

export const TRIAGE_PROMPT_GENERATION = 0;

/** Generation 1: same words, the contract of this build. */
export const TRIAGE_PROMPT_ID_GEN1 = '7a1a9e00-0000-4000-8000-000000000002';

/**
 * The digest generation 0 was registered under — the bytes of `agent_io.schema.json` as they stood
 * before the drafting agent's block was written into it.
 *
 * It is a literal and it has to be. The build publishes exactly one contract, so the only way to
 * recompute this would be to keep a copy of the superseded document in the tree and digest that,
 * which is a second published schema for the sake of a number. What the literal buys is that a
 * clean database and a database carried forward from the previous increment register the *same two
 * rows*: on the clean one both are inserted, on the carried-forward one generation 0 is found
 * already standing under this exact digest and only generation 1 is new. There is no branch in the
 * registration for "which kind of database is this", which is the branch that would rot.
 */
export const TRIAGE_SCHEMA_SHA256_GEN0 =
  '16ef3df31e6fc5e9ca395b8fd2b4fade9796d8fc963e6c52592e3751b5d0757e';

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

/**
 * The lineage, oldest first.
 *
 * Both rows are registered when an organisation's runtime is first built — lazily and per
 * organisation, like everything else the composition root constructs, and idempotently, so the
 * second organisation to start finds what the first wrote. The generation this build RUNS under is
 * the highest one whose `schema_hash` matches the contract the build publishes, which is not
 * simply the highest: a build rolled back to an earlier schema must run under the generation
 * registered for that schema rather than under a later one describing a contract it no longer holds.
 */
export const TRIAGE_PROMPT_GENERATIONS: readonly PromptRegistration[] = [
  {
    id: TRIAGE_PROMPT_ID,
    agent: 'triage',
    generation: TRIAGE_PROMPT_GENERATION,
    text: TRIAGE_PROMPT_TEXT,
    schema_hash: TRIAGE_SCHEMA_SHA256_GEN0,
    parent_id: null,
  },
  {
    id: TRIAGE_PROMPT_ID_GEN1,
    agent: 'triage',
    generation: 1,
    text: TRIAGE_PROMPT_TEXT,
    schema_hash: AGENT_IO_SCHEMA_SHA256,
    parent_id: TRIAGE_PROMPT_ID,
  },
];

assertLineage(TRIAGE_PROMPT_GENERATIONS);
