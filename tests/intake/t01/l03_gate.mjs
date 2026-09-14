import assert from 'node:assert/strict';

// One process, one release, then the unchanged native allocation/CPU fixture.
// The controller inspects the real membership before releasing this gate.
const mode = process.argv[2];
assert.ok(['memory', 'cpu'].includes(mode));
let received = '';
await new Promise((resolve, reject) => {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    received += chunk;
    if (received.length > 4) reject(Error('L03_GATE_INPUT'));
  });
  process.stdin.on('end', () => received === 'run\n' ? resolve() : reject(Error('L03_GATE_INPUT')));
  process.stdin.on('error', reject);
  process.stdout.write('L03_READY\n');
});
process.argv = [process.execPath, '/work/probe.mjs', mode];
await import('./probe.mjs');
