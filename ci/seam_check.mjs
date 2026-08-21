// ci/seam_check.mjs — test_ARCH_seam_holds
//
// The module boundary is one of this project's titled promises, and until now it was held by
// reading the code rather than by a check. Four assertions, all static: no database, no install,
// no build. It runs in the same job as every other repository check, on every pull request.
//
//   test_ARCH_app_cannot_import_quality          · the application never reaches into the quality layer
//   test_ARCH_quality_cannot_import_app          · and the quality layer never reaches back
//   test_SEC_no_direct_sdk_import                · a model SDK may be imported where it is declared and nowhere else
//   test_SEC_providers_only_from_composition_root · and a provider may be reached only by the wiring
//
// Relative paths are RESOLVED, not pattern-matched. It matters: the application's tsconfig maps
// `@/*` to `./src/*` and nothing else, so a violation could not arrive as a bare `quality/...`
// specifier — it would have to climb out with `../../quality/...`, which a specifier-name check
// would walk straight past.
//
// ## The SDK exemption widened, and the rule that replaces what the narrowing gave (ADR-025)
//
// This check allowed a provider SDK in exactly ONE file, `agents/gateway.ts`, and it was written
// before any provider existed precisely so that the first violation would be caught rather than
// grandfathered. The first thing that genuinely needs it is a real provider adapter, which is not
// the gateway and must not be — the gateway's shape is "redact, attest, price, call, record" and a
// vendor client belongs behind it, not inside it.
//
// So the exemption is a directory now, and it is paired with a second assertion that makes the pair
// stricter than the single file was: `agents/providers/**` may be imported from the composition
// root and from nowhere else. The gateway remains the only CALLER of a provider — it receives one
// as configuration — and no handler, page, runner or algorithm can reach past it to pick one up.
// "One file may import the SDK" becomes "the SDK lives in a directory nothing can reach except the
// wiring", which is a narrower guarantee stated as two rules instead of one.
//
// **`tests/` is outside the second rule, and the exclusion is declared rather than quiet.** A test
// imports a fixture provider directly in order to assert what it answers, which is the whole point
// of a fixture and is not a runtime path: nothing under `tests/` is built, served or deployed. The
// rule covers `src/` and `agents/`, which is everything that runs.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage']);

/**
 * The chokepoint a model SDK may be imported from, and the directory a provider adapter lives in.
 *
 * The rule was authored before either existed, which is precisely why it caught the first case that
 * needed it instead of grandfathering it.
 */
const GATEWAY = 'agents/gateway.ts';

/** Where a provider adapter lives. Reachable only from the composition root; see the header. */
const PROVIDERS = 'agents/providers';

/** The one file allowed to choose a provider. */
const COMPOSITION_ROOT = 'src/server/agents.ts';

/** Files that may name a module SDK: the gateway, and anything under the providers directory. */
const sdkIsAllowedIn = (relative) =>
  relative === GATEWAY || relative === PROVIDERS || relative.startsWith(`${PROVIDERS}/`);

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
  if (sdkIsAllowedIn(rel(file))) continue;
  for (const spec of specifiers(file)) {
    if (SDK.test(spec)) {
      violations.push(
        `test_SEC_no_direct_sdk_import: ${rel(file)} imports '${spec}' outside ${GATEWAY} and ${PROVIDERS}/`,
      );
    }
  }
}

/**
 * Whether a specifier names something inside the providers directory, in any of the three forms it
 * can be written: the `@agents/*` alias the application's tsconfig maps, a bare path from the root,
 * or a relative path that resolves in.
 */
function reachesProviders(file, spec) {
  for (const prefix of ['@agents/', 'agents/']) {
    if (spec.startsWith(prefix)) {
      const tail = spec.slice(prefix.length);
      return tail === 'providers' || tail.startsWith('providers/');
    }
  }
  if (!spec.startsWith('.')) return false;
  return inside(path.resolve(path.dirname(file), spec), PROVIDERS);
}

// `src/` and `agents/` — everything that is built, served or deployed. See the header for why
// `tests/` is outside this rule and why that is stated rather than assumed.
for (const directory of ['src', 'agents']) {
  for (const file of walk(path.join(ROOT, directory))) {
    const relative = rel(file);
    // The composition root is the one file allowed to choose one, and siblings inside the
    // directory compose freely: what the rule forbids is a caller from outside reaching past the
    // wiring to pick a provider up.
    if (relative === COMPOSITION_ROOT) continue;
    if (relative === PROVIDERS || relative.startsWith(`${PROVIDERS}/`)) continue;

    for (const spec of specifiers(file)) {
      if (reachesProviders(file, spec)) {
        violations.push(
          `test_SEC_providers_only_from_composition_root: ${relative} imports '${spec}'; only ${COMPOSITION_ROOT} may reach ${PROVIDERS}/`,
        );
      }
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
console.log(`test_SEC_no_direct_sdk_import OK (a model SDK is named only in ${GATEWAY} and ${PROVIDERS}/)`);
console.log(
  `test_SEC_providers_only_from_composition_root OK (${PROVIDERS}/ is reached only from ${COMPOSITION_ROOT})`,
);
