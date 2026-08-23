/**
 * The bandwidth of the boundary, declared in one place because the property being protected is that
 * the set is closed.
 *
 * The seam has always published a sentence about how much can cross it: a bounded number of typed
 * channels, each with a declared cap, and nothing else. Until now that sentence was held by reading
 * the code. This module is the declaration itself, and `ci/seam_check.mjs` measures the tree against
 * it — a fifth channel appearing, or the fourth disappearing, fails the build.
 *
 * **Three became four with the increment that emits gap records, and not before.** The decision that
 * authorised the fourth channel was taken earlier; the count moves the day the channel lands,
 * because a check expecting four against code that exposes three breaks a build for a reason that
 * is not its own.
 *
 * **What a cap is for.** A channel whose values can be enumerated carries a bounded amount of
 * information; an open one carries whatever the producer decides to put in it. That is the whole of
 * the argument, and it is why the denial channel stores an index from a closed alphabet rather than
 * a sentence, and why the gap record's single free field has 512 of its 1024 bytes and no more.
 *
 * **Two of the four caps are the enforcing constant itself, imported rather than transcribed.** A
 * declaration that restated a number would be a second copy of it, and a second copy drifts. The
 * other two are transcribed because they live outside this layer, and `ci/seam_check.mjs` compares
 * the transcription against the original in the file that owns it — which is the same arrangement,
 * held by a check instead of by the compiler.
 */

import { ESCALATION_REASONS } from './escalation.ts';
import { GAP_CHANNEL_RECORD_MAX_BYTES } from './gap_channel.ts';

/** The unit a cap is written in. A cap without one is a number nobody can check. */
export type ChannelUnit = 'bytes' | 'bits';

export type DeclaredChannel = {
  /** The stable slug. It is what `ci/seam_check.mjs` reconciles against and never a display name. */
  slug: string;
  /** How this channel is instantiated in this system, in one line. */
  instantiation: string;
  cap: number;
  unit: ChannelUnit;
  /** What the cap is charged against: one ticket, one record, one query. */
  per: string;
  /**
   * Where the cap is enforced. For the two channels this layer can reach, the number above IS that
   * module's constant; for the other two the check compares this file against the named one.
   */
  enforced_in: string;
};

/**
 * The alphabet of the denial channel, and the bits it costs.
 *
 * Eight indices is three bits, and the arithmetic is written rather than transcribed so that the
 * ninth index — reserved and not taken — moves the bound the day it is taken, instead of leaving a
 * declared three against a code that emits four.
 */
export const DENIAL_ALPHABET_SIZE = ESCALATION_REASONS.length;

export const DENIAL_CHANNEL_BITS = Math.ceil(Math.log2(DENIAL_ALPHABET_SIZE));

/**
 * The longest answer that may cross, transcribed from the published agent contract.
 *
 * It is not imported: the constant lives in the agent layer and this one imports nothing outside
 * `src/alg/`, which is what makes it readable by a check with no bundler. `ci/seam_check.mjs`
 * compares the two files so the transcription cannot drift.
 */
export const RESULT_CHANNEL_MAX_BYTES = 4096;

/**
 * The promotion gate's one bit, declared and not yet instantiated.
 *
 * The gate answers one question — does the candidate beat the incumbent by more than the declared
 * margin — and it answers it with a bit: never the aggregate score, never the per-ticket detail. The
 * increment that runs promotions is where it is asked. It is declared here anyway, because the
 * closed set is the property this file exists to hold: a channel that appeared later without a line
 * in this table is exactly what the check is looking for.
 */
export const PROMOTION_GATE_BITS = 1;

/** The four, in the order the boundary's own table publishes them. */
export const DECLARED_CHANNELS: readonly DeclaredChannel[] = [
  {
    slug: 'result',
    instantiation: 'the drafted answer, validated by the caller; out of contract is refused and never truncated',
    cap: RESULT_CHANNEL_MAX_BYTES,
    unit: 'bytes',
    per: 'ticket',
    enforced_in: 'agents/triage/schema.ts',
  },
  {
    slug: 'denial-telemetry',
    instantiation: `a closed alphabet of ${DENIAL_ALPHABET_SIZE} enumeration indices — zero bytes chosen by the producer`,
    cap: DENIAL_CHANNEL_BITS,
    unit: 'bits',
    per: 'ticket',
    enforced_in: 'src/alg/escalation.ts',
  },
  {
    slug: 'promotion-gate',
    instantiation: 'one bit: does the candidate beat the incumbent by more than the declared margin',
    cap: PROMOTION_GATE_BITS,
    unit: 'bits',
    per: 'query',
    enforced_in: 'declared, and instantiated by the increment that runs promotions',
  },
  {
    slug: 'gap-record',
    instantiation:
      'the typed knowledge-gap record: a commitment, two digests that only tie, and one bounded note',
    cap: GAP_CHANNEL_RECORD_MAX_BYTES,
    unit: 'bytes',
    per: 'record',
    enforced_in: 'src/alg/gap_channel.ts',
  },
];

/** The slugs, as the check reconciles them. */
export const DECLARED_CHANNEL_SLUGS: readonly string[] = DECLARED_CHANNELS.map(
  (channel) => channel.slug,
);
