#!/usr/bin/env node
/**
 * corpus.ts — the deterministic corpus generator (board card I2).
 *
 * The label is not an opinion: an item is born from a template plus the parameters chosen for
 * its slots, and those parameters ARE the label. No model is involved in producing either the
 * body or its ground truth, so label circularity is zero by construction rather than by low
 * probability.
 *
 * Contract
 *   Inputs    (seed, templates directory, parameters) — the same triple emits the same corpus.
 *   Output    the corpus plus a signed manifest: template_id per item, counts per family, and
 *             the sha256 of every body.
 *   Exit 0    corpus and manifest emitted, headroom satisfied.
 *   Exit 1    a parameter is missing, a template is malformed, or the templates changed under
 *             the run. Cross-process reproducibility is NOT proved here: it is proved by
 *             test_GEN_corpus_deterministic_from_triple in ci/db_check.sh.
 *   Exit 2    the manifest does not reconcile against the emitted bodies. This is a defence
 *             against corrupt writing and has no test today: reconcile() only reads back what
 *             this same process just wrote, so the branch is unreachable without a verify mode.
 *   Exit 3    headroom self-test failed.
 *   Non-zero fails the build.
 *
 *   Signature manifest_sha256 = sha256 of the canonical JSON (object keys sorted, no whitespace)
 *             of every manifest field EXCEPT manifest_sha256 itself. built_at and run_id are
 *             inside that scope, so the signature is reproducible from the triple ONLY when
 *             --built-at is pinned; the corpus and the partition are reproducible from the
 *             triple unconditionally.
 *   Digests   corpus_sha256 covers items WITH their labels; content_sha256 per kind covers
 *             ids bound to body hashes and NOT labels — the label vector is committed separately.
 *
 * This generator emits nothing a blind rater may see: template_id, slot parameters and every
 * label-carrying field stay inside the corpus and the manifest. The de-identification generator
 * of card I11a is the only writer of the rater's sheet.
 *
 * The manifest emitted here carries the deterministic partition of the four kinds but no
 * `commitment` block: sealing happens later (card I10), and it is the sealing step that adds the
 * commitment and turns this partition into the sealed manifest that splits.schema.json governs.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

// --------------------------------------------------------------------------- types

type Label = {
  category: string;
  severity: number;
  sentiment: number;
  escalate: boolean;
  reason: string | null;
};

type SlotOption = { value: string; label?: Partial<Label> };

type Template = {
  template_id: string;
  family: string;
  body: string;
  label_defaults: Label;
  slots: Record<string, SlotOption[]>;
};

type Item = {
  id: string;
  item_id: string;
  template_id: string;
  family: string;
  body: string;
  body_sha256: string;
  label: Label;
  label_source: 'generator';
};

type KindName = 'selection' | 'report' | 'ood' | 'blind_label';

type Sizes = Record<KindName, number>;

type Params = {
  schema_version: string;
  builder_version: string;
  canonical_order: string;
  min_margin_ratio: number;
  sizes: Sizes;
};

type SplitEntry = { n: number; item_ids: string[]; content_sha256: string };

type HeadroomReport = {
  required: number;
  available: number;
  margin: number;
  min_margin_ratio: number;
  min_margin_items: number;
  disjoint: boolean;
};

type Build = {
  items: Item[];
  kinds: Record<KindName, SplitEntry>;
  corpus_sha256: string;
  partition_sha256: string;
};

const KIND_ORDER: KindName[] = ['selection', 'report', 'ood', 'blind_label'];
const REASONS = ['CONF', 'SENT', 'TIER', 'RETRY', 'SLA', 'GROUND', 'POLICY', 'LANG'];
const LABEL_KEYS: readonly string[] = ['category', 'severity', 'sentiment', 'escalate', 'reason'];

// --------------------------------------------------------------------------- primitives

function fail(code: number, message: string): never {
  // writeSync, not process.stderr.write: on a pipe the asynchronous write can be lost when the
  // process exits in the same tick, and the diagnostic is the whole point of a non-zero exit.
  writeSync(2, `corpus: ${message}\n`);
  process.exit(code);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable serialisation: object keys in lexicographic order, so a digest means membership. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** A uuid derived from the item id, so the primary key is reproducible from the triple. */
