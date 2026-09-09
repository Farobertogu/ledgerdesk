/** Executable access/1 shapes. A valid intention does not establish route admission. */
export const ACCESS_PROFILE = 'access/1' as const;
type Shape =
  | { kind: 'text'; min: number; max: number; pattern?: string }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; values: readonly (string | boolean)[] }
  | { kind: 'array'; item: Shape; min: number; max: number }
  | { kind: 'object'; fields: Readonly<Record<string, Shape>> };
const text = (min: number, max: number, pattern?: string): Shape => ({ kind: 'text', min, max, ...(pattern ? { pattern } : {}) });
const integer = (min = 1, max = Number.MAX_SAFE_INTEGER): Shape => ({ kind: 'integer', min, max });
const choices = (...values: (string | boolean)[]): Shape => ({ kind: 'enum', values });
const object = (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields });
const array = (item: Shape, min: number, max: number): Shape => ({ kind: 'array', item, min, max });
const id = text(1, 128, '^[A-Za-z0-9][A-Za-z0-9._:-]*$');
const exactEmail = text(3, 254, '^[^\\s@]+@[^\\s@]+$');
const secret = text(1, 1024);
const code = text(43, 43, '^[A-Za-z0-9_-]+$');
const revision = integer();
const empty = object({});
const reason = text(1, 1000);
const proof = object({ challenge_id: id, code, password: secret });
const grant = object({ permission_id: id, exercise_or_grant: choices('exercise', 'grant'), scope_ref: id, support_ref: id });
const accepted = object({ status: choices('accepted') });
const completed = object({ operation_id: id, status: choices('completed'), revision });
const receipt = object({ operation_id: id, status: choices('accepted', 'completed', 'not_completed') });
const session = object({ authenticated: choices(true), session_revision: revision, csrf_token: code });
const capability = object({
  capability_id: id, implemented: choices(true, false), enabled: choices(true, false),
  authorized: choices('yes', 'no', 'unverified'), executable: choices('yes', 'no', 'unverified'),
});

