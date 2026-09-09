// Explicit standalone T04 terminal. No legacy environment loader or demo identity provider.
import { startReadingTerminal } from '../src/server/reading/terminal.ts';
import { PgReadingStore } from '../src/server/reading/postgres/store.ts';

const port = Number(process.env.LEDGERDESK_READING_HTTP_PORT ?? 3002);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid reading HTTP port');
const terminal = await startReadingTerminal({
  env: process.env, port,
  createStore: (onLoss) => new PgReadingStore({
    connectionString: process.env.LEDGERDESK_READING_PG_URL ?? '',
    expectedPort: Number(process.env.LEDGERDESK_READING_PG_PORT),
  }, onLoss),
});
console.log(`Reading trial listening on ${terminal.url}; synthetic data only; temporal conformity remains partial.`);
let closing = false;
const close = async () => { if (!closing) { closing = true; await terminal.close(); } };
process.once('SIGINT', close); process.once('SIGTERM', close);
