/**
 * Deterministic redaction of the values that may not leave the tenant.
 *
 * This module is the dictionary and the machine that applies it. It has no opinion about when it
 * runs — that belongs to the chokepoint in `agents/gateway.ts`, which is the only caller that
 * matters, because a redactor that some paths use and others skip is not a redactor.
 *
 * **Deterministic, and therefore auditable.** Every rule below is a pattern, applied in a fixed
 * order, producing a typed marker `[REDACTED:<kind>]`. The same body always redacts to the same
 * text, which is what lets the digest of the redacted body be a cache key and a ledger column
 * instead of a coincidence. No model, no scoring, no heuristic that could answer differently on a
 * Tuesday.
 *
 * **It fails towards over-redaction, deliberately.** Where a pattern is ambiguous the rule is
 * written to catch rather than to spare, because a mangled reference number costs a support agent
 * ten seconds and a leaked card number costs something else entirely. The patterns are nonetheless
 * shaped to the real formats — a card is four groups of four or a contiguous run, not any long
 * string of digits — so that the over-redaction is bounded rather than indiscriminate.
 *
 * **What a pattern cannot do, and what is offered instead.** A name and a street address have no
 * form; no regular expression recognises "Priya Raghavan" as a person and "Level 4, 61 Bourke St"
 * as a place without recognising half the English language with them. The honest mechanism for
 * those is the tenant's own records: the caller passes the strings it already knows are personal —
 * the customer's name from the account, the address from the profile — as `literals`, and they are
 * removed by exact match before anything else runs. That is deterministic, it is complete for the
 * values the tenant actually holds, and it does not pretend to a capability the patterns lack.
 */

export type RedactionKind = 'literal' | 'email' | 'card' | 'account' | 'phone' | 'id';

export const REDACTION_KINDS: readonly RedactionKind[] = [
  'literal',
  'email',
  'card',
  'account',
  'phone',
  'id',
] as const;

/** One value that was removed, kept so the response can be checked for its return. */
export type Removal = {
  kind: RedactionKind;
  literal: string;
};

export type RedactionResult = {
  /** The text with every match replaced by its typed marker. */
  text: string;
  /** Every literal removed, in the order they were removed. Never persisted, never logged. */
  removed: Removal[];
  /** How many of each kind were removed. This is the half that is safe to publish. */
  counts: Record<RedactionKind, number>;
};

export function marker(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

type Rule = { kind: RedactionKind; pattern: RegExp };

/**
 * The order is part of the contract. A card is matched before a phone number, so that a sixteen
 * digit run is removed as the card it is rather than as the eleven-digit prefix a phone rule would
 * take out of its middle; the labelled rules run last, because by then the shaped values are gone
 * and what remains beside the word "account" really is an account number.
 */
const RULES: readonly Rule[] = [
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },

  // An IBAN carries its own country prefix and check digits, so it is recognisable on its own —
  // and it MUST be matched before the card rules. The body of an IBAN is groups of four digits, so
  // a card rule reaching it first takes the middle out of it and leaves `DE89 [REDACTED:card] 00`:
  // the account number is then neither removed nor intact, which is the worst of the three states.
  //
  // The trailing group is optional and short, and that is not a nicety. An IBAN is 15 to 34
  // characters, which is only a multiple of four by coincidence: a German one is 22 and ends in a
  // group of two, a French one is 27 and ends in a group of three. A pattern demanding whole groups
  // matches all of such a number except its last two characters — removing the account and leaving
  // the fragment, which is the same worst-of-three state described above, arrived at from the other
  // direction.
  { kind: 'account', pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{4}){2,7}(?:[ ]?[A-Za-z0-9]{1,3})?\b/g },
  // An Australian BSB followed by its account number.
  { kind: 'account', pattern: /\b\d{3}-\d{3}[ ]+\d{6,10}\b/g },

  // Card numbers in the two forms they are actually written in, plus the American Express 4-6-5.
  { kind: 'card', pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}(?:[ -]\d{1,4})?\b/g },
  { kind: 'card', pattern: /\b\d{4}[ -]\d{6}[ -]\d{5}\b/g },
  { kind: 'card', pattern: /\b\d{13,19}\b/g },

  { kind: 'phone', pattern: /\+\d{1,3}[ -]?\d(?:[ -]?\d){6,13}\b/g },
  { kind: 'phone', pattern: /\(\d{2}\)[ ]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'phone', pattern: /\b0\d(?:[ -]?\d){7,9}\b/g },

  // Labelled numbers: the label is what makes the digits identifiable, so it is what the rule
  // looks behind. The label itself is left in place — "account [REDACTED:account]" still reads.
  {
    kind: 'account',
    pattern: /(?<=\b(?:account|acct|a\/c|bsb|iban|bank)\b[^\d\n]{0,16})\d(?:[ -]?\d){4,18}/gi,
  },
  {
    kind: 'id',
    pattern:
      /(?<=\b(?:tfn|abn|acn|medicare|licence|license|passport|customer\s+id|member\s+id)\b[^\d\n]{0,16})\d(?:[ -]?\d){4,15}/gi,
  },
];

