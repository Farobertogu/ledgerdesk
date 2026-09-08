// Typed entry point; the same executable source is used by next.config.mjs before startup.
export { readTrialConfig, assertTrialLaunch, TrialConfigurationError } from './config.mjs';
export type { TrialConfig } from './config.mjs';