function derivedUuid(name: string): string {
  const h = sha256(name);
  const version = '5';
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${version}${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** xoshiro128** seeded from a digest of the triple. No dependency, same stream everywhere. */
function makeRng(seedText: string): () => number {
  const h = createHash('sha256').update(seedText, 'utf8').digest();
  let s0 = h.readUInt32BE(0) >>> 0;
  let s1 = h.readUInt32BE(4) >>> 0;
  let s2 = h.readUInt32BE(8) >>> 0;
  let s3 = h.readUInt32BE(12) >>> 0;
  const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
  return function next(): number {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0) / 4294967296;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  };
}

function shuffleInPlace<T>(list: T[], rng: () => number): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
}

function byItemId(a: { item_id: string }, b: { item_id: string }): number {
  return a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0;
}

// --------------------------------------------------------------------------- inputs

type Args = {
  seed: number;
  templatesDir: string;
  /** The templates path as the caller wrote it: what the manifest declares, so that the same
   *  triple emits the same manifest on any machine. Resolution is for reading only. */
  templatesArg: string;
  paramsPath: string;
  outDir: string;
  runId: string | null;
  builtAt: string | null;
};

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) fail(1, `unexpected argument '${token}'`);
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(1, `flag --${name} needs a value`);
    flags[name] = value;
    i += 1;
  }
  for (const required of ['seed', 'templates', 'params', 'out']) {
    if (flags[required] === undefined) {
      fail(1, `missing parameter --${required} (usage: --seed N --templates DIR --params FILE --out DIR [--run-id UUID] [--built-at ISO])`);
    }
  }
  const seed = Number(flags.seed);
  if (!Number.isInteger(seed)) fail(1, `--seed must be an integer, got '${flags.seed}'`);

  // The manifest declares the templates path verbatim, so the spelling of the flag must not be
  // able to change the signature: normalise it and refuse anything that is not repository-relative.
  const templatesArg = flags.templates.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (templatesArg === '' || templatesArg.startsWith('/') || /^[A-Za-z]:/.test(templatesArg)) {
    fail(1, '--templates must be a repository-relative path (the manifest declares it verbatim)');
  }
  if (flags['built-at'] !== undefined
      && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(flags['built-at'])) {
    fail(1, `--built-at must be an ISO-8601 UTC timestamp, got '${flags['built-at']}'`);
  }
  if (flags['run-id'] !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(flags['run-id'])) {
    fail(1, `--run-id must be a lowercase uuid, got '${flags['run-id']}'`);
  }

  return {
    seed,
    templatesDir: resolve(flags.templates),
    templatesArg,
    paramsPath: resolve(flags.params),
    outDir: resolve(flags.out),
    runId: flags['run-id'] ?? null,
    builtAt: flags['built-at'] ?? null,
  };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(1, `cannot read JSON from ${path}: ${(error as Error).message}`);
  }
}

