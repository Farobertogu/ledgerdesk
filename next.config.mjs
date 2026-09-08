import { readTrialConfig, assertTrialLaunch } from './src/server/reading/config.mjs';

// Revalidate when Next loads configuration; ci/reading_start.mjs validates before server startup.
const readingTrial = readTrialConfig(process.env);
if (process.argv.includes('start') || process.argv.includes('dev')) {
  assertTrialLaunch(readingTrial, process.argv);
}

// Shared framework configuration, with identity confined to explicit legacy consumers.
//
// tsconfigPath points at a configuration of the application's own: the tsconfig.json at the root
// belongs to the quality layer (NodeNext, no JSX) and typechecking both trees from one file would
// mean loosening the settings of a tree that does not need loosening.

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { tsconfigPath: './tsconfig.app.json' },
};

export default nextConfig;
