import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { startAccessTerminal } from '../../src/server/access/terminal.ts';

export async function journeyTerminal(mutation = '') {
  if (!mutation || mutation === 'early-failure')
    return { start: startAccessTerminal, clean() {} };
  const changes = {
    'drop-bootstrap-materialization': [
      'bootstrap.ts',
      'for (const f of faculties)\n    await q',
      'for (const f of [])\n    await q',
    ],
    'drop-bootstrap-revision': [
      'bootstrap.ts',
      'p.revision !== f.permission_revision',
      'false',
    ],
    'drop-bootstrap-root-binding': [
      'bootstrap.ts',
      'canonicalValue(d.root) !== canonicalValue(control.root)',
      'false',
    ],
    'drop-bootstrap-exercise-bound': [
      'bootstrap.ts',
      "(f.exercise_or_grant === 'exercise' &&\n        !['invite', 'read_people'].includes(f.permission_id))",
      'false',
    ],
    'drop-journey-reading-authority': [
      'authenticated_reading.ts',
      'limitHierarchy(row.hierarchy,maximum,expiresAt)',
      "limitHierarchy(row.hierarchy,'CONTENT',expiresAt)",
    ],
    'drop-journey-evidence': [
      'authenticated_reading.ts',
      "'INSERT INTO material_trial.evidence VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)'",
      "'SELECT $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::json,$7::text,$8::json,$9::int,$10::bigint'",
    ],
  };
  assert.ok(changes[mutation], 'Named mutation');
  const root = '/work/output/journey-mutant-' + randomUUID();
  const clean = () => {
    assert.ok(root.startsWith('/work/output/journey-mutant-'));
    rmSync(root, { recursive: true, force: true });
  };
  try {
    cpSync('/work/src', root + '/src', { recursive: true });
    const [file, from, to] = changes[mutation],
      target = root + '/src/server/access/' + file,
      source = readFileSync(target, 'utf8');
    assert.equal(source.split(from).length - 1, 1, 'Exact mutation site');
    writeFileSync(target, source.replace(from, to));
    return {
      start: (
        await import(
          pathToFileURL(root + '/src/server/access/terminal.ts').href
        )
      ).startAccessTerminal,
      clean,
    };
  } catch (e) {
    clean();
    throw e;
  }
}
