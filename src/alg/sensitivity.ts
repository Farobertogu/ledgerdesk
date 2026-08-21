#!/usr/bin/env node
/**
 * sensitivity.ts — the weight sensitivity generator.
 *
 * Weights that nobody has perturbed are decoration. This replays one seeded month of arrivals
 * under the published weights and under every perturbation of them, and reports what each change
 * does to the queue: how far the order moves, how much of the first page an agent would see
 * changes, and whether more tickets miss their first-response target as a result.
 *
 * Contract
 *   Inputs    (seed, arrival count, replay parameters) — the same triple emits the same report.
 *             There is no clock in the output: no build stamp, no run identifier, nothing that
 *             makes two runs of one input differ.
 *   Output    a markdown report, written to `--out`.
 *   Exit 0    the report was written, or `--check` found it identical to what this run produced.
 *   Exit 1    a parameter is malformed.
 *   Exit 2    `--check` found the file on disk different from this run's output — it was edited by
 *             hand, or it is stale, or the algorithm changed and the report was not regenerated.
 *   Exit 3    a replay failed to drain, so the measured world is not the stable one it claims.
 *
 * Usage
 *   node --experimental-strip-types src/alg/sensitivity.ts [--out PATH] [--seed TEXT]
 *                                                          [--arrivals N] [--check]
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PriorityWeights } from './priority.ts';
import { DEFAULT_PRIORITY_WEIGHTS, assertValidWeights } from './priority.ts';
import type { SimTicket } from './simulation.ts';
import {
  DEFAULT_ARRIVALS,
  DEFAULT_REPLAY,
  generateArrivals,
  kendallTau,
  rankSnapshot,
  replay,
  topKOverlap,
} from './simulation.ts';

const WEIGHT_NAMES = ['severity', 'negativity', 'urgency', 'tier'] as const;
type WeightName = (typeof WEIGHT_NAMES)[number];

/** The size of the page an agent is served, and therefore the head the overlap is measured over. */
const PAGE = 50;

/** The three configurations the report is required to fill in, baseline first. */
const NAMED_CONFIGS: readonly { id: string; rationale: string; weights: PriorityWeights }[] = [
  { id: 'C-base', rationale: 'policy default', weights: DEFAULT_PRIORITY_WEIGHTS },
  {
    id: 'C-sla',
    rationale: 'SLA-dominant',
    weights: { severity: 0.25, negativity: 0.2, urgency: 0.45, tier: 0.1 },
  },
  {
    id: 'C-sev',
    rationale: 'severity-dominant',
    weights: { severity: 0.5, negativity: 0.2, urgency: 0.2, tier: 0.1 },
  },
];

/** The perturbations swept over every weight, in the order they appear in the report. */
const DELTAS = [-0.1, -0.05, 0.05, 0.1] as const;

/**
 * A fourth configuration, published as a **reference point and not as a candidate**.
 *
 * All weight on the clock is deadline-first scheduling: serve whoever has spent the largest share
 * of their window, and let severity, sentiment and the account decide nothing. It is not proposed —
 * it is the boundary of what the weight family can do about breaches, and reporting it turns "the
 * baseline could be better" into a number instead of an opinion.
 */
const REFERENCE_CONFIG = {
  id: 'C-edf',
  rationale: 'reference point: the clock alone',
  weights: { severity: 0, negativity: 0, urgency: 1, tier: 0 },
} as const;

/**
 * The load regimes the three configurations are replayed under.
 *
 * **This exists because of how the first version of this report was produced, and saying so is the
 * point.** The parameters of the replayed world were chosen *after* seeing that a first, gentler
 * world put two or three tickets in the queue and scored every configuration at τ ≈ 1 — a table of
 * ones. Tuning a world until it shows a difference, and then reporting the difference, is choosing
 * the experiment after seeing the result; it is the same defect a pre-registration exists to stop,
 * and nobody reading a single tuned row could detect it.
 *
 * The remedy is not to hide the tuning but to remove its leverage: the headline configurations are
 * replayed under a light, a nominal and a heavy load, and the conclusion has to survive all three
 * or be reported as regime-dependent. What varies is how long an agent holds a ticket; the arrival
 * stream is byte-identical in every regime, so the comparison stays like-for-like. All three keep
 * the service rate above the arrival rate, which the anti-starvation bound is stated under — a
 * regime that did not would be measuring a collapsing queue rather than a slower one.
 */
