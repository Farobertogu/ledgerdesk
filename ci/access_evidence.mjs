import { mkdirSync } from 'node:fs';
import path from 'node:path';

/** Each execution owns one new directory. Reusing an ID fails without overwriting. */
export function createEvidenceDirectory(root, suite, variant, runId) {
  for (const value of [suite, variant, runId])
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
      throw Error('Invalid evidence path component');
  const parent = path.resolve(root, suite, variant);
  mkdirSync(parent, { recursive: true });
  const target = path.join(parent, runId);
  mkdirSync(target);
  return target;
}