function loadParams(path: string): Params {
  const raw = readJson(path) as Partial<Params>;
  for (const key of ['schema_version', 'builder_version', 'canonical_order', 'min_margin_ratio', 'sizes'] as const) {
    if (raw[key] === undefined) fail(1, `parameters file ${path} is missing '${key}'`);
  }
  const sizes = raw.sizes as Partial<Sizes>;
  for (const kind of KIND_ORDER) {
    const n = sizes[kind];
    if (!Number.isInteger(n) || (n as number) < 1) {
      fail(1, `parameters file ${path} needs an integer size >= 1 for kind '${kind}'`);
    }
  }
  for (const k of Object.keys(sizes)) {
    if (!(KIND_ORDER as readonly string[]).includes(k)) {
      fail(1, `parameters file ${path} declares an unknown kind '${k}' in sizes (the four kinds are ${KIND_ORDER.join(', ')})`);
    }
  }
  if (typeof raw.min_margin_ratio !== 'number' || !(raw.min_margin_ratio > 0)) {
    fail(1, `parameters file ${path} needs a POSITIVE 'min_margin_ratio': a margin of 0 makes the sealed report split recoverable exactly by complement`);
  }
  if (raw.schema_version !== '1.1') {
    fail(1, `parameters file ${path}: schema_version must be '1.1' — the sealing contract rejects '1.0'`);
  }
  if (raw.canonical_order !== 'sorted_by_item_id_then_shuffled') {
    fail(1, `parameters file ${path}: canonical_order must be 'sorted_by_item_id_then_shuffled' (the const of the sealed manifest schema)`);
  }
  if (typeof raw.builder_version !== 'string' || raw.builder_version.trim() === '') {
    fail(1, `parameters file ${path} needs a non-empty 'builder_version'`);
  }
  return raw as Params;
}

function loadTemplates(dir: string): { templates: Template[]; inputSha256: string } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (error) {
    return fail(1, `cannot read the templates directory ${dir}: ${(error as Error).message}`);
  }
  if (names.length === 0) fail(1, `no .json template found in ${dir}`);

  const templates: Template[] = [];
  const fingerprints: string[] = [];
  const seenIds = new Set<string>();

  for (const name of names) {
    const path = join(dir, name);
    const text = readFileSync(path, 'utf8');
    // The digest is taken over the text normalised to LF, not over the bytes on disk: it seeds the
    // shuffle, and a checkout that converts line endings would otherwise repartition the corpus.
    fingerprints.push(`${name}:${sha256(text.replace(/\r\n/g, '\n'))}`);
    let t: Template;
    try {
      t = JSON.parse(text) as Template;
    } catch (error) {
      return fail(1, `template ${name} is not valid JSON: ${(error as Error).message}`);
    }

    for (const key of ['template_id', 'family', 'body', 'label_defaults', 'slots'] as const) {
      if (t[key] === undefined) fail(1, `template ${name} is missing '${key}'`);
    }
    if (seenIds.has(t.template_id)) fail(1, `template_id '${t.template_id}' appears in more than one file`);
    seenIds.add(t.template_id);

    const defaults = t.label_defaults;
    if (typeof defaults.category !== 'string' || typeof defaults.severity !== 'number'
      || typeof defaults.sentiment !== 'number' || typeof defaults.escalate !== 'boolean'
      || !('reason' in defaults) || (defaults.reason !== null && typeof defaults.reason !== 'string')) {
      fail(1, `template ${name} has an incomplete label_defaults block`);
    }
    if (defaults.reason !== null && !REASONS.includes(defaults.reason)) {
      fail(1, `template ${name} label_defaults uses reason '${defaults.reason}', which is outside the closed alphabet`);
    }

    if (t.slots === null || typeof t.slots !== 'object' || Array.isArray(t.slots)) {
      fail(1, `template ${name} has a 'slots' that is not an object`);
    }
    if (typeof t.body !== 'string' || t.body.trim() === '') {
      fail(1, `template ${name} has an empty or non-string 'body'`);
    }
    if (typeof t.template_id !== 'string' || typeof t.family !== 'string'
      || t.template_id === '' || t.family === '') {
      fail(1, `template ${name} has an empty or non-string 'template_id' or 'family'`);
    }

    const slotNames = Object.keys(t.slots).sort();
    if (slotNames.length === 0) fail(1, `template ${name} declares no slot`);
    for (const slot of slotNames) {
      const options = t.slots[slot];
      if (!Array.isArray(options) || options.length === 0) fail(1, `template ${name} slot '${slot}' is empty`);
      if (!t.body.includes(`{${slot}}`)) fail(1, `template ${name} declares slot '${slot}' and never uses it`);
      for (const option of options) {
        if (typeof option.value !== 'string') fail(1, `template ${name} slot '${slot}' has an option without a string value`);
        const reason = option.label?.reason;
        if (reason !== undefined && reason !== null && !REASONS.includes(reason)) {
          fail(1, `template ${name} slot '${slot}' uses reason '${reason}', which is outside the closed alphabet`);
        }
        for (const k of Object.keys(option.label ?? {})) {
          if (!LABEL_KEYS.includes(k)) {
            fail(1, `template ${name} slot '${slot}' contributes unknown label field '${k}'`);
          }
        }
      }
    }
    const placeholders = t.body.match(/\{[^{}]*\}/g) ?? [];
    for (const placeholder of placeholders) {
      const slot = placeholder.slice(1, -1);
      if (!slotNames.includes(slot)) fail(1, `template ${name} uses '{${slot}}' with no slot of that name`);
    }
    templates.push(t);
  }

  templates.sort((a, b) => (a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0));
  return { templates, inputSha256: sha256(fingerprints.join('\n')) };
}

