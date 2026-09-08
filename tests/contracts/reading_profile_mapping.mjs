/**
 * Test-only correspondence from the byte-pinned design profile to the English wire.
 * This table records spelling, not a policy, a runtime adapter or an editable source schema.
 * Only declared protocol positions are mapped. Original strings, opaque IDs and unknown
 * fields survive; foreign-profile fields/values and collisions fail instead of being repaired.
 */
const freeze = (value) => {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
  return Object.freeze(value);
};

export const READING_PROFILE_MAPPING = freeze({
  sourceProfile: 't02-lectura/1',
  targetProfile: 'reading/1',
  routes: {
    list: '/api/v1/material',
    sourceExact: '/api/v1/material/{unidad_id}/versiones/{version_id}',
    targetExact: '/api/v1/material/{unit_id}/versions/{version_id}',
  },
  typeNames: {
    IdOpaco: 'OpaqueId', TextoPlano: 'PlainText', Titulo: 'Title',
    CondicionLectura: 'ReadingCondition', IdiomaOriginal: 'OriginalLanguage',
    EstadoEditorial: 'EditorialState', Clasificacion: 'Classification',
    ListRequest: 'ListRequest', ExactRequest: 'ExactRequest', Reference: 'Reference',
    Metadata: 'Metadata', ReferenceView: 'ReferenceView', Fragmento: 'Fragment',
    ExcerptView: 'ExcerptView', ContentView: 'ContentView',
    ListResponse: 'ListResponse', DetailResponse: 'DetailResponse', Problema: 'Problem',
  },
  fields: {
    contrato: 'contract', unidad_id: 'unit_id', version_id: 'version_id', items: 'items',
    titulo: 'title', localizador: 'locator', estado_editorial: 'editorial_state',
    clasificacion: 'classification', condiciones_lectura: 'reading_conditions',
    funcion_sustantiva: 'substantive_function', base_de_validez: 'validity_basis',
    alcance_de_aplicacion: 'application_scope', tipo: 'kind', referencia: 'reference',
    metadatos: 'metadata', fragmento_id: 'fragment_id', texto: 'text',
    idioma_original: 'original_language', fragmentos: 'fragments', texto_original: 'original_text',
    senal_existencia: 'existence_signal', proyeccion: 'projection', codigo: 'code',
    type: 'type', status: 'status', title: 'title',
  },
  values: {
    Contract: { 't02-lectura/1': 'reading/1' },
    EstadoEditorial: {
      CANDIDATA: 'CANDIDATE', RECHAZADA: 'REJECTED', APROBADA_NO_PUBLICADA: 'APPROVED_UNPUBLISHED',
      PUBLICADA: 'PUBLISHED', SUSPENDIDA: 'SUSPENDED', SUPERSEDIDA: 'SUPERSEDED', RETIRADA: 'WITHDRAWN',
    },
    SubstantiveFunction: {
      DEFINICIONAL: 'DEFINITIONAL', NORMATIVA: 'NORMATIVE', OPERATIVA: 'OPERATIONAL', FACTUAL: 'FACTUAL',
    },
    ValidityBasis: {
      ADOPCION_DEL_AMBITO: 'SCOPE_ADOPTION', AUTORIDAD_EXTERNA_APLICABLE: 'APPLICABLE_EXTERNAL_AUTHORITY',
      ATESTACION_VERIFICABLE: 'VERIFIABLE_ATTESTATION', REFERENCIA_NO_AUTORITATIVA: 'NON_AUTHORITATIVE_REFERENCE',
    },
    ApplicationScope: { REUTILIZABLE_CON_CONDICIONES: 'REUSABLE_WITH_CONDITIONS', SITUADA: 'SITUATED' },
    ProjectionKind: { REFERENCIA: 'REFERENCE', EXTRACTO: 'EXCERPT', CONTENIDO: 'CONTENT' },
    ProblemCode: {
      PETICION_NO_ADMITIDA: 'REQUEST_NOT_ADMITTED', NO_AUTENTICADO: 'UNAUTHENTICATED',
      NO_DISPONIBLE: 'UNAVAILABLE', FALLO_TECNICO: 'TECHNICAL_FAILURE',
    },
    ProblemTitle: {
      'Solicitud inválida': 'Invalid request', 'No autenticado': 'Unauthenticated',
      'No disponible': 'Unavailable', 'Fallo técnico': 'Technical failure',
    },
  },
});

