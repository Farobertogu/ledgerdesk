/**
 * Public JSON contract reading/1, consumed by both HTTP and the viewer.
 * English wire profile of the pinned T02 design; the test mapping records exact equivalence.
 * The original schema/examples retain their source profile and never enter runtime data.
 * These validators check JSON shape, not authority, fidelity to a stored original,
 * HTTP parsing, contextual completeness, persistence or safe physical delivery.
 * No coercion, normalization, translation, stripping or truncation is performed.
 */
export const READING_CONTRACT = 'reading/1' as const;

// Limits of the synthetic profile only, never production parameters.
export const TRIAL_LIMITS = Object.freeze({
  references: 16, fragments: 8, text: 100000, titleOrCondition: 256, id: 128,
});
export const EDITORIAL_STATES = Object.freeze([
  'CANDIDATE', 'REJECTED', 'APPROVED_UNPUBLISHED', 'PUBLISHED',
  'SUSPENDED', 'SUPERSEDED', 'WITHDRAWN',
] as const);
export const ORIGINAL_LANGUAGES = Object.freeze(['es', 'en'] as const);
export const SUBSTANTIVE_FUNCTIONS = Object.freeze([
  'DEFINITIONAL', 'NORMATIVE', 'OPERATIONAL', 'FACTUAL',
] as const);
export const VALIDITY_BASES = Object.freeze([
  'SCOPE_ADOPTION', 'APPLICABLE_EXTERNAL_AUTHORITY',
  'VERIFIABLE_ATTESTATION', 'NON_AUTHORITATIVE_REFERENCE',
] as const);
export const APPLICATION_SCOPES = Object.freeze([
  'REUSABLE_WITH_CONDITIONS', 'SITUATED',
] as const);

export type OpaqueId = string;
export type PlainText = string;
export type Title = string;
export type ReadingCondition = string;
export type OriginalLanguage = typeof ORIGINAL_LANGUAGES[number];
export type EditorialState = typeof EDITORIAL_STATES[number];
export type Classification = Readonly<{
  substantive_function: typeof SUBSTANTIVE_FUNCTIONS[number];
  validity_basis: typeof VALIDITY_BASES[number];
  application_scope: typeof APPLICATION_SCOPES[number];
}>;
export type ListRequest = Readonly<Record<string, never>>;
export type ExactRequest = Readonly<{ unit_id: OpaqueId; version_id: OpaqueId }>;
export type Reference = ExactRequest;
export type Metadata = Readonly<{
  title?: Title;
  locator?: PlainText;
  editorial_state?: EditorialState;
  classification?: Classification;
  reading_conditions?: readonly ReadingCondition[];
}>;
export type ReferenceView = Readonly<{
  kind: 'REFERENCE'; reference: Reference; metadata: Metadata;
}>;
export type Fragment = Readonly<{
  fragment_id: OpaqueId; text: PlainText; locator?: PlainText;
}>;
export type ExcerptView = Readonly<{
  kind: 'EXCERPT'; reference: Reference; metadata: Metadata;
  original_language: OriginalLanguage; fragments: readonly Fragment[];
}>;
export type ContentView = Readonly<{
  kind: 'CONTENT'; reference: Reference; metadata: Metadata;
  original_language: OriginalLanguage; original_text: PlainText;
}>;
export type Projection = ReferenceView | ExcerptView | ContentView;
export type ListResponse = Readonly<{
  contract: typeof READING_CONTRACT;
  items: readonly ReferenceView[];
  existence_signal: boolean;
}>;
export type DetailResponse = Readonly<{
  contract: typeof READING_CONTRACT; projection: Projection;
}>;

export const PROBLEMS = Object.freeze({
  400: Object.freeze({ type: 'about:blank', title: 'Invalid request', status: 400, code: 'REQUEST_NOT_ADMITTED' } as const),
  403: Object.freeze({ type: 'about:blank', title: 'Unauthenticated', status: 403, code: 'UNAUTHENTICATED' } as const),
  404: Object.freeze({ type: 'about:blank', title: 'Unavailable', status: 404, code: 'UNAVAILABLE' } as const),
  503: Object.freeze({ type: 'about:blank', title: 'Technical failure', status: 503, code: 'TECHNICAL_FAILURE' } as const),
});
export type Problem = typeof PROBLEMS[keyof typeof PROBLEMS];

// Internal diagnostics, never public Problem fields and never submitted values.
export type ValidationIssue = Readonly<{
  code: 'TYPE' | 'REQUIRED' | 'ADDITIONAL_PROPERTY' | 'ENUM' | 'CONST'
    | 'MIN_LENGTH' | 'MAX_LENGTH' | 'MIN_ITEMS' | 'MAX_ITEMS' | 'HTTP_STATUS_MISMATCH';
  path: string;
}>;
export type ValidationResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issue: ValidationIssue }>;
type Check = (value: unknown, path: string) => ValidationIssue | undefined;
const issue = (code: ValidationIssue['code'], path: string): ValidationIssue => ({ code, path });

function jsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  // Only decoded JSON/data objects: getters and hidden keys are not JSON fields.
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function object(fields: Readonly<Record<string, Check>>, required = Object.keys(fields)): Check {
  return (value, path) => {
    if (!jsonObject(value)) return issue('TYPE', path);
    // Do not echo the unrecognized key: a supplied property name can contain data.
    if (Object.keys(value).some((key) => !Object.hasOwn(fields, key))) return issue('ADDITIONAL_PROPERTY', path);
    for (const key of required) {
      if (!Object.hasOwn(value, key)) return issue('REQUIRED', `${path}.${key}`);
    }
    for (const [key, check] of Object.entries(fields)) {
      if (Object.hasOwn(value, key)) {
        const error = check(value[key], `${path}.${key}`);
        if (error) return error;
      }
    }
  };
}

