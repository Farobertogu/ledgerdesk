import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEvidenceDirectory } from '../../ci/access_evidence.mjs';

test('separate runs cannot overwrite or merge evidence, including reused IDs', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ledgerdesk-evidence-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('ledgerdesk-evidence-test-'));
    rmSync(root, { recursive: true });
  });
  const first = createEvidenceDirectory(
    root,
    'access-administration',
    'baseline',
    'run-one',
  );
  writeFileSync(path.join(first, 'run.log'), 'first observation');
  const second = createEvidenceDirectory(
    root,
    'access-administration',
    'baseline',
    'run-two',
  );
  writeFileSync(path.join(second, 'run.log'), 'second observation');
  assert.throws(
    () =>
      createEvidenceDirectory(
        root,
        'access-administration',
        'baseline',
        'run-one',
      ),
    { code: 'EEXIST' },
  );
  assert.equal(
    readFileSync(path.join(first, 'run.log'), 'utf8'),
    'first observation',
  );
  assert.equal(
    readFileSync(path.join(second, 'run.log'), 'utf8'),
    'second observation',
  );
  for (const bad of ['..', '../escape', '/absolute', 'x\\y', 'x/y', ''])
    assert.throws(
      () =>
        createEvidenceDirectory(
          root,
          'access-administration',
          bad,
          'run-three',
        ),
      /Invalid evidence/,
    );
});
