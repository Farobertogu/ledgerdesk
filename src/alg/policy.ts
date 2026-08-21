/**
 * The deterministic policy matcher — the upstream the escalation rule has been promising.
 *
 * `escalation.ts` says it twice: `policyFlags` arrives as a list of enumerated values produced by
 * a deterministic matcher upstream, *precisely so that no judgement about a customer's intent is
 * ever outsourced to a language model*. This is that matcher. It is a pure function of text and a
 * table of written patterns, and its whole value is that a person can read the table and say in
 * advance what it will do.
 *
 * **Why it is not a model, restated because it is the load-bearing part.** `POLICY` is the highest
 * precedence in the rule and the only reason that no published column can reconstruct. If a model
 * decided it, then the one code that routes a ticket to a lawyer or to a safety desk would be the
 * one code nobody could re-run, audited by a value nobody could reproduce. A regular expression is
 * a poorer classifier than a model and a far better instrument.
 *
 * **The input is fixed by contract: `subject + "\n" + body`, normalised, computed ONCE per triage
 * cycle and reused by both evaluations.** The rule is evaluated twice — before any model is called
 * and again after the verdict comes back — and if the two evaluations were handed two different
 * strings, a flag could appear or vanish between them and the ticket's reason would depend on
 * which evaluation happened to see it. One string, computed once, is what makes that
 * unrepresentable rather than merely unlikely.
 *
 * **The raw body never leaves the process.** The matcher runs locally, on the body as the customer
 * wrote it — the redacted body would hide exactly the phrases some of these patterns look for —
 * and it emits an enum. An auditor re-runs the decision from the persisted columns and this table,
 * never from the customer's words.
 *
 * **No column carries the flags, on purpose.** The published precedence of the escalation rule is
 * justified on the ground that `POLICY` is irrecoverable from any column, so adding a
 * `policy_flags` column would invalidate the criterion the order was published under. The flags
 * are recomputed by whoever wants them, from this table and the body.
 */

import { POLICY_FLAGS, type PolicyFlag } from './escalation.ts';

/**
 * One written rule. `name` is stable and is what an audit cites; renaming one is a change to the
 * record, exactly as it is for a clause of the escalation rule.
 */
export type PolicyPattern = {
  flag: PolicyFlag;
  name: string;
  pattern: RegExp;
};

/**
 * The table.
 *
 * Every pattern is anchored on word boundaries and matched against the normalised text, so a rule
 * fires on a word and not on a fragment of one — `\brefund\b` does not fire on "refundable" and
 * `\bsue\b` does not fire on "issue", which is the single mistake this kind of table is most
 * likely to make and the most tedious to find afterwards.
 *
 * None of them is global. A `/g` regular expression carries `lastIndex` between calls, so a shared
 * one would answer differently on the second call with the same input — the one property this
 * module cannot have.
 */
export const POLICY_PATTERNS: readonly PolicyPattern[] = [
  // ---- refund: money the customer is asking to have back ------------------------------------
  { flag: 'refund', name: 'refund_requested', pattern: /\brefund(s|ed|ing)?\b/ },
  { flag: 'refund', name: 'chargeback_named', pattern: /\bcharge ?backs?\b/ },
  { flag: 'refund', name: 'money_back_named', pattern: /\bmoney back\b/ },
  { flag: 'refund', name: 'reimbursement_requested', pattern: /\breimburse(d|ment)?\b/ },

  // ---- complaint: the customer is filing one, not merely being unhappy -----------------------
  { flag: 'complaint', name: 'complaint_named', pattern: /\bcomplaints?\b/ },
  { flag: 'complaint', name: 'complaint_verb', pattern: /\bcomplain(ing|ed)?\b/ },
  { flag: 'complaint', name: 'conduct_called_unacceptable', pattern: /\bunacceptable\b/ },

  // ---- legal: exposure that belongs with someone who handles exposure ------------------------
  { flag: 'legal', name: 'lawyer_named', pattern: /\b(lawyers?|solicitors?|attorneys?)\b/ },
  { flag: 'legal', name: 'legal_action_named', pattern: /\blegal action\b/ },
  { flag: 'legal', name: 'litigation_threatened', pattern: /\b(sue|suing|litigation|court)\b/ },
  { flag: 'legal', name: 'contract_breach_alleged', pattern: /\bbreach of contract\b/ },
  { flag: 'legal', name: 'ombudsman_named', pattern: /\bombudsman\b/ },

  // ---- safety: harm, to a person, now --------------------------------------------------------
  { flag: 'safety', name: 'harm_named', pattern: /\b(unsafe|hazard|hazardous|dangerous)\b/ },
  { flag: 'safety', name: 'injury_named', pattern: /\binjur(y|ies|ed)\b/ },
  { flag: 'safety', name: 'emergency_named', pattern: /\bemergency\b/ },
  { flag: 'safety', name: 'self_harm_named', pattern: /\bself[ -]?harm\b/ },

  // ---- injection: an attempt to talk to the model rather than to the helpdesk -----------------
  {
    flag: 'injection',
    name: 'instruction_override_attempted',
    pattern: /\b(ignore|disregard|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\binstructions?\b/,
  },
  { flag: 'injection', name: 'system_prompt_named', pattern: /\bsystem prompt\b/ },
  { flag: 'injection', name: 'prompt_disclosure_requested', pattern: /\breveal\b[^.]{0,30}\bprompt\b/ },
  { flag: 'injection', name: 'role_reassignment_attempted', pattern: /\byou are now\b/ },
  { flag: 'injection', name: 'jailbreak_named', pattern: /\b(jailbreak|prompt injection)\b/ },
];

/**
 * The matcher's own configuration, in a form a digest can be taken over.
 *
 * `state_hash` on every ledger row covers `ruleset_hash`, and the ruleset has to include this
 * table: with the matcher in the path, the verdict depends on it, and two runs under two tables
 * must be incomparable rather than quietly pooled. A `RegExp` has no JSON form, so the source and
 * the flags are what travel — which is exactly what changes when a pattern changes.
 */
export function policyPatternSources(): { flag: string; name: string; source: string }[] {
  return POLICY_PATTERNS.map((entry) => ({
    flag: entry.flag,
    name: entry.name,
    source: entry.pattern.source,
  }));
}

/**
 * The text the patterns are matched against, from the two fields a ticket carries.
 *
 * Compatibility-normalised, lower-cased, and with every run of whitespace — including the newline
 * this function itself inserts — collapsed to one space. The collapse is what makes a phrase match
 * when a customer wrapped it across two lines, and the lower-casing is why no pattern in the table
 * needs a case flag.
 */
export function policyInput(subject: string, body: string): string {
  return `${subject}\n${body}`.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The flags this text raises, in the order the alphabet declares them.
 *
 * The order is the alphabet's and not the table's, and it is not cosmetic: the list is stored
 * nowhere but it is compared, logged and asserted on, and a list whose order depended on which
 * pattern happened to be written first would make two equal results unequal.
 */
export function matchPolicyFlags(text: string): readonly PolicyFlag[] {
  const raised = new Set<PolicyFlag>();
  for (const entry of POLICY_PATTERNS) {
    if (entry.pattern.test(text)) raised.add(entry.flag);
  }
  return POLICY_FLAGS.filter((flag) => raised.has(flag));
}

/** Every pattern that fired, for the screen that has to explain a `POLICY` escalation to a person. */
export function matchPolicyPatterns(text: string): { flag: PolicyFlag; name: string }[] {
  return POLICY_PATTERNS.filter((entry) => entry.pattern.test(text)).map((entry) => ({
    flag: entry.flag,
    name: entry.name,
  }));
}