// Finite source definitions locate protocol values. null means opaque data, never text to translate.
const reference = { unidad_id: null, version_id: null };
const referenceView = { tipo: 'ProjectionKind', referencia: 'Reference', metadatos: 'Metadata' };
const excerptView = { ...referenceView, idioma_original: null, fragmentos: ['Fragmento'] };
const contentView = { ...referenceView, idioma_original: null, texto_original: null };
const shapes = freeze({
  IdOpaco: null, TextoPlano: null, Titulo: null, CondicionLectura: null, IdiomaOriginal: null,
  ListRequest: {}, ExactRequest: reference, Reference: reference,
  Clasificacion: {
    funcion_sustantiva: 'SubstantiveFunction', base_de_validez: 'ValidityBasis',
    alcance_de_aplicacion: 'ApplicationScope',
  },
  Metadata: {
    titulo: null, localizador: null, estado_editorial: 'EstadoEditorial', clasificacion: 'Clasificacion',
    condiciones_lectura: [null],
  },
  ReferenceView: referenceView,
  Fragmento: { fragmento_id: null, texto: null, localizador: null },
  ExcerptView: excerptView, ContentView: contentView,
  // Keeping all three branches here preserves contamination for the real union validator to reject.
  Projection: { ...excerptView, ...contentView },
  ListResponse: { contrato: 'Contract', items: ['ReferenceView'], senal_existencia: null },
  DetailResponse: { contrato: 'Contract', proyeccion: 'Projection' },
  Problema: { type: null, title: 'ProblemTitle', status: null, codigo: 'ProblemCode' },
});

function transform(definition, value, reverse) {
  if (definition === null) return structuredClone(value);
  if (Array.isArray(definition)) {
    return Array.isArray(value)
      ? value.map((item) => transform(definition[0], item, reverse))
      : structuredClone(value);
  }
  if (Object.hasOwn(READING_PROFILE_MAPPING.values, definition)) {
    const entries = Object.entries(READING_PROFILE_MAPPING.values[definition]);
    const pairs = reverse ? entries.map(([source, target]) => [target, source]) : entries;
    const matched = pairs.find(([source]) => source === value);
    if (matched) return matched[1];
    if (pairs.some(([, target]) => target === value)) throw new TypeError('Foreign profile value');
    return structuredClone(value);
  }
  if (!Object.hasOwn(shapes, definition)) throw new TypeError(`Unknown mapping definition: ${definition}`);
  const shape = shapes[definition];
  if (shape === null) return structuredClone(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value);
  const fields = Object.entries(shape).map(([source, child]) => {
    const target = READING_PROFILE_MAPPING.fields[source];
    if (target === undefined) throw new TypeError(`Unmapped protocol field: ${source}`);
    return reverse ? [target, source, child] : [source, target, child];
  });
  const output = {};
  for (const [key, childValue] of Object.entries(value)) {
    const known = fields.find(([source]) => source === key);
    const destination = known?.[1] ?? key;
    if (Object.hasOwn(output, destination)) throw new TypeError('Profile field collision');
    // A target-only key cannot silently repair an invalid source object, even without a collision.
    if (!known && fields.some(([, target]) => target === key)) throw new TypeError('Foreign profile field');
    Object.defineProperty(output, destination, {
      value: known ? transform(known[2], childValue, reverse) : structuredClone(childValue),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return output;
}

/** Both directions use source definition names. These functions never validate or drop fields. */
export const toReadingProfile = (definition, value) => transform(definition, value, false);
export const fromReadingProfile = (definition, value) => transform(definition, value, true);