function string(max?: number, min = 0): Check {
  return (value, path) => {
    if (typeof value !== 'string') return issue('TYPE', path);
    // JSON Schema counts Unicode code points, not UTF-16 units or HTTP bytes.
    let length = 0;
    for (const _character of value) {
      length += 1;
      if (max !== undefined && length > max) return issue('MAX_LENGTH', path);
    }
    if (length < min) return issue('MIN_LENGTH', path);
  };
}

function literal(expected: string | number): Check {
  return (value, path) => value === expected ? undefined : issue('CONST', path);
}
function enumeration(values: readonly (string | number)[]): Check {
  return (value, path) => values.some((expected) => expected === value) ? undefined : issue('ENUM', path);
}
function array(item: Check, min = 0, max?: number): Check {
  return (value, path) => {
    if (!Array.isArray(value)) return issue('TYPE', path);
    if (Object.getPrototypeOf(value) !== Array.prototype) return issue('TYPE', path);
    // JSON arrays cannot carry getters, symbols or a custom toJSON serializer.
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string') return issue('TYPE', path);
      const index = Number(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
        || descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) return issue('TYPE', path);
    }
    if (value.length < min) return issue('MIN_ITEMS', path);
    if (max !== undefined && value.length > max) return issue('MAX_ITEMS', path);
    for (let index = 0; index < value.length; index += 1) {
      const error = item(value[index], `${path}[${index}]`);
      if (error) return error;
    }
  };
}

const id = string(TRIAL_LIMITS.id, 1);
const text = string(TRIAL_LIMITS.text);
const shortText = string(TRIAL_LIMITS.titleOrCondition);
const reference = object({ unit_id: id, version_id: id });
const classification = object({
  substantive_function: enumeration(SUBSTANTIVE_FUNCTIONS),
  validity_basis: enumeration(VALIDITY_BASES),
  application_scope: enumeration(APPLICATION_SCOPES),
});
const metadata = object({
  title: shortText, locator: text,
  editorial_state: enumeration(EDITORIAL_STATES), classification: classification,
  reading_conditions: array(shortText),
}, []);
const referenceView = object({ kind: literal('REFERENCE'), reference: reference, metadata: metadata });
const fragment = object({ fragment_id: id, text: text, locator: text }, ['fragment_id', 'text']);
const excerptView = object({
  kind: literal('EXCERPT'), reference: reference, metadata: metadata,
  original_language: enumeration(ORIGINAL_LANGUAGES), fragments: array(fragment, 1, TRIAL_LIMITS.fragments),
});
const contentView = object({
  kind: literal('CONTENT'), reference: reference, metadata: metadata,
  original_language: enumeration(ORIGINAL_LANGUAGES), original_text: text,
});
const projection: Check = (value, path) => {
  if (!jsonObject(value)) return issue('TYPE', path);
  if (!Object.hasOwn(value, 'kind')) return issue('REQUIRED', `${path}.kind`);
  switch (value.kind) {
    case 'REFERENCE': return referenceView(value, path);
    case 'EXCERPT': return excerptView(value, path);
    case 'CONTENT': return contentView(value, path);
    default: return issue('ENUM', `${path}.kind`);
  }
};
const listRequest = object({});
const listResponse = object({
  contract: literal(READING_CONTRACT), items: array(referenceView, 0, TRIAL_LIMITS.references),
  existence_signal: (value, path) => typeof value === 'boolean' ? undefined : issue('TYPE', path),
});
const detailResponse = object({ contract: literal(READING_CONTRACT), projection: projection });
const problemBase = object({
  type: literal('about:blank'), title: string(), status: enumeration([400, 403, 404, 503]), code: string(),
});
const problem: Check = (value, path) => {
  const error = problemBase(value, path);
  if (error) return error;
  const candidate = value as Record<string, unknown>;
  const expected = PROBLEMS[candidate.status as Problem['status']];
  if (candidate.title !== expected.title) return issue('CONST', `${path}.title`);
  if (candidate.code !== expected.code) return issue('CONST', `${path}.code`);
};

function validate<T>(check: Check, value: unknown): ValidationResult<T> {
  const error = check(value, '$');
  return error ? { ok: false, issue: error } : { ok: true, value: value as T };
}

export const validateListRequest = (value: unknown): ValidationResult<ListRequest> => validate(listRequest, value);
export const validateExactRequest = (value: unknown): ValidationResult<ExactRequest> => validate(reference, value);
export const validateListResponse = (value: unknown): ValidationResult<ListResponse> => validate(listResponse, value);
export const validateDetailResponse = (value: unknown): ValidationResult<DetailResponse> => validate(detailResponse, value);
/** Strict producer validation. Never use it to reject unknown Problem Details extensions in a consumer. */
export const validateProblem = (value: unknown): ValidationResult<Problem> => validate(problem, value);

/**
 * Consumer boundary: ignores extensions without exposing or returning them.
 * Does not determine retry, authorization, local/global failure or presentation.
 * Call with an already decoded JSON body and the real HTTP status.
 */
export function consumeProblem(value: unknown, httpStatus: number): ValidationResult<Problem> {
  if (!jsonObject(value)) return { ok: false, issue: issue('TYPE', '$') };
  const projected: Record<string, unknown> = {};
  for (const key of ['type', 'title', 'status', 'code']) {
    if (Object.hasOwn(value, key)) projected[key] = value[key];
  }
  const result = validateProblem(projected);
  if (!result.ok) return result;
  if (result.value.status !== httpStatus) return { ok: false, issue: issue('HTTP_STATUS_MISMATCH', '$.status') };
  return result;
}