// --------------------------------------------------------------------------- generation

function cartesian(lists: SlotOption[][]): SlotOption[][] {
  let acc: SlotOption[][] = [[]];
  for (const list of lists) {
    const next: SlotOption[][] = [];
    for (const prefix of acc) for (const option of list) next.push(prefix.concat([option]));
    acc = next;
  }
  return acc;
}

/**
 * Slot contributions are applied in canonical slot order (slot names sorted lexicographically);
 * where two slots contribute the same label field, the later one in that order wins.
 */
function itemsFromTemplate(t: Template): Item[] {
  const slotNames = Object.keys(t.slots).sort();
  const combos = cartesian(slotNames.map((n) => t.slots[n]));
  return combos.map((combo, index) => {
    let body = t.body;
    const label: Label = { ...t.label_defaults };
    slotNames.forEach((slot, i) => {
      const option = combo[i];
      body = body.split(`{${slot}}`).join(option.value);
      if (option.label) Object.assign(label, option.label);
    });
    if (!label.escalate) label.reason = null;
    else if (label.reason === null || label.reason === undefined) {
      fail(1, `template ${t.template_id} combination ${index} escalates without a reason code`);
    }
    // The id may not encode the label. template_id plus the cartesian index decode exactly to the
    // slot combination, which IS the ground truth, and the manifest publishes the blind pool's
    // ids: hashing the two together keeps the id opaque while staying reproducible.
    const item_id = `I-${sha256(`${t.template_id}|${index}`).slice(0, 16)}`;
    return {
      id: derivedUuid(item_id),
      item_id,
      template_id: t.template_id,
      family: t.family,
      body,
      body_sha256: sha256(body),
      label,
      label_source: 'generator',
    };
  });
}

function contentSha256(members: Item[]): string {
  const sorted = members.slice().sort(byItemId);
  return sha256(sorted.map((m) => `${m.item_id}:${m.body_sha256}`).join('\n'));
}

function build(seed: number, templates: Template[], inputSha256: string, sizes: Sizes): Build {
  const items: Item[] = [];
  for (const t of templates) items.push(...itemsFromTemplate(t));
  items.sort(byItemId);
  if (new Set(items.map((i) => i.item_id)).size !== items.length) {
    fail(1, 'duplicate item_id: the partition is disjoint by construction only over unique ids');
  }

  // canonical order: sorted by item_id, THEN shuffled with the seeded stream. Never set,
  // dict, glob or directory order.
  const order = items.slice();
  shuffleInPlace(order, makeRng(`${seed}|${inputSha256}`));

  const kinds = {} as Record<KindName, SplitEntry>;
  let cursor = 0;
  for (const kind of KIND_ORDER) {
    const n = sizes[kind];
    const members = order.slice(cursor, cursor + n);
    cursor += n;
    kinds[kind] = {
      n,
      item_ids: members.map((m) => m.item_id).sort(),
      content_sha256: contentSha256(members),
    };
  }

  return {
    items,
    kinds,
    corpus_sha256: sha256(canonical(items)),
    partition_sha256: sha256(canonical(kinds)),
  };
}