/**
 * The shortest caller-supplied literal the redactor will accept.
 *
 * The number is a trade between two failures and it is worth setting out, because the obvious
 * reading — "longer is safer" — is only half true. A literal is removed from the body AND searched
 * for in everything that leaves; the search is what makes the threshold matter, because a hit
 * aborts the call. A short literal collides with ordinary English: "Chan" is a real surname and
 * lives inside "Channel", "Ann" inside "Announce". Every such collision is a support ticket that
 * cannot be answered at all, arriving as a privacy error nobody can reproduce.
 *
 * Eight, and not the ten a reviewer proposed. Ten excludes values that are unambiguously personal
 * and unambiguously present — "Nguyen T" is nine — and a threshold that refuses real names pushes
 * a caller towards not declaring them, which costs more than the collisions it saves. Eight admits
 * a full name and an address line, which is what the tenant's records actually hold and what
 * actually appears in a ticket body, and excludes the three-to-five character fragments that
 * collide. A caller with only a bare short surname is told plainly that this mechanism does not
 * cover it, which is a better answer than half-covering it.
 *
 * Below the threshold the value is REFUSED by the gateway, never silently dropped. That is the
 * change that matters more than the number: the previous behaviour let a caller believe a value
 * was covered while the filter had removed it from consideration.
 */
export const MIN_LITERAL_LENGTH = 8;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyCounts(): Record<RedactionKind, number> {
  return { literal: 0, email: 0, card: 0, account: 0, phone: 0, id: 0 };
}

/**
 * Removes every value the dictionary recognises, and every literal the caller supplied.
 *
 * `literals` are removed first and longest first, so that a full address is taken out as one value
 * rather than being cut in half by the removal of the suburb inside it.
 */
export function redact(text: string, literals: readonly string[] = []): RedactionResult {
  const removed: Removal[] = [];
  const counts = emptyCounts();
  let current = text;

  // Longest first, so a full address is taken out as one value rather than being cut in half by
  // the removal of the suburb inside it. Nothing is filtered here: a literal below the threshold is
  // refused by the caller's boundary, not dropped by this function without telling anybody.
  const ordered = [...new Set(literals)]
    .map((literal) => literal.trim())
    .filter((literal) => literal.length > 0)
    .sort((a, b) => b.length - a.length);

  for (const literal of ordered) {
    const pattern = new RegExp(escapeForRegExp(literal), 'gi');
    current = current.replace(pattern, (match) => {
      removed.push({ kind: 'literal', literal: match });
      counts.literal += 1;
      return marker('literal');
    });
  }

  for (const rule of RULES) {
    // The pattern objects are module-level and carry the global flag, which makes lastIndex
    // stateful. `String.replace` resets it, but a fresh instance costs nothing and removes the
    // question entirely for anyone reading this later.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    current = current.replace(pattern, (match) => {
      removed.push({ kind: rule.kind, literal: match });
      counts[rule.kind] += 1;
      return marker(rule.kind);
    });
  }

  return { text: current, removed, counts };
}

/**
 * Whether `haystack` still contains any of the values that were removed from it.
 *
 * Used on both sides of the provider call: on the payload before it leaves, and on the response
 * before it is persisted.
 *
 * **Every pattern-derived value is searched for, at any length.** An address, a card, an IBAN, a
 * phone number and a labelled identifier are structured: they were recognised BY their structure,
 * and that same structure is what makes them safe to search for. A six-character card fragment does
 * not occur inside an English sentence by accident. There is no length floor here and there should
 * not be one — a floor would mean a short account number could be removed from the body and then
 * travel out through some other field unnoticed, which is the exact hole the scan exists to close.
 *
 * **Caller literals are the only ones with a floor**, and they carry it because they are the only
 * unstructured values in the set. The floor is enforced at the boundary, by refusing the literal
 * when it is supplied, so by the time a literal reaches this function it has already qualified.
 */
export function findLeak(haystack: string, removed: readonly Removal[]): Removal | null {
  const folded = haystack.toLowerCase();
  for (const removal of removed) {
    const literal = removal.literal.trim();
    if (!literal) continue;
    if (removal.kind === 'literal' && literal.length < MIN_LITERAL_LENGTH) continue;
    if (folded.includes(literal.toLowerCase())) return removal;
  }
  return null;
}

const MARKER_PATTERN = new RegExp(`\\[REDACTED:(?:${REDACTION_KINDS.join('|')})\\]`, 'g');

/**
 * The text with the markers taken out as well, which is how much of it was not personal.
 *
 * The distinction matters at one place and it is a fail-closed one: a body that redacted to
 * `[REDACTED:email]` and nothing else has not been redacted, it has been *emptied*, and sending it
 * would be sending a request with no request in it. `String.trim` cannot tell those apart, because
 * a marker is not whitespace.
 */
export function withoutMarkers(text: string): string {
  return text.replace(MARKER_PATTERN, ' ');
}
