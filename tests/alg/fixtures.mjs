/**
 * Fixtures for the algorithm tests.
 *
 * Two builders and one set of thresholds. The builders return a ticket that trips **nothing**: no
 * clause of the escalation rule fires on it and no anomaly is recorded for it. Every test below
 * therefore states its case by naming the one field it changes, and a test that passes for the
 * wrong reason is visible in the diff rather than hidden in a wall of setup.
 *
 * The thresholds are seeded here rather than taken from the module's defaults. A rule whose tests
 * only pass at one setting of its parameters is not a rule, it is a constant; these tests must
 * keep passing when the calibration lands and moves those numbers.
 */

export const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Thresholds chosen to differ from every published default, on purpose. */
export const THRESHOLDS = {
  confidence: 0.7,
  sentiment: -0.5,
  maxRetries: 2,
  premiumSeverity: 0.75,
  supportedLanguages: ['en'],
  nullSentimentConfidencePenalty: 0.25,
};

/** A ticket in the queue, one hour into a four-hour window, with nothing remarkable about it. */
export function queueTicket(overrides = {}) {
  return {
    id: 'T-000001',
    severity: 2,
    sentiment: 0,
    tier: 'standard',
    valueBand: 3,
    createdAt: T0,
    slaDueAt: T0 + 4 * HOUR,
    now: T0 + HOUR,
    ...overrides,
  };
}

/** The same ticket, carrying every field the escalation rule reads, none of them firing. */
export function escalationTicket(overrides = {}) {
  return {
    ...queueTicket(),
    confidence: 0.9,
    retries: 0,
    language: 'en-AU',
    redactedBodyLength: 120,
    kbResultCount: 3,
    grounded: true,
    policyFlags: [],
    ...overrides,
  };
}