/** Proposed concrete routes, not an HTTP dispatcher or a permission catalogue. */
export const ACCESS_ROUTES = {
  reception: { method: 'GET', path: '/api/access/v1/reception', request: empty, response: object({ csrf_token: code }), context: 'reception', consumer: 'T02' },
  activation_challenge: { method: 'POST', path: '/api/access/v1/activation/challenges', request: object({ email: exactEmail }), response: accepted, context: 'reception', consumer: 'T02' },
  activate_master: { method: 'POST', path: '/api/access/v1/activation/complete', request: proof, response: completed, context: 'provisional', consumer: 'T02' },
  login: { method: 'POST', path: '/api/access/v1/sessions', request: object({ email: exactEmail, password: secret }), response: session, context: 'reception', consumer: 'T02' },
  logout: { method: 'POST', path: '/api/access/v1/sessions/logout', request: empty, response: completed, context: 'session', consumer: 'T02' },
  recovery_challenge: { method: 'POST', path: '/api/access/v1/recovery/challenges', request: object({ email: exactEmail }), response: accepted, context: 'reception', consumer: 'T02' },
  recover_credential: { method: 'POST', path: '/api/access/v1/recovery/complete', request: proof, response: completed, context: 'provisional', consumer: 'T02' },
  issue_invitation: { method: 'POST', path: '/api/access/v1/invitations', request: object({ email: exactEmail, family: choices('application', 'material_governance'), grants: array(grant, 1, 32), expires_at: integer() }), response: object({ invitation_id: id, revision, status: choices('pending_acceptance') }), context: 'session', consumer: 'T03' },
  invitation_view: { method: 'GET', path: '/api/access/v1/invitations/:invitation_id', request: empty, response: object({ invitation_id: id, revision, email: exactEmail, family: choices('application', 'material_governance'), grants: array(grant, 1, 32), expires_at: integer() }), context: 'provisional_or_session', consumer: 'T03' },
  invitation_challenge: { method: 'POST', path: '/api/access/v1/invitations/:invitation_id/challenges', request: empty, response: accepted, context: 'reception', consumer: 'T03' },
  verify_invitation_email: { method: 'POST', path: '/api/access/v1/invitation-proofs/:challenge_id/verify', request: object({ code }), response: object({ proof_id: id, expires_at: integer() }), context: 'reception', consumer: 'T03' },
  accept_invitation: { method: 'POST', path: '/api/access/v1/invitations/:invitation_id/accept', request: object({ expected_revision: revision, proof_id: id }), response: completed, context: 'provisional_or_session', consumer: 'T03' },
  initial_credential: { method: 'POST', path: '/api/access/v1/account/initial-credential', request: object({ password: secret }), response: completed, context: 'provisional', consumer: 'T03' },
  withdraw_invitation: { method: 'POST', path: '/api/access/v1/invitations/:invitation_id/withdraw', request: object({ expected_revision: revision, reason }), response: completed, context: 'session', consumer: 'T03' },
  withdraw_grant: { method: 'POST', path: '/api/access/v1/grants/:grant_id/withdraw', request: object({ expected_revision: revision, reason }), response: completed, context: 'session', consumer: 'T03' },
  current_session: { method: 'GET', path: '/api/access/v1/session', request: empty, response: session, context: 'session', consumer: 'T02' },
  capabilities: { method: 'GET', path: '/api/access/v1/capabilities', request: empty, response: object({ capabilities: array(capability, 0, 64), revision }), context: 'session', consumer: 'T02' },
  people: { method: 'GET', path: '/api/access/v1/people', request: object({ cursor: text(0, 512) }), response: object({ people: array(object({ account_id: id, display_name: text(1, 200) }), 0, 100), revision, next_cursor: text(0, 512) }), context: 'session', consumer: 'T04' },
  operation_result: { method: 'GET', path: '/api/access/v1/operations/:operation_id', request: empty, response: receipt, context: 'provisional_or_session', consumer: 'T03' },
} as const;
export type AccessRoute = keyof typeof ACCESS_ROUTES;