function countBy(items: Item[], key: 'family' | 'template_id'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const name of Object.keys(counts).sort()) sorted[name] = counts[name];
  return sorted;
}

// --------------------------------------------------------------------------- self-tests

/**
 * Headroom: does the template space produce the four sets, all disjoint, with margin? A corpus
 * that cannot supply them is a corpus that forces a re-seal later, and re-sealing invalidates
 * every prior measurement. The margin is also what keeps the membership of the report split from
 * being read off by complement once the other three are published.
 */
function headroom(b: Build, params: Params): { ok: boolean; message: string; report: HeadroomReport } {
  const required = KIND_ORDER.reduce((sum, kind) => sum + params.sizes[kind], 0);
  const available = b.items.length;
  const margin = available - required;
  const minMarginItems = Math.ceil(required * params.min_margin_ratio);

  const seen = new Map<string, KindName>();
  let overlap = '';
  for (const kind of KIND_ORDER) {
    for (const id of b.kinds[kind].item_ids) {
      const other = seen.get(id);
      if (other !== undefined) overlap = `${id} is in both '${other}' and '${kind}'`;
      seen.set(id, kind);
    }
    if (b.kinds[kind].item_ids.length !== b.kinds[kind].n) {
      overlap = `kind '${kind}' declares n=${b.kinds[kind].n} and holds ${b.kinds[kind].item_ids.length} items`;
    }
  }

  const report: HeadroomReport = {
    required,
    available,
    margin,
    min_margin_ratio: params.min_margin_ratio,
    min_margin_items: minMarginItems,
    disjoint: overlap === '',
  };

  if (available < required) {
    return { ok: false, message: `headroom self-test failed: the four sets need ${required} items and the template space produces ${available}`, report };
  }
  if (overlap !== '') {
    return { ok: false, message: `headroom self-test failed: the four sets are not disjoint (${overlap})`, report };
  }
  if (margin < 1) {
    return { ok: false, message: 'headroom self-test failed: margin 0 exposes the report split by complement', report };
  }
  if (margin < minMarginItems) {
    return { ok: false, message: `headroom self-test failed: margin ${margin} is below the declared minimum of ${minMarginItems} items (${params.min_margin_ratio} of ${required})`, report };
  }
  return { ok: true, message: '', report };
}

