// node --experimental-strip-types --test tests/contracts/test_material_reading.mjs
// Tests real contract code against pinned source examples; no service/DB is started.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';
import {
  READING_CONTRACT, TRIAL_LIMITS, EDITORIAL_STATES, ORIGINAL_LANGUAGES,
  SUBSTANTIVE_FUNCTIONS, VALIDITY_BASES, APPLICATION_SCOPES, PROBLEMS,
  validateListRequest, validateExactRequest, validateListResponse,
  validateDetailResponse, validateProblem, consumeProblem,
} from '../../src/contracts/material_reading.ts';
import { READING_PROFILE_MAPPING, toReadingProfile, fromReadingProfile } from './reading_profile_mapping.mjs';

const asset = (name) => new URL(`./T02_sources/${name}`, import.meta.url);
const readJSON = (name) => JSON.parse(readFileSync(asset(name), 'utf8'));
const provenance = readJSON('provenance.json');
const schema = readJSON('T02_LECTURA.schema.json');
const examples = readJSON('T02_LECTURA.ejemplos.json');
const targetName = (reference) => reference.split('#/$defs/')[1];
const typeName = (sourceName) => READING_PROFILE_MAPPING.typeNames[sourceName];
const cases = examples.casos.map((entry) => ({
  ...entry,
  request: { ...entry.request, input: toReadingProfile(targetName(entry.request.target_schema), entry.request.input) },
  response: { ...entry.response, body: toReadingProfile(targetName(entry.response.target_schema), entry.response.body) },
}));
const byId = new Map(cases.map((entry) => [entry.id, entry]));
const byOriginal = new Map(examples.textos_originales.map((entry) => [entry.id, entry]));
const validators = {
  ListRequest: validateListRequest, ExactRequest: validateExactRequest,
  ListResponse: validateListResponse, DetailResponse: validateDetailResponse, Problema: validateProblem,
};
const clone = (value) => structuredClone(value);
const definition = (name) => schema.$defs[name];
const at = (value, pointer) => pointer.split('/').slice(1).reduce((node, key) => node[key], value);
const content = () => clone(byId.get('D04_CONTENIDO_ES_UI_ES').response.body);
const excerpt = () => clone(byId.get('D03_EXTRACTO_ES').response.body);
const refView = () => clone(byId.get('D01_REFERENCIA_MINIMA').response.body.projection);

function refused(check, value, code, path) {
  const before = JSON.stringify(value);
  const result = check(value);
  assert.equal(result.ok, false);
  assert.equal(result.issue.code, code);
  if (path !== undefined) assert.equal(result.issue.path, path);
  assert.equal(JSON.stringify(value), before, 'rejection must not repair or strip the input');
  return result;
}

// An independent interpreter for the finite subset actually used by the pinned
// source schema. It is a TEST oracle, not a general JSON Schema implementation.
// Unknown keywords fail the test rather than silently widening the interpreter.
const supported = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'oneOf', 'type',
  'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'enum', 'const',
]);
function assertSupported(node) {
  for (const key of Object.keys(node)) assert.ok(supported.has(key), `Unsupported schema keyword: ${key}`);
  for (const child of Object.values(node.$defs ?? {})) assertSupported(child);
  for (const child of Object.values(node.properties ?? {})) assertSupported(child);
  for (const child of node.oneOf ?? []) assertSupported(child);
  if (node.items) assertSupported(node.items);
}
function matches(node, value) {
  if (node.$ref) return matches(definition(targetName(node.$ref)), value);
  if (node.oneOf && node.oneOf.filter((choice) => matches(choice, value)).length !== 1) return false;
  if (Object.hasOwn(node, 'const') && value !== node.const) return false;
  if (node.enum && !node.enum.includes(value)) return false;
  if (node.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if ((node.required ?? []).some((key) => !Object.hasOwn(value, key))) return false;
    if (node.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(node.properties ?? {}, key))) return false;
    if (!Object.entries(node.properties ?? {}).every(([key, child]) => !Object.hasOwn(value, key) || matches(child, value[key]))) return false;
  }
  if (node.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (value.length < (node.minItems ?? 0) || value.length > (node.maxItems ?? Infinity)) return false;
    if (!value.every((item) => matches(node.items, item))) return false;
  }
  if (node.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    if (length < (node.minLength ?? 0) || length > (node.maxLength ?? Infinity)) return false;
  }
  if (node.type === 'boolean' && typeof value !== 'boolean') return false;
  return true;
}
function sample(node) {
  if (node.$ref) return sample(definition(targetName(node.$ref)));
  if (node.oneOf) return sample(node.oneOf[0]);
  if (Object.hasOwn(node, 'const')) return node.const;
  if (node.enum) return node.enum[0];
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, sample(child)]));
  if (node.type === 'array') return Array.from({ length: Math.max(1, node.minItems ?? 0) }, () => sample(node.items));
  if (node.type === 'string') return 'x'.repeat(Math.max(1, node.minLength ?? 0));
  if (node.type === 'boolean') return false;
  throw new Error('Unimplemented source schema sample');
}

