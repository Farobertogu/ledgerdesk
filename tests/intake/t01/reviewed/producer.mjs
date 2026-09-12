import { extract } from './adapter.mjs';
const [profile, input, mutation] = process.argv.slice(2);
try { process.stdout.write(JSON.stringify(await extract(input, profile, mutation))); }
catch (error) { process.stdout.write(JSON.stringify({ error: error.code ?? 'parse_failure', detail: String(error.message).slice(0, 200) })); }
