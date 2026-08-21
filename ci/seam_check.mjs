// ci/seam_check.mjs — test_ARCH_seam_holds
//
// The module boundary is one of this project's titled promises, and until now it was held by
// reading the code rather than by a check. Three assertions, all static: no database, no install,
// no build. It runs in the same job as every other repository check, on every pull request.
//
//   test_ARCH_app_cannot_import_quality  · the application never reaches into the quality layer
//   test_ARCH_quality_cannot_import_app  · and the quality layer never reaches back
//   test_SEC_no_direct_sdk_import        · a model SDK may be imported in one file and no other
//
// Relative paths are RESOLVED, not pattern-matched. It matters: the application's tsconfig maps
// `@/*` to `./src/*` and nothing else, so a violation could not arrive as a bare `quality/...`
// specifier — it would have to climb out with `../../quality/...`, which a specifier-name check
// would walk straight past.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);

/**
 * The single chokepoint a model SDK is allowed to be imported from. It may or may not exist yet — the
 * gateway is a later increment — and that is precisely why the rule is written now: a check
 * authored after the SDK arrives is a check that lets the first violation through.
 */
const GATEWAY = 'agents/gateway.ts';

const SDK = /^(?:@anthropic-ai\/|@openai\/|@langchain\/|@google\/generative-ai|@google\/genai|@mistralai\/|@aws-sdk\/client-bedrock-runtime|anthropic|openai|langchain|llamaindex|cohere-ai|mistralai|ollama|replicate|groq-sdk)/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (CODE.test(entry)) out.push(full);
  }
  return out;
}

/** Every module specifier a file names, in any of the four forms one can be written. */
function specifiers(file) {
  const source = readFileSync(file, 'utf8');
  const found = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, // import … from · export … from
    /^\s*import\s+['"]([^'"]+)['"]/gm, // side-effect import
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
const inside = (target, dir) => {
  const r = path.relative(path.join(ROOT, dir), target);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};

const violations = [];

function crossing(fromDir, intoDir, testName) {
  for (const file of walk(path.join(ROOT, fromDir))) {
    for (const spec of specifiers(file)) {
      if (new RegExp(`^${intoDir}(?:/|$)`).test(spec)) {
        violations.push(`${testName}: ${rel(file)} imports '${spec}'`);
        continue;
      }
      if (!spec.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), spec);
      if (inside(resolved, intoDir)) {
        violations.push(
          `${testName}: ${rel(file)} imports '${spec}', which resolves into ${intoDir}/`,
        );
      } else if (!inside(resolved, fromDir)) {
        violations.push(
          `${testName}: ${rel(file)} imports '${spec}', which resolves outside ${fromDir}/`,
        );
      }
    }
  }
}

crossing('src', 'quality', 'test_ARCH_app_cannot_import_quality');
crossing('quality', 'src', 'test_ARCH_quality_cannot_import_app');

for (const file of walk(ROOT)) {
  if (rel(file) === GATEWAY) continue;
  for (const spec of specifiers(file)) {
    if (SDK.test(spec)) {
      violations.push(
        `test_SEC_no_direct_sdk_import: ${rel(file)} imports '${spec}' outside ${GATEWAY}`,
      );
    }
  }
}

// A declared dependency with no chokepoint to hold it is the plan's ordering rule broken — the
// gateway comes before any agent — so it is caught here rather than at the first call site. Once
// the gateway exists the dependency is legitimate and the import rule above does the real work.
if (!existsSync(path.join(ROOT, GATEWAY))) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const name of declared) {
    if (SDK.test(name)) {
      violations.push(
        `test_SEC_no_direct_sdk_import: package.json declares '${name}' while ${GATEWAY} does not exist`,
      );
    }
  }
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log('test_ARCH_app_cannot_import_quality OK');
console.log('test_ARCH_quality_cannot_import_app OK');
console.log('test_SEC_no_direct_sdk_import OK (no model SDK in the tree or the manifest)');
