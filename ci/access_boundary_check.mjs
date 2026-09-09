import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleReferences } from './reading_boundary_check.mjs';

const access = (name) => /^src\/contracts\/access(?:_[a-z]+)?\.ts$/.test(name) || name.startsWith('src/server/access/');
export function accessSourceViolations(file, source) {
  const { references, computed } = moduleReferences(source, { jsx: /[jt]sx$/.test(file) });
  const errors = [];
  if (access(file) && computed.length) errors.push('Computed module loading in access boundary');
  for (const { specifier } of references) {
    let target = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` :
      specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : null;
    if (target && !/\.[cm]?[jt]sx?$/.test(target)) target += '.ts';
    if (access(file)) {
      const allowed = target ? access(target) : file.startsWith('src/server/access/') && specifier === 'node:crypto';
      if (!allowed) errors.push(`Forbidden access import: ${specifier}`);
      if (file.startsWith('src/contracts/') && target?.startsWith('src/server/')) errors.push('Contract imports server');
    } else if (target && access(target)) errors.push('Access foundation has no operational composition root in T01');
  }
  return errors;
}
export function checkAccessBoundaries(root) {
  let count = 0; const errors = [];
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (/\.[cm]?[jt]sx?$/.test(item.name)) {
        const relative = path.relative(root, full).split(path.sep).join('/');
        count++;
        for (const error of accessSourceViolations(relative, readFileSync(full, 'utf8'))) errors.push(`${relative}: ${error}`);
      }
    }
  }
  walk(path.join(root, 'src'));
  return { count, errors };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkAccessBoundaries(fileURLToPath(new URL('../', import.meta.url)));
  if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
  else console.log(`Access foundation boundary: ${result.count} source modules inspected`);
}
