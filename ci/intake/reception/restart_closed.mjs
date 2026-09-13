// The test host first observes/removes the exact old process set. This helper
// validates retained terminal state; it does not infer process death from JSON.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PrivatePhaseJournal } from './private_phase.mjs';
const input = JSON.parse(process.argv[2] ?? '{}');
if (process.platform !== 'linux' || process.getuid() !== 1000 ||
  !/^[a-f0-9]{64}$/.test(input.oldContainerId ?? '') || !/^[a-f0-9-]{36}$/.test(input.phaseId ?? '')) throw Error('CLOSED_RESTART_SCOPE');
const journal = PrivatePhaseJournal.reopen('/output/phase-control', 'objects');
if (journal.rows[input.phaseId]?.state !== 'closed' || Object.values(journal.rows).some(row => row.state !== 'closed')) throw Error('CLOSED_RESTART_NONTERMINAL');
const bytes = fs.readFileSync(journal.file), identity = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const socket = '/run/intake-t02/objects/channel.sock';
if (!fs.lstatSync(socket).isSocket()) throw Error('CLOSED_RESTART_SOCKET');
fs.unlinkSync(socket);
const record = { input, retainedJournal: identity, phaseState: journal.rows[input.phaseId].state, atMs: Date.now() };
fs.writeFileSync('/output/closed-restart-' + input.phaseId + '.json', JSON.stringify(record, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ok: true, ...record }));