const LOAD_REGIMES = [
  { id: 'light', handleMinutes: 12, note: 'the desk keeps up through the day' },
  { id: 'nominal', handleMinutes: 15, note: 'the published world: a backlog builds daily and drains overnight' },
  { id: 'heavy', handleMinutes: 17, note: 'the desk falls behind by day and catches up at night' },
] as const;

/** Weights are carried as hundredths so that every published vector is exactly what it prints. */
const CENTS = 100;

/**
 * Moves one weight by `delta` and takes the difference out of the other three in proportion.
 *
 * Proportional rather than equal: taking the same absolute amount from each of the others would
 * itself be a second, unstated perturbation, and a weight already near zero would go negative.
 *
 * The arithmetic is done in hundredths and the rounding remainder is handed to the largest of the
 * untouched weights — the one it disturbs least in relative terms. Every row of the report is
 * therefore a distribution that sums to exactly one *as printed*, instead of one that sums to one
 * only before it was rounded for display, which a reader cannot check.
 */
export function perturb(base: PriorityWeights, name: WeightName, delta: number): PriorityWeights | null {
  const targetCents = Math.round((base[name] + delta) * CENTS);
  if (targetCents < 0 || targetCents > CENTS) return null;

  const others = WEIGHT_NAMES.filter((other) => other !== name);
  const restCents = CENTS - Math.round(base[name] * CENTS);
  const scale = restCents === 0 ? 0 : (CENTS - targetCents) / restCents;

  const cents = new Map<WeightName, number>();
  for (const other of others) cents.set(other, Math.round(base[other] * CENTS * scale));

  let drift =
    CENTS - targetCents - others.reduce((total, other) => total + (cents.get(other) as number), 0);
  for (const other of [...others].sort((a, b) => (cents.get(b) as number) - (cents.get(a) as number))) {
    if (drift === 0) break;
    const adjusted = (cents.get(other) as number) + drift;
    if (adjusted < 0) continue;
    cents.set(other, adjusted);
    drift = 0;
  }
  if (drift !== 0) return null;

  const next: PriorityWeights = { ...base };
  next[name] = targetCents / CENTS;
  for (const other of others) next[other] = (cents.get(other) as number) / CENTS;

  assertValidWeights(next);
  return next;
}

type Measurement = {
  id: string;
  rationale: string;
  weights: PriorityWeights;
  tau: number;
  tauMin: number;
  headOverlap: number;
  breachRate: number;
  breachDelta: number;
  maxWaitMinutes: number;
  p95WaitMinutes: number;
};

/**
 * What every row is measured against: the queues the baseline actually presented, and the outcome
 * it achieved.
 *
 * The reordering is measured on **snapshots of the waiting set**, not on the month's service
 * sequence. Two tickets that arrive a week apart are never in the queue together, so no weighting
 * can put them in the wrong order relative to each other; counting those pairs would drown the
 * comparison in agreement nobody chose. A snapshot is the set of tickets that really were
 * competing for the next agent, and it is the only set where the order is a decision.
 */
type Baseline = {
  breachRate: number;
  snapshots: readonly { at: number; waiting: SimTicket[]; order: string[] }[];
};

/** Snapshots below this size are too small for a rank correlation to mean anything. */
const MIN_SNAPSHOT = 10;

/** Signals a replayed world whose service rate did not keep up — exit code 3, never a silent row. */
export class UnstableWorldError extends Error {}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function measure(
  id: string,
  rationale: string,
  weights: PriorityWeights,
  arrivals: readonly SimTicket[],
  reference: Baseline,
  handleMs: number = DEFAULT_REPLAY.handleMs,
): Measurement {
  const result = replay({ arrivals, weights, ...DEFAULT_REPLAY, handleMs });
  if (result.unserved.length > 0) {
    throw new UnstableWorldError(
      `configuration ${id} left ${result.unserved.length} tickets unserved: the replayed world is not stable`,
    );
  }

  const taus: number[] = [];
  const overlaps: number[] = [];
  for (const snapshot of reference.snapshots) {
    if (snapshot.waiting.length < MIN_SNAPSHOT) continue;
    const order = rankSnapshot({ at: snapshot.at, waiting: snapshot.waiting }, weights);
    taus.push(kendallTau(snapshot.order, order));
    if (snapshot.waiting.length >= PAGE) {
      overlaps.push(topKOverlap(snapshot.order, order, PAGE));
    }
  }

  return {
    id,
    rationale,
    weights,
    tau: mean(taus),
    tauMin: taus.length === 0 ? 1 : Math.min(...taus),
    headOverlap: mean(overlaps),
    breachRate: result.breachRate,
    breachDelta: result.breachRate - reference.breachRate,
    maxWaitMinutes: result.maxWaitMs / 60000,
    p95WaitMinutes: result.p95WaitMs / 60000,
  };
}

