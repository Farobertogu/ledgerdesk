// Fixed exploratory detection rule, declared before observation. Not a production latency SLA
// or proof that an adversary cannot exploit a smaller difference with a larger sample.
export const TIMING_PROTOCOL = Object.freeze({
  warmupRounds: 12, rounds: 128, seed: 20260909, permutations: 999,
  familyAlpha: 0.01, minimumAbsoluteCliffDelta: 0.33,
});
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)];
};
function cliff(a, b) {
  let score = 0;
  for (const x of a) for (const y of b) score += x > y ? 1 : x < y ? -1 : 0;
  return score / (a.length * b.length);
}
export function compareTiming(groups) {
  let state = TIMING_PROTOCOL.seed;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const entries = Object.entries(groups);
  const comparisons = entries.length * (entries.length - 1) / 2;
  const pairs = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const [aName, a] = entries[i], [bName, b] = entries[j];
    const effect = cliff(a, b), observed = Math.abs(median(a) - median(b));
    let extreme = 0;
    const pool = [...a, ...b];
    for (let run = 0; run < TIMING_PROTOCOL.permutations; run++) {
      const shuffled = [...pool];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const target = Math.floor(random() * (k + 1)); [shuffled[k], shuffled[target]] = [shuffled[target], shuffled[k]];
      }
      if (Math.abs(median(shuffled.slice(0, a.length)) - median(shuffled.slice(a.length))) >= observed) extreme++;
    }
    const p = (extreme + 1) / (TIMING_PROTOCOL.permutations + 1);
    pairs.push({ a: aName, b: bName, medianDifferenceMs: median(a) - median(b), cliffDelta: effect, p,
      detected: p <= TIMING_PROTOCOL.familyAlpha / comparisons && Math.abs(effect) >= TIMING_PROTOCOL.minimumAbsoluteCliffDelta });
  }
  return { protocol: TIMING_PROTOCOL, summaries: Object.fromEntries(entries.map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [name, { count: values.length, medianMs: median(values), p95Ms: sorted[Math.floor(sorted.length * .95)] }];
  })), pairs, signalDetected: pairs.some((pair) => pair.detected) };
}