/** Re-reads what was written and recomputes every hash and count the manifest asserts. */
function reconcile(outDir: string): string {
  const corpus = readJson(join(outDir, 'corpus.json')) as Item[];
  const manifest = readJson(join(outDir, 'manifest.json')) as Record<string, any>;

  const byId = new Map<string, Item>();
  for (const item of corpus) {
    if (sha256(item.body) !== item.body_sha256) return `body of ${item.item_id} does not match its recorded hash`;
    byId.set(item.item_id, item);
  }

  const entries = manifest.corpus.items as { item_id: string; template_id: string; family: string; body_sha256: string }[];
  if (entries.length !== corpus.length) return `the manifest lists ${entries.length} items and the corpus holds ${corpus.length}`;
  for (const entry of entries) {
    const item = byId.get(entry.item_id);
    if (item === undefined) return `the manifest lists ${entry.item_id}, which the corpus does not contain`;
    if (entry.body_sha256 !== item.body_sha256) return `the manifest hash of ${entry.item_id} does not match its body`;
    if (entry.template_id !== item.template_id || entry.family !== item.family) return `the manifest attributes ${entry.item_id} to a different template or family`;
  }

  if (canonical(manifest.corpus.counts_by_family) !== canonical(countBy(corpus, 'family'))) return 'counts per family do not reconcile against the emitted bodies';
  if (canonical(manifest.corpus.counts_by_template) !== canonical(countBy(corpus, 'template_id'))) return 'counts per template do not reconcile against the emitted bodies';
  if (manifest.corpus.corpus_sha256 !== sha256(canonical(corpus))) return 'the corpus digest does not reconcile against the emitted corpus';

  for (const kind of KIND_ORDER) {
    const entry = manifest.kinds[kind] as SplitEntry;
    if (entry.item_ids === null) {
      // null is the sealed form of the report split; any other kind carrying it is a defect.
      if (kind !== 'report') return `kind '${kind}' has item_ids null, which only 'report' may have after sealing`;
      continue;
    }
    if (!Array.isArray(entry.item_ids)) return `kind '${kind}' has no item_ids array to reconcile`;
    if (entry.item_ids.length !== entry.n) return `kind '${kind}' declares n=${entry.n} and lists ${entry.item_ids.length} ids`;
    const members: Item[] = [];
    for (const id of entry.item_ids) {
      const item = byId.get(id);
      if (item === undefined) return `kind '${kind}' lists ${id}, which the corpus does not contain`;
      members.push(item);
    }
    if (contentSha256(members) !== entry.content_sha256) return `the content hash of kind '${kind}' does not reconcile against the bodies it names`;
  }

  const { manifest_sha256, ...unsigned } = manifest;
  if (manifest_sha256 !== sha256(canonical(unsigned))) return 'the manifest signature does not match the manifest';

  return '';
}

// --------------------------------------------------------------------------- entry point

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const params = loadParams(args.paramsPath);
  const { templates, inputSha256 } = loadTemplates(args.templatesDir);

  const first = build(args.seed, templates, inputSha256, params.sizes);
  // The second build re-reads the directory, so this catches an unstable read or a templates
  // directory that changes under the run. Cross-process reproducibility is proved in CI, not here.
  const reread = loadTemplates(args.templatesDir);
  const second = build(args.seed, reread.templates, reread.inputSha256, params.sizes);
  if (reread.inputSha256 !== inputSha256
    || first.corpus_sha256 !== second.corpus_sha256
    || first.partition_sha256 !== second.partition_sha256) {
    fail(1, 'the templates changed under the run: two builds of (seed, templates, parameters) produced different digests');
  }

  const head = headroom(first, params);
  if (!head.ok) fail(3, head.message);

  const runId = args.runId ?? derivedUuid(`run|${args.seed}|${inputSha256}`);
  const builtAt = args.builtAt ?? new Date().toISOString();

  const unsigned = {
    schema_version: params.schema_version,
    builder_version: params.builder_version,
    run_id: runId,
    built_at: builtAt,
    input_path: args.templatesArg,
    input_sha256: inputSha256,
    canonical_order: params.canonical_order,
    seed: args.seed,
    corpus: {
      n_items: first.items.length,
      counts_by_family: countBy(first.items, 'family'),
      counts_by_template: countBy(first.items, 'template_id'),
      corpus_sha256: first.corpus_sha256,
      items: first.items.map((i) => ({
        item_id: i.item_id,
        template_id: i.template_id,
        family: i.family,
        body_sha256: i.body_sha256,
      })),
    },
    kinds: first.kinds,
    headroom: head.report,
  };
  const manifest = { ...unsigned, manifest_sha256: sha256(canonical(unsigned)) };

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(join(args.outDir, 'corpus.json'), `${JSON.stringify(first.items, null, 2)}\n`, 'utf8');
  writeFileSync(join(args.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const problem = reconcile(args.outDir);
  if (problem !== '') fail(2, `the manifest does not reconcile against the emitted bodies: ${problem}`);

  process.stdout.write(
    `corpus: ${first.items.length} items from ${templates.length} templates, `
    + `margin ${head.report.margin} over the four sets, manifest ${manifest.manifest_sha256.slice(0, 12)}\n`,
  );
}

main(process.argv.slice(2));
