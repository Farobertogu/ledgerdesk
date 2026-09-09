/**
 * Static import boundary for the reading foundation. No DB or network.
 * Uses the already-installed TypeScript dev dependency; runs after npm ci.
 *
 * This walks the transitive repository graph, including type imports, re-exports,
 * require() and literal import(). Comments and ordinary string contents are not
 * code. Paths use tsconfig.app.json, relative resolution and TS/JS index files.
 *
 * This does NOT typecheck or provide a sandbox or proof of runtime isolation.
 * It cannot inspect package internals, eval, aliased loaders, framework-generated
 * edges, CSS dependencies or arbitrary code generation. Computed module loads
 * on an inspected path are rejected instead of being reported as inspected.
 * The SQL and HTTP isolation tests belong to T04/T05, not to this check.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const CONTRACT = 'src/contracts/material_reading.ts';
const PORT = 'src/server/kb/reading.ts';
// Panel is presentation only. Traverse this exact exception from both graphs so
// it cannot become a bridge; other existing components retain legacy behavior.
const SHARED_COMPONENT = 'src/components/panel.tsx';
const REQUIRED = [
  'src/app/layout.tsx',
  'src/app/material/page.tsx',
  'src/app/api/v1/material/route.ts',
  'src/app/api/v1/material/[unit_id]/versions/[version_id]/route.ts',
  'src/instrumentation.ts',
  'src/proxy.ts',
  'src/server/reading/config.ts',
  'src/server/reading/http.ts',
  CONTRACT,
  PORT,
];
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const slash = (value) => value.split(path.sep).join('/');
const lower = (value) => value.toLowerCase();
const inDirectory = (value, directory) => value === directory || value.startsWith(`${directory}/`);

function readingModule(relative) {
  const p = lower(relative);
  return p === CONTRACT || p === 'src/contracts/reading_origin.ts' || p === PORT || p === 'src/instrumentation.ts' || p === 'src/proxy.ts' ||
    inDirectory(p, 'src/server/reading') || inDirectory(p, 'src/components/reading') ||
    inDirectory(p, 'src/app/material') || inDirectory(p, 'src/app/api/v1/material');
}

function forbiddenToReading(relative) {
  const p = lower(relative);
  if (inDirectory(p, 'agents') || inDirectory(p, 'quality') || inDirectory(p, 'seed')) return true;
  if (/(?:^|\/)(?:demo|fixtures?|legacy)(?:\/|[._-]|$)/.test(p)) return true;
  if (/^src\/lib\/motor(?:[./]|$)/.test(p)) return true;
  if (inDirectory(p, 'src/alg')) return true;
  if (inDirectory(p, 'src/components') && p !== SHARED_COMPONENT && !readingModule(p)) return true;
  if (inDirectory(p, 'src/server') && !readingModule(p)) return true;
  return inDirectory(p, 'src/app') && p !== 'src/app/layout.tsx' &&
    p !== 'src/app/globals.css' && !readingModule(p);
}

function frameworkOrBuiltin(specifier) {
  return BUILTINS.has(specifier.replace(/^node:/, '')) ||
    /^(?:next|react|react-dom)(?:\/|$)/.test(specifier) || specifier === 'server-only';
}

/**
 * Parse code with the repository's TypeScript dependency, including TSX/type
 * syntax. Text, comments and strings are AST leaves, never module declarations.
 */
