/**
 * The canaries: one synthetic value per shaped rule in the dictionary, planted into the tenant-side
 * material of every call and required to be gone before anything leaves.
 *
 * **Why a set and not one.** A single canary shaped like an address attests to exactly one thing —
 * that the address rule fired on this pass. It says nothing about the card rule, and a card rule
 * that had stopped matching would let card numbers through while the canary kept coming back clean.
 * The attestation would then be measuring "the pipeline ran", which is not the claim anybody cares
 * about. One canary per shaped rule turns it into the claim that is: on this call, every pattern in
 * the dictionary was demonstrated to fire on a value of its own kind.
 *
 * **What is not attestable this way, said out loud.** `literal` has no synthetic form. It removes
 * the exact strings the tenant supplied, so a canary for it would be a string the caller passed in
 * to be removed — which tests that `String.replace` works. Its failure mode is also different in
 * kind: a pattern can stop matching a shape it used to match, whereas an exact-string removal either
 * finds its literal or the literal was not there. It is excluded deliberately, not overlooked.
 *
 * **The values.** Every one is a published example or a reserved form — the `.invalid` domain, the
 * card number every payment processor documents as a test value, an IBAN from the standard's own
 * examples, an unassigned phone number. None of them belongs to anybody. If one ever did escape, it
 * would carry no information about a real person, which is the second property a canary needs after
 * being detectable.
 */

import type { RedactionKind } from './redaction.ts';
import { marker } from './redaction.ts';

/** The separator that opens the planted block. Deliberately unlike anything a ticket contains. */
export const CANARY_MARK = '\n<<ledgerdesk-canary>> ';

export type CanarySpec = {
  kind: RedactionKind;
  /** Built from the call's token, or fixed where the shape has no room for one. */
  value: (token: string) => string;
  /** Text that must sit between this canary and the one before it, if any. */
  lead?: string;
};

/**
 * The order is the order they are planted in, and therefore the order their markers appear in. It
 * is fixed so the expected tail is a constant string rather than something reassembled per call.
 */
const CANARIES: readonly CanarySpec[] = [
  // Only the address has room to carry the per-call token, which is what makes an escape traceable
  // to the call it escaped from. The other four are fixed values; their escape is detected by
  // searching for the value itself.
  { kind: 'email', value: (token) => `ld-canary-${token}@canary.invalid` },
  { kind: 'account', value: () => 'DE89 3704 0044 0532 0130 00' },
  { kind: 'card', value: () => '4111 1111 1111 1111' },
  { kind: 'phone', value: () => '0400 000 000' },
  { kind: 'id', value: () => '123 456 782', lead: 'TFN ' },
];

/** How many of each kind the planted block contributes, so the published counts can subtract them. */
export const CANARY_CONTRIBUTION: Readonly<Record<string, number>> = CANARIES.reduce<
  Record<string, number>
>((totals, canary) => {
  totals[canary.kind] = (totals[canary.kind] ?? 0) + 1;
  return totals;
}, {});

export type PlantedCanaries = {
  /** The block appended to the tenant-side material. */
  block: string;
  /** What the block must have become once the redactor has run. */
  expectedTail: string;
  /** Every value planted, for the search over what is about to leave. */
  values: readonly string[];
};

export function plant(token: string): PlantedCanaries {
  const parts = CANARIES.map((canary) => `${canary.lead ?? ''}${canary.value(token)}`);
  const redactedParts = CANARIES.map((canary) => `${canary.lead ?? ''}${marker(canary.kind)}`);

  return {
    block: `${CANARY_MARK}${parts.join(' ')}`,
    expectedTail: `${CANARY_MARK}${redactedParts.join(' ')}`,
    values: CANARIES.map((canary) => canary.value(token)),
  };
}

/**
 * Which canary was not removed, given the redacted text.
 *
 * The tail is compared as a whole first — that is the cheap answer — and this function exists for
 * the expensive one: naming the rule that failed, so the error says "the card rule did not fire"
 * rather than "something is wrong". It never returns the value, only the kind.
 */
export function survivingKinds(redactedText: string, token: string): RedactionKind[] {
  const planted = plant(token);
  return CANARIES.filter((canary, index) => {
    const value = planted.values[index];
    return redactedText.includes(value);
  }).map((canary) => canary.kind);
}