function valid(shape: Shape, input: unknown): boolean {
  switch (shape.kind) {
    case 'text': return typeof input === 'string' && [...input].length >= shape.min && [...input].length <= shape.max &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(input) &&
      !/[\uD800-\uDFFF]/u.test(input.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')) &&
      (!shape.pattern || new RegExp(shape.pattern, 'u').test(input));
    case 'integer': return typeof input === 'number' && Number.isSafeInteger(input) && !Object.is(input, -0) && input >= shape.min && input <= shape.max;
    case 'enum': return shape.values.some((value) => value === input);
    case 'array': return Array.isArray(input) && input.length >= shape.min && input.length <= shape.max && input.every((item) => valid(shape.item, item));
    case 'object': {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
      const value = input as Record<string, unknown>;
      const keys = Object.keys(value);
      return keys.length === Object.keys(shape.fields).length && keys.every((key) => Object.hasOwn(shape.fields, key)) &&
        Object.entries(shape.fields).every(([key, field]) => Object.hasOwn(value, key) && valid(field, value[key]));
    }
  }
}

export function validateAccess(route: AccessRoute, direction: 'request' | 'response', value: unknown): boolean {
  if (!Object.hasOwn(ACCESS_ROUTES, route) || (direction !== 'request' && direction !== 'response')) return false;
  if (!valid(ACCESS_ROUTES[route][direction], value)) return false;
  if (route === 'capabilities' && direction === 'response') {
    const rows = (value as { capabilities: { capability_id: string; implemented: boolean; enabled: boolean; authorized: string; executable: string }[] }).capabilities;
    return new Set(rows.map((row) => row.capability_id)).size === rows.length &&
      rows.every((row) => (!row.enabled || row.implemented) &&
        (row.executable !== 'yes' || (row.implemented && row.enabled && row.authorized === 'yes')));
  }
  return true;
}

export const ACCESS_ERRORS = {
  invalid_request: { status: 400, title: 'Invalid request' },
  unauthenticated: { status: 403, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Operation not permitted' },
  unavailable: { status: 404, title: 'Resource unavailable' },
  revision_conflict: { status: 409, title: 'Revision conflict' },
  payload_too_large: { status: 413, title: 'Payload too large' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  rate_limited: { status: 429, title: 'Try again later' },
  technical_failure: { status: 503, title: 'Service unavailable' },
} as const;
export type AccessError = keyof typeof ACCESS_ERRORS;
export function accessProblem(code: AccessError) {
  if (!Object.hasOwn(ACCESS_ERRORS, code)) throw new Error('INVALID_PROBLEM');
  return Object.freeze({ type: `urn:ledgerdesk:access:${code}`, title: ACCESS_ERRORS[code].title, status: ACCESS_ERRORS[code].status, code });
}
export function validateAccessProblem(value: unknown, status: number, contentType: string): boolean {
  if (contentType !== 'application/problem+json' || !value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || !Object.hasOwn(ACCESS_ERRORS, v.code)) return false;
  const expected = accessProblem(v.code as AccessError);
  return Object.keys(v).length === 4 && status === expected.status && Object.entries(expected).every(([key, field]) => v[key] === field);
}

/** Strict wire decoding precedes the shape validator; no duplicate keys or numeric coercion. */
export function decodeAccess(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.length > 16384) throw new Error('PAYLOAD_LIMIT');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('INVALID_JSON'); }
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error('INVALID_JSON'); }
  let i = 0;
  const whitespace = () => { while (/[\t\r\n ]/.test(source[i] ?? '\0')) i++; };
  const string = () => {
    const start = i++;
    while (source[i] !== '"') { if (source[i] === '\\') i++; i++; }
    const value = JSON.parse(source.slice(start, ++i)) as string;
    if (/[\uD800-\uDFFF]/u.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))) throw new Error('INVALID_JSON');
    return value;
  };
  const scan = (depth: number): void => {
    if (depth > 12) throw new Error('JSON_DEPTH_LIMIT');
    whitespace();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{') {
      i++; whitespace(); const keys = new Set<string>();
      if (source[i] === '}') { i++; return; }
      do {
        whitespace(); const key = string();
        if (keys.has(key)) throw new Error('DUPLICATE_KEY'); keys.add(key);
        whitespace(); i++; scan(depth + 1); whitespace();
        if (source[i] === '}') { i++; return; } i++;
      } while (i < source.length);
    } else if (source[i] === '[') {
      i++; whitespace(); if (source[i] === ']') { i++; return; }
      do { scan(depth + 1); whitespace(); if (source[i] === ']') { i++; return; } i++; } while (i < source.length);
    } else {
      const start = i; while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
      const scalar = source.slice(start, i);
      if (!['true', 'false', 'null'].includes(scalar) &&
          (!/^(?:0|[1-9][0-9]*)$/.test(scalar) || !Number.isSafeInteger(Number(scalar)))) throw new Error('INVALID_INTEGER');
    }
  };
  scan(0);
  return parsed;
}

/** Machine-readable closed schema export; refinements in validateAccess also apply. */
export function accessSchema(route: AccessRoute, direction: 'request' | 'response'): unknown {
  if (!Object.hasOwn(ACCESS_ROUTES, route)) throw new Error('INVALID_ROUTE');
  const schema = (shape: Shape): unknown => {
    switch (shape.kind) {
      case 'text': return { type: 'string', minLength: shape.min, maxLength: shape.max, ...(shape.pattern ? { pattern: shape.pattern } : {}) };
      case 'integer': return { type: 'integer', minimum: shape.min, maximum: shape.max };
      case 'enum': return { enum: shape.values };
      case 'array': return { type: 'array', minItems: shape.min, maxItems: shape.max, items: schema(shape.item) };
      case 'object': return { type: 'object', additionalProperties: false, required: Object.keys(shape.fields), properties: Object.fromEntries(Object.entries(shape.fields).map(([key, value]) => [key, schema(value)])) };
    }
  };
  return schema(ACCESS_ROUTES[route][direction]);
}