export function moduleReferences(source, { jsx = false } = {}) {
  const unit = ts.createSourceFile(
    jsx ? 'boundary.tsx' : 'boundary.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    jsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (unit.parseDiagnostics.length) {
    const diagnostic = unit.parseDiagnostics[0];
    const position = unit.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(`syntax error at ${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  }
  const references = [];
  const computed = [];
  function record(argument, node, loader) {
    const at = node.getStart(unit);
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      references.push({ specifier: argument.text, at });
    } else computed.push({ at, reason: `${loader} needs a literal module path` });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) record(node.moduleSpecifier, node, 'module declaration');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression, node, 'require()');
    } else if (ts.isImportTypeNode(node)) {
      record(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node, 'import type');
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const dynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = ts.isIdentifier(expression) && expression.text === 'require';
      const moduleRequire = ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) && expression.expression.text === 'module' &&
        expression.name.text === 'require';
      if (dynamicImport || requireCall || moduleRequire) {
        record(node.arguments[0], node, dynamicImport ? 'import()' : 'require()');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(unit);
  return { references, computed };
}
function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && CODE.test(entry.name)) files.push(full);
  }
  return files;
}

export function checkReadingBoundaries(projectRoot) {
  const root = realpathSync(projectRoot);
  const violations = [];
  const seenMessages = new Set();
  const report = (message) => { if (!seenMessages.has(message)) { seenMessages.add(message); violations.push(message); } };
  const relative = (file) => slash(path.relative(root, file));
  const local = (file) => { const p = path.relative(root, file); return p !== '..' && !p.startsWith(`..${path.sep}`) && !path.isAbsolute(p); };
  for (const p of REQUIRED) if (!existsSync(path.join(root, p))) report(`missing required reading root: ${p}`);
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(root, 'tsconfig.app.json'), 'utf8'));
    if (config.extends) throw new Error('resolve extends before checking the import graph');
  } catch (error) {
    report(`cannot resolve tsconfig.app.json: ${error.message}`);
    return { ok: false, violations, inspected: 0 };
  }
  const base = path.resolve(root, config.compilerOptions?.baseUrl ?? '.');
  const aliases = Object.entries(config.compilerOptions?.paths ?? {});
  function candidates(target) {
    const found = [target];
    if (/\.(?:[cm]?js|jsx)$/i.test(target)) {
      const stem = target.replace(/\.(?:[cm]?js|jsx)$/i, '');
      found.push(...EXTENSIONS.map((ext) => stem + ext));
    }
    if (!path.extname(target)) found.push(...EXTENSIONS.map((ext) => target + ext));
    found.push(...EXTENSIONS.map((ext) => path.join(target, `index${ext}`)));
    return found;
  }
  function resolve(from, specifier) {
    let targets = [];
    if (specifier.startsWith('.')) targets = [path.resolve(path.dirname(from), specifier)];
    else if (path.isAbsolute(specifier)) targets = [specifier];
    else {
      for (const [pattern, values] of aliases) {
        const star = pattern.indexOf('*');
        if (star < 0 && pattern === specifier) targets.push(...values.map((value) => path.resolve(base, value)));
        else if (star >= 0) {
          const before = pattern.slice(0, star), after = pattern.slice(star + 1);
          if (specifier.startsWith(before) && specifier.endsWith(after)) {
            const capture = specifier.slice(before.length, after ? -after.length : undefined);
            targets.push(...values.map((value) => path.resolve(base, value.replace('*', capture))));
          }
        }
      }
    }
    if (!targets.length) return { external: specifier };
    for (const target of targets) {
      for (const candidate of candidates(target)) {
        if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
        const actual = realpathSync(candidate);
        if (!local(actual)) return { error: `module resolves outside repository: ${specifier}` };
        return { file: actual };
      }
    }
    return { error: `unresolved repository module: ${specifier}` };
  }
  const graph = new Map();
  function edges(file) {
    if (graph.has(file)) return graph.get(file);
    const result = { edges: [], errors: [] };
    graph.set(file, result);
    if (!CODE.test(file)) return result; // Assets are leaves; CSS dependencies are out of scope.
    try {
      const source = readFileSync(file, 'utf8');
      const { references, computed } = moduleReferences(source, { jsx: /\.[jt]sx$/i.test(file) });
      const location = (at) => `${relative(file)}:${source.slice(0, at).split('\n').length}`;
      for (const item of computed) result.errors.push(`${location(item.at)}: ${item.reason}`);
      for (const item of references) result.edges.push({ ...resolve(file, item.specifier), specifier: item.specifier, location: location(item.at) });
    } catch (error) { result.errors.push(`${relative(file)}: cannot inspect module: ${error.message}`); }
    return result;
  }
  const sources = walk(path.join(root, 'src'));
  const readingRoots = new Set([
    ...REQUIRED.filter((p) => existsSync(path.join(root, p))).map((p) => realpathSync(path.join(root, p))),
    ...sources.filter((file) => readingModule(relative(file)) || lower(relative(file)) === SHARED_COMPONENT),
  ]);
  const legacyRoots = sources.filter((file) => {
    const p = lower(relative(file));
    return !readingModule(p) && (inDirectory(p, 'src/server') || inDirectory(p, 'src/alg') ||
      inDirectory(p, 'src/app/api') || inDirectory(p, 'src/components') ||
      (inDirectory(p, 'src/app') && /\/(?:page|layout)\.[jt]sx?$/.test(p) && p !== 'src/app/layout.tsx'));
  });
  function traverse(roots, mode) {
    const visited = new Set();
    function visit(file, chain) {
      if (visited.has(file)) return;
      visited.add(file);
      const node = edges(file);
      for (const error of node.errors) report(`${mode}: ${error}`);
      if (relative(file) === CONTRACT && node.edges.length) report(`contract must be import-free: ${CONTRACT}`);
      for (const edge of node.edges) {
        if (edge.error) { report(`${mode}: ${edge.location}: ${edge.error}`); continue; }
        if (edge.external) {
          const readingPgAdapter = relative(file) === 'src/server/reading/postgres/store.ts' && edge.external === 'pg';
          if (mode === 'reading' && !frameworkOrBuiltin(edge.external) && !readingPgAdapter) report(`reading: ${edge.location}: unapproved external module ${edge.external}`);
          continue;
        }
        const target = relative(edge.file);
        const route = [...chain, target].join(' -> ');
        if (mode === 'presentation' && inDirectory(lower(target), 'src/server')) {
          report(`presentation reaches reading server: ${route}`);
        }
        if (mode === 'reading' && forbiddenToReading(target)) {
          report(`reading reaches legacy dependency: ${route}`);
        } else if (mode === 'legacy' && readingModule(target)) {
          report(`legacy reaches reading dependency: ${route}`);
        } else visit(edge.file, [...chain, target]);
      }
    }
    for (const file of roots) visit(file, [relative(file)]);
  }
  traverse(readingRoots, 'reading');
  // A separate traversal prevents an earlier server visit from hiding a transitive client edge.
  traverse(sources.filter((file) => inDirectory(lower(relative(file)), 'src/components/reading')), 'presentation');
  traverse(legacyRoots, 'legacy');
  return { ok: violations.length === 0, violations, inspected: graph.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkReadingBoundaries(root);
  if (!result.ok) {
    for (const violation of result.violations) console.error(`reading boundary: ${violation}`);
    process.exitCode = 1;
  } else console.log(`reading boundary OK (${result.inspected} repository modules inspected; static imports only, not runtime/SQL isolation)`);
}
