// @ts-check
/** Server-only configuration shared with the startup hook.
 * This verifies declared environment and CLI binding, not physical DB isolation.
 * @typedef {Readonly<{ deploymentId: 'inc01-synthetic', scopeId: 'inc01-material', subjectId: string, generation: string }>} TrialConfig
 */
export class TrialConfigurationError extends Error {
  constructor() {
    super('Invalid isolated reading trial configuration');
    this.name = 'TrialConfigurationError';
  }
}

/** @param {Readonly<Record<string, string | undefined>>} env
 * @returns {TrialConfig | null}
 */
export function readTrialConfig(env) {
  const flag = env.LEDGERDESK_READING_TRIAL;
  if (flag === undefined || flag === '' || flag === '0') return null;
  const subjectId = env.LEDGERDESK_READING_SUBJECT;
  const generation = env.LEDGERDESK_READING_GENERATION;
  if (flag !== '1' || env.LEDGERDESK_READING_ENVIRONMENT !== 'local-synthetic'
      || typeof subjectId !== 'string' || !/^synthetic-[A-Za-z0-9_-]{1,64}$/.test(subjectId)
      || typeof generation !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(generation)) {
    throw new TrialConfigurationError();
  }
  return Object.freeze({ deploymentId: 'inc01-synthetic', scopeId: 'inc01-material', subjectId, generation });
}

/** Check the actual Next CLI binding argument, not request Host or an environment label.
 * Other hosting adapters need their own verified binding before enabling this local trial.
 * @param {TrialConfig | null} config
 * @param {readonly string[]} argv
 */
export function assertTrialLaunch(config, argv) {
  if (!config) return;
  const bindings = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hostname' || argv[i] === '-H') bindings.push(argv[++i] ?? '');
    else if (argv[i].startsWith('--hostname=')) bindings.push(argv[i].slice('--hostname='.length));
  }
  if (bindings.length !== 1 || bindings[0] !== '127.0.0.1') throw new TrialConfigurationError();
}