function weightsCell(weights: PriorityWeights): string {
  return `(${weights.severity.toFixed(2)}, ${weights.negativity.toFixed(2)}, ${weights.urgency.toFixed(2)}, ${weights.tier.toFixed(2)})`;
}

/** `-0.0000` and `0.0000` are the same number and must be the same bytes. */
function fixed(value: number, digits: number): string {
  const text = (value + 0).toFixed(digits);
  return text === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : text;
}

function percent(value: number): string {
  return `${fixed(value * 100, 2)} %`;
}

function signed(value: number, digits: number): string {
  const text = fixed(value * 100, digits);
  return text.startsWith('-') ? `${text} pp` : `+${text} pp`;
}

export type ReportInput = {
  seed: string;
  arrivalCount: number;
};

export function buildReport(input: ReportInput): string {
  const arrivals = generateArrivals({ seed: input.seed, count: input.arrivalCount });

  // The baseline replay is run once and every other row is compared against it, C-base included:
  // its τ of exactly 1 and its zero delta are not decoration, they are the run saying that two
  // replays of one configuration produced the same month.
  const baselineOf = (handleMs: number) => {
    const run = replay({ arrivals, weights: DEFAULT_PRIORITY_WEIGHTS, ...DEFAULT_REPLAY, handleMs });
    if (run.unserved.length > 0) {
      throw new UnstableWorldError(
        `the baseline left ${run.unserved.length} tickets unserved at ${handleMs / 60000} min per ticket: the replayed world is not stable`,
      );
    }
    return {
      run,
      reference: {
        breachRate: run.breachRate,
        snapshots: run.snapshots.map((snapshot) => ({
          at: snapshot.at,
          waiting: snapshot.waiting,
          order: rankSnapshot(snapshot, DEFAULT_PRIORITY_WEIGHTS),
        })),
      } satisfies Baseline,
    };
  };

  const base = baselineOf(DEFAULT_REPLAY.handleMs).run;
  const reference = baselineOf(DEFAULT_REPLAY.handleMs).reference;
  const scored = reference.snapshots.filter((snapshot) => snapshot.waiting.length >= MIN_SNAPSHOT);
  const paged = scored.filter((snapshot) => snapshot.waiting.length >= PAGE);

  const headline = [...NAMED_CONFIGS, REFERENCE_CONFIG];
  const named = headline.map((config) =>
    measure(config.id, config.rationale, config.weights, arrivals, reference),
  );

  // The same headline configurations under a lighter and a heavier desk, each against its own
  // regime's baseline, so that a conclusion which only holds at one staffing level says so.
  const regimes = LOAD_REGIMES.map((regime) => {
    const handleMs = regime.handleMinutes * 60_000;
    const local = baselineOf(handleMs);
    return {
      regime,
      peakQueueLength: local.run.peakQueueLength,
      rows: headline.map((config) =>
        measure(config.id, config.rationale, config.weights, arrivals, local.reference, handleMs),
      ),
    };
  });

  const sweep: Measurement[] = [];
  for (const name of WEIGHT_NAMES) {
    for (const delta of DELTAS) {
      const weights = perturb(DEFAULT_PRIORITY_WEIGHTS, name, delta);
      if (weights === null) continue;
      const id = `w_${name} ${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
      sweep.push(measure(id, 'perturbation', weights, arrivals, reference));
    }
  }

  const window = arrivals.length === 0
    ? 0
    : ((arrivals[arrivals.length - 1] as SimTicket).createdAt - (arrivals[0] as SimTicket).createdAt) /
      (24 * 60 * 60 * 1000);

  const lines: string[] = [];
  lines.push('<!-- generated by src/alg/sensitivity.ts — do not edit -->');
  lines.push('');
  lines.push('# Weight sensitivity of the composite priority');
  lines.push('');
  lines.push(
    'Generated by `src/alg/sensitivity.ts`. Do not edit this file: the harness regenerates it and',
    'compares the result byte for byte, so a hand-edit fails the build rather than surviving in it.',
  );
  lines.push('');
  lines.push('## What was replayed');
  lines.push('');
  lines.push(`| Parameter | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Seed | \`${input.seed}\` |`);
  lines.push(`| Arrivals | ${arrivals.length} |`);
  lines.push(`| Replayed window | ${fixed(window, 1)} days |`);
  lines.push(`| Agents | ${DEFAULT_REPLAY.agents} |`);
  lines.push(`| Handling time | ${DEFAULT_REPLAY.handleMs / 60000} min per ticket |`);
  lines.push(`| Queue sweep | every ${DEFAULT_REPLAY.tickMs / 1000} s |`);
  lines.push(`| Premium share | ${percent(DEFAULT_ARRIVALS.premiumShare)} |`);
  lines.push(`| Severity shares (1→4) | ${DEFAULT_ARRIVALS.severityShares.map((s) => s.toFixed(2)).join(', ')} |`);
  lines.push(`| Busy hours (UTC) | ${DEFAULT_ARRIVALS.busyHoursUtc[0]}:00–${DEFAULT_ARRIVALS.busyHoursUtc[1]}:00 at full intensity, ${percent(DEFAULT_ARRIVALS.quietIntensity)} outside |`);
  lines.push(`| Peak queue length | ${base.peakQueueLength} tickets |`);
  lines.push(`| Queue snapshots | every ${DEFAULT_REPLAY.snapshot === null ? 0 : DEFAULT_REPLAY.snapshot.everyMs / (60 * 60 * 1000)} h: ${reference.snapshots.length} taken, ${scored.length} with at least ${MIN_SNAPSHOT} waiting, ${paged.length} with at least ${PAGE} |`);
  lines.push('');
  lines.push(
    'Every configuration is replayed against **the same** stream of arrivals, so a difference in',
    'the columns below is a difference the weights made and nothing else. The breach rate counts',
    'tickets picked up by an agent after their first-response target had already passed.',
  );
  lines.push('');
  lines.push(
    'The reordering columns are measured on the snapshots: the waiting sets the baseline actually',
    'presented, re-ordered under each configuration. Tickets that were never in the queue at the',
    'same time are never compared, because nothing chose the order between them.',
  );
  lines.push('');
  lines.push('## The three declared configurations');
  lines.push('');
  lines.push('| Config | w = (s, n, u, v) | Rationale | τ vs baseline | Worst snapshot τ | Head of queue kept | Breach rate | Δ vs baseline |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const row of named) {
    lines.push(
      `| ${row.id} | ${weightsCell(row.weights)} | ${row.rationale} | ${fixed(row.tau, 4)} | ${fixed(row.tauMin, 4)} | ${percent(row.headOverlap)} | ${percent(row.breachRate)} | ${signed(row.breachDelta, 2)} |`,
    );
  }
  lines.push('');
  lines.push(
    `*Head of queue kept* is the share of the first ${PAGE} tickets of the baseline's queue that this`,
    `configuration also places in its own first ${PAGE}, averaged over the snapshots that held at`,
    `least ${PAGE} tickets.`,
  );
  lines.push('');
  lines.push('## Does it survive a different load?');
  lines.push('');
  lines.push(
    'The world above was **chosen**, and an honest reading of one tuned world is that it proves',
    'very little: parameters picked until a table shows a difference will show a difference. The',
    'same arrivals are therefore replayed against a faster and a slower desk, each configuration',
    "compared with its own regime's baseline. A conclusion that changes sign between these rows is",
    'a conclusion about the staffing level, not about the weights.',
  );
  lines.push('');
  lines.push('| Load | Handling time | Peak queue | Config | τ vs baseline | Breach rate | Δ vs baseline |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const entry of regimes) {
    for (const row of entry.rows) {
      lines.push(
        `| ${entry.regime.id} | ${entry.regime.handleMinutes} min | ${entry.peakQueueLength} | ${row.id} | ${fixed(row.tau, 4)} | ${percent(row.breachRate)} | ${signed(row.breachDelta, 2)} |`,
      );
    }
  }
  lines.push('');
  for (const entry of regimes) {
    lines.push(`- **${entry.regime.id}** — ${entry.regime.note}.`);
  }
  lines.push('');
  lines.push('## One weight at a time');
  lines.push('');
  lines.push(
    'Each row moves a single weight and takes the difference out of the other three in proportion,',
    'so every row is still a distribution and the only thing that changed is the one named weight.',
  );
  lines.push('');
  lines.push('| Perturbation | w = (s, n, u, v) | τ vs baseline | Worst snapshot τ | Head of queue kept | Breach rate | Δ vs baseline | p95 wait | Max wait |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of sweep) {
    lines.push(
      `| ${row.id} | ${weightsCell(row.weights)} | ${fixed(row.tau, 4)} | ${fixed(row.tauMin, 4)} | ${percent(row.headOverlap)} | ${percent(row.breachRate)} | ${signed(row.breachDelta, 2)} | ${fixed(row.p95WaitMinutes, 1)} min | ${fixed(row.maxWaitMinutes, 1)} min |`,
    );
  }
  lines.push('');
  lines.push('## How to read it');
  lines.push('');
  lines.push(
    "- **τ** is Kendall's rank correlation between this configuration's queue and the baseline's,",
    '  averaged over the snapshots. 1.0000 is the same queue; the further below 1, the more pairs of',
    '  waiting tickets the two configurations would hand to an agent in opposite order.',
    '- **Worst snapshot τ** is the same measure at the moment the two disagreed most. An average',
    '  close to 1 with a low worst case means the configurations diverge exactly when the queue is',
    '  contended, which is the only time the order matters.',
    '- **Head of queue kept** is the operational reading: τ can stay high while the first page — the',
    '  only part an agent sees today — turns over.',
    '- **Breach rate** is the outcome the weights exist to move. A reordering that changes τ a lot',
    '  and the breach rate not at all has rearranged the queue without helping anybody.',
    '- **Max wait** is bounded in every row, which is the anti-starvation bound holding under',
    '  perturbation rather than only at the published weights.',
    '- **C-edf** is not a candidate. It puts every weight on the clock, so severity, sentiment and',
    '  the account decide nothing, and it is here to mark the boundary: it is the least breaching',
    '  queue this family of weights can produce, and it is also the queue least like the one the',
    '  policy asks for. The distance between it and C-base is the price the policy is paying for',
    '  taking anything other than the deadline into account — a number, where there was an opinion.',
  );
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function fail(code: number, message: string): never {
  process.stderr.write(`sensitivity: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: readonly string[]): { out: string; seed: string; arrivals: number; check: boolean } {
  const flags = new Map<string, string>();
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === '--check') {
      check = true;
      continue;
    }
    if (!token.startsWith('--')) fail(1, `unexpected argument '${token}'`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(1, `--${token.slice(2)} needs a value`);
    flags.set(token.slice(2), value);
    i++;
  }

  const arrivals = Number(flags.get('arrivals') ?? DEFAULT_ARRIVALS.count);
  if (!Number.isInteger(arrivals) || arrivals < 2) fail(1, `--arrivals must be an integer above 1`);

  return {
    out: flags.get('out') ?? 'reports/weight_sensitivity.md',
    seed: flags.get('seed') ?? DEFAULT_ARRIVALS.seed,
    arrivals,
    check,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  let report: string;
  try {
    report = buildReport({ seed: args.seed, arrivalCount: args.arrivals });
  } catch (error) {
    if (error instanceof UnstableWorldError) fail(3, error.message);
    throw error;
  }

  if (args.check) {
    let onDisk: string;
    try {
      onDisk = readFileSync(args.out, 'utf8');
    } catch {
      fail(2, `${args.out} does not exist; run this generator without --check to create it`);
    }
    if (onDisk !== report) {
      fail(2, `${args.out} differs from what this run produced; regenerate it instead of editing it`);
    }
    process.stdout.write(`${args.out} is current\n`);
    return;
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, report, 'utf8');
  process.stdout.write(`${args.out} written\n`);
}

// Runs only when invoked as a program; importing this module for its pure parts costs nothing.
if (process.argv[1] !== undefined && process.argv[1].endsWith('sensitivity.ts')) {
  main();
}
