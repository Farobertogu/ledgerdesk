import {
  INTAKE_PROFILE, INTAKE_LIMITS, INTAKE_ROUTES, array, artifactReference,
  choice, closed, exactReference, identifier, integer, record, revision,
  type IntakeRoute, type Rule,
} from './intake.ts';

export const RECEPTION_REPRESENTATION = 'intake-reception/1' as const;
export const AVAILABILITY_REPRESENTATION = 'intake-availability/1' as const;
export const RECEPTION_FORMATS = ['text-utf8/1', 'markdown-inert/1', 'csv-utf8/1', 'xlsx-cells/1'] as const;
export type ReceptionFormat = typeof RECEPTION_FORMATS[number];
export const RECEPTION_ROUTES = [
  'profiles', 'reserve_reception', 'upload_original', 'finalize_reception',
  'lookup_operation', 'resume_reception', 'cancel_reception', 'reception', 'original',
] as const satisfies readonly IntakeRoute[];
export type ReceptionRoute = typeof RECEPTION_ROUTES[number];
export type ExactReference = { id: string; revision: number; sha256: string };
export type OriginalReference = { id: string; generation: number; bytes: number; sha256: string };
export type ReceptionState = 'reserved' | 'receiving' | 'staged' | 'received' | 'interrupted' | 'stopped' | 'uncertain';
export type OriginalAvailability = 'not_observed' | 'verified_staged' | 'available' | 'missing' | 'corrupt';
export type ReceptionResponse = {
  profile: typeof INTAKE_PROFILE;
  representation: typeof RECEPTION_REPRESENTATION;
  operation_id: string;
  reception_id: string;
  revision: number;
  state: ReceptionState;
  original: OriginalReference;
  availability: OriginalAvailability;
  format_profile: ReceptionFormat;
  configuration: ExactReference;
  attempt_expires_at: number;
  effect: ExactReference | null;
  work: { id: string; state: 'not_started' | 'stopped'; dispatchable: false } | null;
};
const nullable = (rule: Rule): Rule => value => value === null || rule(value);
const original: Rule = value => artifactReference(value) && record(value) && Number(value.bytes) <= INTAKE_LIMITS.originalBytes;
const receptionShape = closed({
  profile: choice(INTAKE_PROFILE), representation: choice(RECEPTION_REPRESENTATION),
  operation_id: identifier, reception_id: identifier, revision,
  state: choice('reserved', 'receiving', 'staged', 'received', 'interrupted', 'stopped', 'uncertain'),
  original, availability: choice('not_observed', 'verified_staged', 'available', 'missing', 'corrupt'),
  format_profile: choice(...RECEPTION_FORMATS), configuration: exactReference, attempt_expires_at: integer,
  effect: nullable(exactReference),
  work: nullable(closed({ id: identifier, state: choice('not_started', 'stopped'), dispatchable: choice(false) })),
});
/** Receipt/work linkage is checked here; authorization is not inferred from a valid body. */
export const RECEPTION_RESPONSE: Rule = value => {
  if (!receptionShape(value) || !record(value)) return false;
  if ((value.effect === null) !== (value.work === null)) return false;
  if (value.state === 'received' && value.effect === null) return false;
  if (value.effect !== null && !['received', 'stopped'].includes(String(value.state))) return false;
  if (record(value.work) && value.work.state !== (value.state === 'stopped' ? 'stopped' : 'not_started')) return false;
  if (['available', 'missing', 'corrupt'].includes(String(value.availability)) && value.effect === null) return false;
  return true;
};
export type AvailabilityResponse = {
  profile: typeof INTAKE_PROFILE;
  representation: typeof AVAILABILITY_REPRESENTATION;
  profiles: { format_profile: ReceptionFormat; configuration: ExactReference;
    original_bytes: number; reception_available: boolean; processing_available: false }[];
};
const availabilityShape = closed({
  profile: choice(INTAKE_PROFILE), representation: choice(AVAILABILITY_REPRESENTATION),
  profiles: array(closed({ format_profile: choice(...RECEPTION_FORMATS), configuration: exactReference,
    original_bytes: choice(INTAKE_LIMITS.originalBytes), reception_available: choice(true, false), processing_available: choice(false) }), 4),
});
export const AVAILABILITY_RESPONSE: Rule = value => {
  if (!availabilityShape(value) || !record(value)) return false;
  const entries = value.profiles as AvailabilityResponse['profiles'];
  return new Set(entries.map(entry => entry.format_profile)).size === entries.length;
};
export const RECEPTION_PROBLEMS = Object.freeze({
  400: { type: 'urn:ledgerdesk:intake:invalid-request', title: 'Invalid request', code: 'invalid_request' },
  403: { type: 'urn:ledgerdesk:intake:forbidden', title: 'Forbidden', code: 'forbidden' },
  404: { type: 'urn:ledgerdesk:intake:unavailable', title: 'Unavailable', code: 'unavailable' },
  409: { type: 'urn:ledgerdesk:intake:conflict', title: 'Conflict', code: 'conflict' },
  413: { type: 'urn:ledgerdesk:intake:input-limit', title: 'Input limit exceeded', code: 'input_limit' },
  415: { type: 'urn:ledgerdesk:intake:unsupported-media', title: 'Unsupported media', code: 'unsupported_media' },
  429: { type: 'urn:ledgerdesk:intake:capacity', title: 'Capacity unavailable', code: 'capacity_unavailable' },
  503: { type: 'urn:ledgerdesk:intake:technical-failure', title: 'Service unavailable', code: 'technical_failure' },
} as const);
export type ReceptionErrorStatus = keyof typeof RECEPTION_PROBLEMS;
export function receptionProblem(status: ReceptionErrorStatus) {
  return { profile: INTAKE_PROFILE, representation: RECEPTION_REPRESENTATION, status, ...RECEPTION_PROBLEMS[status] };
}
export const RECEPTION_PROBLEM: Rule = value => record(value) && Object.keys(RECEPTION_PROBLEMS).some(key => {
  const status = Number(key) as ReceptionErrorStatus, expected = receptionProblem(status);
  return Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([name, field]) => value[name] === field);
});
/** No aliases, escaped selectors, query parameters or later consumers. */
export function resolveReceptionPath(method: string, raw: string): { route: ReceptionRoute; parameters: Record<string, string> } | null {
  if (!raw.startsWith('/api/intake/') || /[?#%\\]/.test(raw)) return null;
  for (const key of RECEPTION_ROUTES) {
    const definition = INTAKE_ROUTES[key];
    if (definition.method !== method) continue;
    const names: string[] = [];
    const expression = definition.path.replace(/:([a-z_]+)/g, (_, name: string) => { names.push(name); return '([A-Za-z0-9][A-Za-z0-9._:-]{0,127})'; });
    const match = new RegExp('^' + expression + '$').exec(raw);
    if (!match) continue;
    const parameters = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
    if (parameters.generation && (!/^[1-9][0-9]*$/.test(parameters.generation) || !revision(Number(parameters.generation)))) return null;
    return { route: key, parameters };
  }
  return null;
}
