// The owned trial launcher validates before starting Next. Next's own Ready message can
// precede lazy app/instrumentation initialization, so it is not a configuration oracle.
import { createRequire } from 'node:module';
import nextEnv from '@next/env';
import { readTrialConfig, assertTrialLaunch } from '../src/server/reading/config.mjs';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0]))) throw new Error('Usage: reading_start.mjs [local-port]');
const port = Number(args[0] ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local trial port');
process.env.NODE_ENV = 'production';
nextEnv.loadEnvConfig(process.cwd(), false);
const nextBin = require.resolve('next/dist/bin/next');
process.argv = [process.execPath, nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(port)];
assertTrialLaunch(readTrialConfig(process.env), process.argv);
await import(pathToFileURL(nextBin).href);
