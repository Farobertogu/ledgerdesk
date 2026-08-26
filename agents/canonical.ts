/**
 * Canonical serialisation and the digests taken over it.
 *
 * Every hash this tree writes into a ledger row is a hash of *text*, and text is only reproducible
 * if the serialisation is. `JSON.stringify` is not: it preserves insertion order, so two objects
 * that are equal as values serialise differently and digest differently. A chain built on that
 * cannot be re-verified by anyone who did not build it in the same order, which is the whole point
 * of having a chain.
 *
 * The rules, small enough to restate in full:
 *
 *   · object keys are emitted in ascending code-unit order, with no whitespace anywhere;
 *   · arrays keep their order, because in an array the order *is* the value;
 *   · `undefined` is an error rather than an omission — a column that is SQL NULL is written as
 *     an explicit `null`, so that "absent" and "null" can never collapse into the same digest;
 *   · non-finite numbers are an error, since neither `NaN` nor `Infinity` has a JSON form;
 *   · money and confidence never travel as numbers. They are fixed-scale decimals in the schema
 *     (`numeric(12,6)` and `numeric(4,3)`), and a float that round-trips through JSON is not the
 *     same object the database stores. They travel as strings, formatted once, here.
 */

import { createHash } from 'node:crypto';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function canonicalJson(value: Json): string {
  if (value === null) return 'null';

  if (typeof value === 'string') return JSON.stringify(value);

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: ${String(value)} has no JSON form`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  const members = keys.map((key) => {
    const member = value[key];
    if (member === undefined) {
      throw new TypeError(`canonicalJson: key '${key}' is undefined; write an explicit null`);
    }
    return `${JSON.stringify(key)}:${canonicalJson(member)}`;
  });
  return `{${members.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The digest of a value, taken over its canonical form and never over an incidental one. */
export function digestOf(value: Json): string {
  return sha256Hex(canonicalJson(value));
}

const HEX64 = /^[a-f0-9]{64}$/;

export function isHex64(value: string): boolean {
  return HEX64.test(value);
}

/**
 * A version-4-shaped identifier that is a function of a written seed rather than of a coin toss.
 *
 * Callers want this for one reason: an identifier that survives a retry. A run derived from its
 * organisation keeps one chain across restarts; an admission derived from the gap it answers and the
 * body it admits proposes the SAME identity on a second attempt, so the unique index on the chain
 * recognises the retry instead of letting it write a second row for one fact; a promotion attempt
 * derived from its organisation cannot be filed twice by an operator who ran the mandate twice. A
 * random identifier would make all three of those "usually fine".
 *
 * **It lives here rather than beside its first caller.** This module is canonical serialisation and
 * the digests taken over it, and this is a derivation of a digest — it is built out of `sha256Hex`
 * two lines above. It was declared in the application's composition root while the application was
 * its only caller; the ledger's promotion writer is the second, and that writer has to load under a
 * bare `node --experimental-strip-types` with no bundler and no `node_modules`, which the composition
 * root cannot do — it imports through the `@agents/` alias that only `tsconfig.app.json` resolves.
 * Two copies of a derivation that mints identities is two answers to "what is this attempt called",
 * so the function moved and the composition root imports it back.
 */
export function derivedUuid(seed: string): string {
  const digest = sha256Hex(seed);
  const variant = ((parseInt(digest[16] as string, 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/**
 * Money, held as an integer number of millionths of a dollar for the whole of its life inside this
 * tree, and turned into text exactly once — at the edge where it becomes a `numeric(12,6)`.
 *
 * The column has six decimal places, so a millionth is its unit and not an approximation of one.
 * Two calls that each cost a third of a cent add up in integers to the same total on every machine;
 * added as binary floats they do not, and the consumption counter that the ledger recomputes from
 * the chain would then disagree with the counter that spent the money.
 */
export const MICRO_PER_AUD = 1_000_000;

export function audToMicro(aud: number): number {
  if (!Number.isFinite(aud)) throw new TypeError('audToMicro: a non-finite amount');
  return Math.round(aud * MICRO_PER_AUD);
}

export function formatAud(micro: number): string {
  if (!Number.isInteger(micro)) throw new TypeError('formatAud: micro-dollars must be an integer');
  const sign = micro < 0 ? '-' : '';
  const absolute = Math.abs(micro);
  const whole = Math.floor(absolute / MICRO_PER_AUD);
  const fraction = absolute % MICRO_PER_AUD;
  return `${sign}${whole}.${String(fraction).padStart(6, '0')}`;
}

/** `numeric(4,3)`, the scale the schema gives confidence. Out-of-range values are a caller's bug. */
export function formatConfidence(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`formatConfidence: ${String(value)} is outside [0, 1]`);
  }
  return value.toFixed(3);
}