function objects(value, path = '$') {
  if (value === null || typeof value !== 'object') return [];
  const result = Array.isArray(value) ? [] : [{ value, path }];
  for (const [key, child] of Object.entries(value)) {
    result.push(...objects(child, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`));
  }
  return result;
}

describe('Pinned design identity and English reading profile equivalence', () => {
  it('uses byte-identical schema/examples and an explicitly limited independent oracle', () => {
    for (const source of provenance.sources) {
      assert.equal(createHash('sha256').update(readFileSync(asset(source.file))).digest('hex'), source.sha256);
    }
    assert.equal(provenance.contract, READING_PROFILE_MAPPING.sourceProfile);
    assert.equal(examples.contrato, READING_PROFILE_MAPPING.sourceProfile);
    assert.equal(READING_CONTRACT, READING_PROFILE_MAPPING.targetProfile);
    assert.notEqual(READING_CONTRACT, examples.contrato);
    assert.equal(schema.$id, 'urn:ledgerdesk:t02:lectura:1');
    assert.deepEqual(Object.keys(READING_PROFILE_MAPPING.typeNames).sort(), Object.keys(schema.$defs).sort());
    assert.equal(cases.length, 25);
    assertSupported(schema);
  });

  it('preserves every source enum and synthetic limit', () => {
    assert.deepEqual(EDITORIAL_STATES, definition('EstadoEditorial').enum.map((value) => toReadingProfile('EstadoEditorial', value)));
    assert.deepEqual(ORIGINAL_LANGUAGES, definition('IdiomaOriginal').enum);
    assert.deepEqual(SUBSTANTIVE_FUNCTIONS, definition('Clasificacion').properties.funcion_sustantiva.enum.map((value) => toReadingProfile('SubstantiveFunction', value)));
    assert.deepEqual(VALIDITY_BASES, definition('Clasificacion').properties.base_de_validez.enum.map((value) => toReadingProfile('ValidityBasis', value)));
    assert.deepEqual(APPLICATION_SCOPES, definition('Clasificacion').properties.alcance_de_aplicacion.enum.map((value) => toReadingProfile('ApplicationScope', value)));
    assert.equal(TRIAL_LIMITS.id, definition('IdOpaco').maxLength);
    assert.equal(TRIAL_LIMITS.text, definition('TextoPlano').maxLength);
    assert.equal(TRIAL_LIMITS.titleOrCondition, definition('Titulo').maxLength);
    assert.equal(TRIAL_LIMITS.titleOrCondition, definition('CondicionLectura').maxLength);
    assert.equal(TRIAL_LIMITS.references, definition('ListResponse').properties.items.maxItems);
    assert.equal(TRIAL_LIMITS.fragments, definition('ExcerptView').properties.fragmentos.maxItems);
    for (const sourceType of ['Metadata', 'Fragmento']) {
      const locatorType = targetName(definition(sourceType).properties.localizador.$ref);
      assert.equal(locatorType, 'TextoPlano');
      assert.equal(TRIAL_LIMITS.text, definition(locatorType).maxLength);
    }
    for (const problem of Object.values(PROBLEMS)) {
      assert.equal(matches(definition('Problema'), fromReadingProfile('Problema', problem)), true);
    }
  });

  for (const entry of examples.casos) {
    it(`checks ${entry.id} against its source targets (not a service result)`, () => {
      for (const [target, value, expected] of [
        [targetName(entry.request.target_schema), entry.request.input, entry.request.schema_valid],
        [targetName(entry.response.target_schema), entry.response.body, entry.response.schema_valid],
      ]) {
        assert.equal(matches(definition(target), value), expected);
        const before = JSON.stringify(value);
        const mapped = toReadingProfile(target, value);
        const mappedBefore = JSON.stringify(mapped);
        const result = validators[target](mapped);
        assert.equal(result.ok, expected);
        if (result.ok) assert.equal(result.value, mapped, 'validation preserves the exact object instead of projecting it');
        assert.deepEqual(fromReadingProfile(target, mapped), value, 'the correspondence loses no source fields or values');
        assert.equal(JSON.stringify(mapped), mappedBefore);
        assert.equal(JSON.stringify(value), before);
      }
    });
  }

  it('P01 rejects the unknown field for its actual cause, before any authority lookup', () => {
    refused(validateListRequest, byId.get('P01_SOLICITUD_INVALIDA').request.input, 'ADDITIONAL_PROPERTY', '$');
    assert.deepEqual(byId.get('P01_SOLICITUD_INVALIDA').response.body, PROBLEMS[400]);
    // This test covers logical input. HTTP integration tests cover query parsing.
  });

  it('rejects additional properties at every object boundary of all valid source bodies', () => {
    let count = 0;
    let expectedCount = 0;
    for (const entry of cases) {
      JSON.parse(JSON.stringify(entry.response.body), (_key, value) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) expectedCount += 1;
        return value;
      });
      const check = validators[targetName(entry.response.target_schema)];
      for (const target of objects(entry.response.body)) {
        const original = entry.response.body;
        target.value.unknown_property = 'not for the public DTO';
        const result = check(original);
        delete target.value.unknown_property;
        assert.equal(result.ok, false);
        assert.equal(result.issue.code, 'ADDITIONAL_PROPERTY');
        assert.equal(result.issue.path, target.path);
        count += 1;
      }
    }
    assert.equal(count, expectedCount, 'every JSON object counted independently by the reviver must be attacked');
    assert.ok(count > 0, 'the negative traversal must not be vacuous');
  });

  it('requires root fields and the discriminator; rejects server authority as input', () => {
    for (const [name, check] of Object.entries(validators)) {
      const basis = toReadingProfile(name, sample(definition(name)));
      for (const key of Object.keys(basis)) {
        const invalid = clone(basis);
        delete invalid[key];
        refused(check, invalid, 'REQUIRED', `$.${key}`);
      }
    }
    const invalid = content();
    delete invalid.projection.kind;
    refused(validateDetailResponse, invalid, 'REQUIRED', '$.projection.kind');
    for (const key of ['subject', 'org_id', 'role', 'access_grade', 'purpose', 'permission']) {
      refused(validateExactRequest, { unit_id: 'u', version_id: 'v', [key]: 'fabricated' }, 'ADDITIONAL_PROPERTY', '$');
    }
  });

  it('refuses union contamination, unknown states, wrong constants and incomplete classification', () => {
    for (const field of ['original_text', 'fragments', 'hash', 'access_grade', 'successor', 'owner']) {
      refused(validateDetailResponse, { contract: READING_CONTRACT, projection: { ...refView(), [field]: 'hidden' } }, 'ADDITIONAL_PROPERTY', '$.projection');
    }
    for (const state of ['IN_REVIEW', 'RESTRICTED', 'CURRENT', 'PUBLICADA']) {
      const value = content();
      value.projection.metadata.editorial_state = state;
      refused(validateDetailResponse, value, 'ENUM', '$.projection.metadata.editorial_state');
    }
    const value = content();
    value.projection.metadata.classification.substantive_function = 'PROPOSAL';
    refused(validateDetailResponse, value, 'ENUM', '$.projection.metadata.classification.substantive_function');
    const missing = content();
    delete missing.projection.metadata.classification.validity_basis;
    refused(validateDetailResponse, missing, 'REQUIRED', '$.projection.metadata.classification.validity_basis');
    refused(validateDetailResponse, { ...content(), contract: 'reading/2' }, 'CONST', '$.contract');
    refused(validateDetailResponse, { contract: READING_CONTRACT, projection: { kind: 'EXISTENCE' } }, 'ENUM', '$.projection.kind');
    refused(validateListResponse, { contract: READING_CONTRACT, items: [], existence_signal: 'false' }, 'TYPE', '$.existence_signal');
  });
});

describe('Test-only profile correspondence safeguards', () => {
  it('is reversible for every source definition and every declared protocol value', () => {
    const targetTypes = Object.values(READING_PROFILE_MAPPING.typeNames);
    assert.equal(new Set(targetTypes).size, targetTypes.length);
    for (const name of Object.keys(schema.$defs)) {
      const value = sample(definition(name));
      assert.equal(matches(definition(name), value), true);
      assert.deepEqual(fromReadingProfile(name, toReadingProfile(name, value)), value);
    }
    for (const [name, values] of Object.entries(READING_PROFILE_MAPPING.values)) {
      assert.equal(new Set(Object.values(values)).size, Object.keys(values).length, `${name} must be one-to-one`);
      for (const [source, target] of Object.entries(values)) {
        assert.equal(toReadingProfile(name, source), target);
        assert.equal(fromReadingProfile(name, target), source);
      }
    }
    assert.throws(() => toReadingProfile('NotADefinition', {}), /Unknown mapping definition/);
  });

  it('preserves opaque data even when the entire value resembles a protocol symbol', () => {
    const opaqueValues = [
      ...Object.values(READING_PROFILE_MAPPING.values).flatMap((values) => [...Object.keys(values), ...Object.values(values)]),
      ...Object.keys(READING_PROFILE_MAPPING.fields),
      '  cafe\u0301 ≠ café\r\n\n\t😀 <script>inert</script>  ', 'es', 'en',
    ];
    for (const opaque of opaqueValues) {
      const source = clone(examples.casos.find((entry) => entry.id === 'D04_CONTENIDO_ES_UI_ES').response.body);
      source.proyeccion.referencia = { unidad_id: opaque, version_id: opaque };
      source.proyeccion.texto_original = opaque;
      source.proyeccion.metadatos.titulo = opaque;
      source.proyeccion.metadatos.localizador = opaque;
      source.proyeccion.metadatos.condiciones_lectura = [opaque];
      assert.equal(matches(definition('DetailResponse'), source), true);
      const mapped = toReadingProfile('DetailResponse', source);
      assert.equal(validateDetailResponse(mapped).ok, true);
      assert.deepEqual(mapped.projection.reference, { unit_id: opaque, version_id: opaque });
      assert.equal(mapped.projection.original_text, opaque);
      assert.equal(mapped.projection.metadata.title, opaque);
      assert.equal(mapped.projection.metadata.locator, opaque);
      assert.deepEqual(mapped.projection.metadata.reading_conditions, [opaque]);
      assert.equal(mapped.projection.original_language, source.proyeccion.idioma_original);
      assert.deepEqual(fromReadingProfile('DetailResponse', mapped), source);
      const fragment = { fragmento_id: opaque, texto: opaque, localizador: opaque };
      assert.deepEqual(toReadingProfile('Fragmento', fragment), { fragment_id: opaque, text: opaque, locator: opaque });
      assert.deepEqual(fromReadingProfile('Fragmento', toReadingProfile('Fragmento', fragment)), fragment);
    }
    for (const language of ['es', 'en']) assert.equal(toReadingProfile('IdiomaOriginal', language), language);
  });

  it('keeps unknown fields and their contents invalid at every source object boundary', () => {
    let attacks = 0;
    for (const entry of examples.casos) {
      const name = targetName(entry.response.target_schema);
      const source = clone(entry.response.body);
      for (const target of objects(source)) {
        target.value.unknown_property = { titulo: 'PUBLICADA', texto: 'Solicitud inválida' };
        assert.equal(matches(definition(name), source), false);
        const mapped = toReadingProfile(name, source);
        assert.equal(validators[name](mapped).ok, false);
        assert.deepEqual(fromReadingProfile(name, mapped), source);
        delete target.value.unknown_property;
        attacks += 1;
      }
    }
    assert.ok(attacks > 0);
    const prototypeKey = JSON.parse('{"unidad_id":"u","version_id":"v","__proto__":{"titulo":"PUBLICADA"}}');
    const mapped = toReadingProfile('ExactRequest', prototypeKey);
    assert.equal(Object.hasOwn(mapped, '__proto__'), true);
    assert.equal(Object.getPrototypeOf(mapped), Object.prototype);
    refused(validateExactRequest, mapped, 'ADDITIONAL_PROPERTY', '$');
    assert.deepEqual(fromReadingProfile('ExactRequest', mapped), prototypeKey);
  });

  it('refuses collisions and target-only fields instead of overwriting or repairing a source', () => {
    for (const source of [
      { unidad_id: 'u', unit_id: 'different', version_id: 'v' },
      { unit_id: 'different', unidad_id: 'u', version_id: 'v' },
      { unit_id: 'u', version_id: 'v' },
    ]) {
      assert.equal(matches(definition('ExactRequest'), source), false);
      const before = JSON.stringify(source);
      assert.throws(() => toReadingProfile('ExactRequest', source), /Profile field collision|Foreign profile field/);
      assert.equal(JSON.stringify(source), before);
    }
    assert.throws(() => toReadingProfile('Metadata', { titulo: 'original', title: 'replacement' }), /Profile field collision|Foreign profile field/);
    assert.throws(() => fromReadingProfile('Reference', { unit_id: 'u', unidad_id: 'replacement', version_id: 'v' }), /Profile field collision|Foreign profile field/);
    assert.throws(() => fromReadingProfile('Metadata', { title: 'original', titulo: 'replacement' }), /Profile field collision|Foreign profile field/);
    assert.throws(() => fromReadingProfile('Reference', { unidad_id: 'u', version_id: 'v' }), /Foreign profile field/);
  });

  it('preserves malformed shapes and unknown values without adopting symbols from the other profile', () => {
    for (const invalid of [null, false, 12, [], 'not an object']) {
      assert.deepEqual(toReadingProfile('ExactRequest', invalid), invalid);
      assert.equal(validateExactRequest(toReadingProfile('ExactRequest', invalid)).ok, false);
    }
    const source = clone(examples.casos.find((entry) => entry.id === 'D04_CONTENIDO_ES_UI_ES').response.body);
    source.proyeccion.metadatos.estado_editorial = 'NOT_AN_EDITORIAL_STATE';
    const mapped = toReadingProfile('DetailResponse', source);
    assert.equal(matches(definition('DetailResponse'), source), false);
    refused(validateDetailResponse, mapped, 'ENUM', '$.projection.metadata.editorial_state');
    assert.deepEqual(fromReadingProfile('DetailResponse', mapped), source);
    source.proyeccion.metadatos.estado_editorial = 'PUBLISHED';
    assert.throws(() => toReadingProfile('DetailResponse', source), /Foreign profile value/);
    const english = content();
    english.projection.metadata.editorial_state = 'PUBLICADA';
    assert.throws(() => fromReadingProfile('DetailResponse', english), /Foreign profile value/);
    const mixed = { ...content(), contract: READING_PROFILE_MAPPING.sourceProfile };
    refused(validateDetailResponse, mixed, 'CONST', '$.contract');
    for (const entry of examples.casos) {
      assert.equal(validators[targetName(entry.response.target_schema)](entry.response.body).ok, false);
    }
  });
});

describe('Original string preservation and bounds (shape, not semantic authority)', () => {
  it('uses Unicode code points, accepts exact boundary values and never truncates', () => {
    assert.equal(validateExactRequest({ unit_id: '😀'.repeat(128), version_id: 'v' }).ok, true);
    refused(validateExactRequest, { unit_id: '😀'.repeat(129), version_id: 'v' }, 'MAX_LENGTH', '$.unit_id');
    refused(validateExactRequest, { unit_id: '', version_id: 'v' }, 'MIN_LENGTH', '$.unit_id');
    refused(validateExactRequest, { unit_id: 12, version_id: 'v' }, 'TYPE', '$.unit_id');
    const value = content();
    value.projection.original_text = '😀'.repeat(100000);
    assert.equal(validateDetailResponse(value).ok, true);
    value.projection.original_text += 'x';
    refused(validateDetailResponse, value, 'MAX_LENGTH', '$.projection.original_text');
    value.projection.original_text = '';
    value.projection.metadata.title = 'x'.repeat(256);
    assert.equal(validateDetailResponse(value).ok, true);
    value.projection.metadata.title += 'x';
    refused(validateDetailResponse, value, 'MAX_LENGTH', '$.projection.metadata.title');
    value.projection.metadata.title = '';
    value.projection.metadata.reading_conditions = ['x'.repeat(257)];
    refused(validateDetailResponse, value, 'MAX_LENGTH', '$.projection.metadata.reading_conditions[0]');
  });

  it('applies the full 100000-code-point text limit to metadata and fragment locators', () => {
    for (const [select, path] of [
      [(value) => value.projection.metadata, '$.projection.metadata.locator'],
      [(value) => value.projection.fragments[0], '$.projection.fragments[0].locator'],
    ]) {
      const value = excerpt();
      select(value).locator = '😀'.repeat(100000);
      assert.equal(validateDetailResponse(value).ok, true);
      assert.equal([...select(value).locator].length, 100000);
      select(value).locator += 'x';
      refused(validateDetailResponse, value, 'MAX_LENGTH', path);
      assert.equal([...select(value).locator].length, 100001, 'rejection does not truncate the locator');
    }
  });

  it('checks array boundaries without shortening any list or excerpt', () => {
    const list = { contract: READING_CONTRACT, items: Array.from({ length: 16 }, refView), existence_signal: false };
    assert.equal(validateListResponse(list).ok, true); // Uniqueness/order require the service, not this schema.
    list.items.push(refView());
    refused(validateListResponse, list, 'MAX_ITEMS', '$.items');
    const value = excerpt();
    value.projection.fragments = Array.from({ length: 8 }, () => ({ fragment_id: 'f', text: '' }));
    assert.equal(validateDetailResponse(value).ok, true);
    value.projection.fragments.push({ fragment_id: 'f9', text: '' });
    refused(validateDetailResponse, value, 'MAX_ITEMS', '$.projection.fragments');
    value.projection.fragments = [];
    refused(validateDetailResponse, value, 'MIN_ITEMS', '$.projection.fragments');
  });

  it('preserves each declared original and fragment through validation and JSON round trip', () => {
    let comparisons = 0;
    for (const entry of cases) {
      for (const comparison of entry.comprobaciones_exactitud ?? []) {
        const result = validateDetailResponse(JSON.parse(JSON.stringify(entry.response.body)));
        assert.equal(result.ok, true);
        const restored = fromReadingProfile('DetailResponse', result.value);
        const actual = at({ response: { body: restored } }, comparison.json_pointer);
        const original = byOriginal.get(comparison.original_id);
        if (comparison.tipo === 'TEXTO_ORIGINAL_IDENTICO') assert.equal(actual, original.texto_original);
        else if (comparison.tipo === 'FRAGMENTOS_DECLARADOS_IDENTICOS') assert.deepEqual(actual, original.fragmentos_declarados);
        else if (comparison.tipo === 'FRAGMENTOS_SUBCADENAS_EXACTAS') {
          for (const fragment of actual) assert.ok(original.texto_original.includes(fragment.texto));
        } else assert.fail(`Unhandled exactness assertion: ${comparison.tipo}`);
        comparisons += 1;
      }
    }
    assert.equal(comparisons, 7, 'all declared source exactness assertions must run');
    const unusual = '  cafe\u0301 ≠ café\r\n\n\t😀 <script>no execution here</script>  ';
    const value = content();
    value.projection.original_text = unusual;
    assert.equal(validateDetailResponse(value).value.projection.original_text, unusual);
    assert.notEqual(unusual, unusual.normalize('NFC'));
  });

  it('does not pretend shape validation detects lost source text or unsafe semantic omissions', () => {
    const value = content();
    value.projection.original_text = value.projection.original_text.slice(0, 12);
    assert.equal(validateDetailResponse(value).ok, true, 'shape cannot compare to an unavailable stored original');
    assert.notEqual(value.projection.original_text, byOriginal.get('ORIGINAL_ES_V2').texto_original);
    value.projection.metadata = {};
    assert.equal(validateDetailResponse(value).ok, true, 'structural optionality is not contextual completeness');
  });

  it('preserves source equality comparisons without calling them non-interference proofs', () => {
    assert.equal(examples.comparaciones.length, 7);
    for (const comparison of examples.comparaciones) {
      if (comparison.tipo === 'RESPUESTAS_IDENTICAS') {
        const baseline = at(byId.get(comparison.casos[0]), comparison.json_pointer);
        for (const id of comparison.casos.slice(1)) assert.deepEqual(at(byId.get(id), comparison.json_pointer), baseline);
      } else if (comparison.tipo === 'VERSION_EXACTA') {
        const projection = byId.get(comparison.casos[0]).response.body.projection;
        const original = byOriginal.get(comparison.original_id);
        assert.deepEqual(fromReadingProfile('Reference', projection.reference), original.referencia);
        assert.equal(projection.original_text, original.texto_original);
      } else assert.fail(`Unhandled comparison: ${comparison.tipo}`);
    }
  });
});

describe('English public problems and consumer boundary', () => {
  it('keeps emission closed but consumes unknown extensions without retaining them', () => {
    for (const problem of Object.values(PROBLEMS)) {
      const extended = { ...problem, detail: 'secret', instance: '/hidden', unknown_extension: { allowed: true } };
      refused(validateProblem, extended, 'ADDITIONAL_PROPERTY', '$');
      assert.deepEqual(consumeProblem(extended, problem.status), { ok: true, value: problem });
      assert.ok(!JSON.stringify(consumeProblem(extended, problem.status)).includes('secret'));
    }
  });
  it('rejects mismatched status/code/title and actual HTTP status', () => {
    refused(validateProblem, { ...PROBLEMS[404], code: 'UNAUTHENTICATED' }, 'CONST', '$.code');
    refused(validateProblem, { ...PROBLEMS[404], title: 'secret' }, 'CONST', '$.title');
    refused(validateProblem, { ...PROBLEMS[404], status: 401 }, 'ENUM', '$.status');
    refused(validateProblem, { ...PROBLEMS[404], status: '404' }, 'ENUM', '$.status');
    refused((value) => consumeProblem(value, 503), PROBLEMS[404], 'HTTP_STATUS_MISMATCH', '$.status');
    refused((value) => consumeProblem(value, 404), { type: 'about:blank', title: 'Unavailable', status: 404 }, 'REQUIRED', '$.code');
  });
  it('does not echo supplied values or unknown property names in failure diagnostics', () => {
    const failure = refused(validateListRequest, { 'secret-person@example.invalid': 'private' }, 'ADDITIONAL_PROPERTY');
    assert.deepEqual(failure, { ok: false, issue: { code: 'ADDITIONAL_PROPERTY', path: '$' } });
    for (const value of [null, [], 42, true, new Date(), Object.create({ injected: true })]) {
      refused(validateListRequest, value, 'TYPE', '$');
    }
    let getterRead = false;
    const nonJSON = { get unit_id() { getterRead = true; return 'u'; }, version_id: 'v' };
    assert.equal(validateExactRequest(nonJSON).ok, false);
    assert.equal(getterRead, false);
    const list = { contract: READING_CONTRACT, items: [refView()], existence_signal: false };
    Object.defineProperty(list.items, '0', { get() { getterRead = true; return refView(); }, enumerable: true });
    assert.deepEqual(validateListResponse(list), { ok: false, issue: { code: 'TYPE', path: '$.items' } });
    assert.equal(getterRead, false);
    const items = [refView()];
    items.toJSON = () => ['unvalidated replacement'];
    assert.deepEqual(validateListResponse({ ...list, items }), { ok: false, issue: { code: 'TYPE', path: '$.items' } });
  });
});

describe('English TypeScript consumer and dependency boundary', () => {
  it('typechecks all source definitions/examples and rejects incompatible consumers without writing output', () => {
    const names = Object.keys(schema.$defs);
    const lines = [`import type { ${names.map(typeName).join(', ')} } from '../../src/contracts/material_reading.ts';`];
    let index = 0;
    for (const name of names) {
      lines.push(`const d${index++} = ${JSON.stringify(toReadingProfile(name, sample(definition(name))))} satisfies ${typeName(name)};`);
    }
    for (const entry of examples.casos) {
      for (const [target, value, valid] of [
        [targetName(entry.request.target_schema), entry.request.input, entry.request.schema_valid],
        [targetName(entry.response.target_schema), entry.response.body, entry.response.schema_valid],
      ]) {
        if (!valid) lines.push('// @ts-expect-error source-declared invalid shape');
        lines.push(`const e${index++} = ${JSON.stringify(toReadingProfile(target, value))} satisfies ${typeName(target)};`);
      }
    }
    lines.push('// @ts-expect-error no body on reference projection');
    lines.push(`const badReference = ${JSON.stringify({ ...refView(), original_text: 'not allowed' })} satisfies ReferenceView;`);
    lines.push('// @ts-expect-error no mismatched problem status/code');
    lines.push(`const badProblem = ${JSON.stringify({ ...PROBLEMS[404], code: 'UNAUTHENTICATED' })} satisfies Problem;`);
    const virtualPath = fileURLToPath(new URL('./reading_type_consumer.virtual.ts', import.meta.url));
    const options = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
      types: ['node'], erasableSyntaxOnly: true, verbatimModuleSyntax: true,
    };
    const host = ts.createCompilerHost(options);
    const normalized = (path) => path.replaceAll('\\', '/');
    const isVirtual = (path) => normalized(path) === normalized(virtualPath);
    const originalGet = host.getSourceFile.bind(host);
    const originalExists = host.fileExists.bind(host);
    host.fileExists = (path) => isVirtual(path) || originalExists(path);
    host.getSourceFile = (path, languageVersion, ...rest) => isVirtual(path)
      ? ts.createSourceFile(path, lines.join('\n'), languageVersion, true)
      : originalGet(path, languageVersion, ...rest);
    const program = ts.createProgram([virtualPath], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => process.cwd(), getCanonicalFileName: (name) => name, getNewLine: () => '\n',
    }));
    const contractPath = fileURLToPath(new URL('../../src/contracts/material_reading.ts', import.meta.url));
    const module = program.getSourceFile(contractPath);
    assert.ok(module, 'the actual contract module must be compiled, not a generated stand-in');
    assert.equal(module.statements.some((node) => ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)), false);
  });
});
