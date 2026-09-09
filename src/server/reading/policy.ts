/** Pure preparation for the isolated reading service, not an authorization to transmit.
 * The future repository must supply a coherent, validated snapshot under admission.
 * Semantic requirements are declared with the synthetic source, not inferred from its prose.
 * This module cannot prove those declarations, durable evidence or current permission at handoff.
 */
import {
  PROBLEMS, READING_CONTRACT, TRIAL_LIMITS, validateDetailResponse, validateListResponse,
} from '../../contracts/material_reading.ts';
import type {
  DetailResponse, ExactRequest, Fragment, Metadata, OriginalLanguage, Projection, ReferenceView,
} from '../../contracts/material_reading.ts';
import type { ReadingOperation, ReadingOutcome } from '../kb/reading.ts';
import type { ReadingContext } from './context.ts';

export type Disclosure = 'NONE' | 'EXISTENCE' | 'REFERENCE' | 'EXCERPT' | 'CONTENT';
type MetadataKey = keyof Metadata;
type IdentifiableKind = Projection['kind'];
export type PolicyBinding = Readonly<ReadingContext & { action: ReadingOperation['kind'] }>;
export type Grant = Readonly<{
  binding: PolicyBinding;
  maximum: Disclosure;
  metadata: readonly MetadataKey[];
  fragmentIds: readonly string[];
  fragmentLocatorIds: readonly string[];
  validFrom: number;
  validUntil: number | null;
}>;
/** Missing tier means explicit inheritance. A denial or indeterminate tier never inherits.
 * Multiple applicable rows in one tier are unresolved, not an invented union/intersection.
 */
export type PolicyRow = Readonly<{
  binding: PolicyBinding;
  evaluation: 'GRANT' | 'DENY' | 'INDETERMINATE';
  grant?: Grant;
}>;
export type PolicyHierarchy = Readonly<{
  unit: readonly PolicyRow[];
  inherited: readonly PolicyRow[];
  general: readonly PolicyRow[];
}>;
export type ProjectionRequirements = Readonly<{
  metadata: readonly MetadataKey[];
  fragmentIds?: readonly string[];
}>;
export type StoredMaterial = Readonly<{
  deploymentId: string;
  scopeId: string;
  reference: ExactRequest;
  originalLanguage: OriginalLanguage;
  originalText: string;
  metadata: Metadata;
  fragments: readonly Fragment[];
  // A present entry asserts this projection's semantic prerequisites have been identified.
  // Its presence is not proof of fidelity; the synthetic seed and later editorial path own it.
  requirements: Readonly<Partial<Record<IdentifiableKind, ProjectionRequirements>>>;
  policy: PolicyHierarchy;
}>;
export type PolicyCause = 'ALLOWED' | 'DENIED' | 'INDETERMINATE' | 'EXPIRED'
  | 'NOT_YET_VALID' | 'CONTEXT_UNAVAILABLE' | 'PROFILE_INVALID';
export type PolicyDecision = Readonly<{
  cause: PolicyCause;
  grant: Grant | null;
}>;
export type PreparedReading = Readonly<{
  response: ReadingOutcome;
  // Private input for evidence/debt. Never serialize this wrapper as a public response.
  decisions: readonly Readonly<{ reference: ExactRequest; cause: PolicyCause }>[];
  earliestExpiry: number | null;
}>;

const CONTEXT_KEYS = [
  'deploymentId', 'scopeId', 'subjectId', 'surface', 'purpose', 'generation',
] as const;
const METADATA_KEYS: readonly MetadataKey[] = [
  'title', 'locator', 'editorial_state', 'classification', 'reading_conditions',
];
const LEVELS: readonly Disclosure[] = ['NONE', 'EXISTENCE', 'REFERENCE', 'EXCERPT', 'CONTENT'];
const refused = (cause: PolicyCause): PolicyDecision => ({ cause, grant: null });
const matches = (binding: PolicyBinding, context: ReadingContext, action: ReadingOperation['kind']) =>
  binding.action === action && CONTEXT_KEYS.every((key) => binding[key] === context[key]);

export function evaluatePolicy(
  hierarchy: PolicyHierarchy, context: ReadingContext, action: ReadingOperation['kind'], now: number,
): PolicyDecision {
  if (!Number.isFinite(now) || !hierarchy || typeof hierarchy !== 'object') return refused('INDETERMINATE');
  for (const tier of [hierarchy.unit, hierarchy.inherited, hierarchy.general]) {
    if (!Array.isArray(tier) || tier.some((row) => !row || typeof row !== 'object'
      || !row.binding || typeof row.binding !== 'object'
      || CONTEXT_KEYS.some((key) => typeof row.binding[key] !== 'string')
      || !['list', 'exact'].includes(row.binding.action))) return refused('INDETERMINATE');
    const rows = tier.filter((row) => matches(row.binding, context, action));
    if (!rows.length) continue;
    if (rows.length !== 1) return refused('INDETERMINATE');
    const row = rows[0];
    if (row.evaluation === 'DENY') return refused('DENIED');
    if (row.evaluation !== 'GRANT' || !row.grant) return refused('INDETERMINATE');
    const grant = row.grant;
    if (!grant.binding || !matches(grant.binding, context, action) || !LEVELS.includes(grant.maximum)
        || !Array.isArray(grant.metadata) || grant.metadata.some((key: MetadataKey) => !METADATA_KEYS.includes(key))
        || !Array.isArray(grant.fragmentIds) || grant.fragmentIds.some((id: unknown) => typeof id !== 'string')
        || !Array.isArray(grant.fragmentLocatorIds) || grant.fragmentLocatorIds.some((id: unknown) => typeof id !== 'string')
        || !Number.isFinite(grant.validFrom)
        || (grant.validUntil !== null && (!Number.isFinite(grant.validUntil)
          || grant.validUntil <= grant.validFrom))) return refused('INDETERMINATE');
    if (now < grant.validFrom) return refused('NOT_YET_VALID');
    if (grant.validUntil !== null && now >= grant.validUntil) return refused('EXPIRED');
    return grant.maximum === 'NONE' ? refused('DENIED') : { cause: 'ALLOWED', grant };
  }
  return refused('INDETERMINATE');
}

function permittedMetadata(material: StoredMaterial, grant: Grant): Metadata {
  // Whitelist and clone: neither raw repository rows nor later mutation enters a prepared DTO.
  const result: Record<string, unknown> = {};
  for (const key of METADATA_KEYS) {
    if (grant.metadata.includes(key) && Object.hasOwn(material.metadata, key)) {
      result[key] = structuredClone(material.metadata[key]);
    }
  }
  return result as Metadata;
}

function prerequisites(
  material: StoredMaterial, kind: IdentifiableKind, metadata: Metadata, fragments: readonly Fragment[],
): boolean {
  const required = material.requirements[kind];
  if (!required || !required.metadata.every((key) => METADATA_KEYS.includes(key)
      && Object.hasOwn(metadata, key))) return false;
  if (required.metadata.includes('reading_conditions') && !metadata.reading_conditions?.length) return false;
  // Historical/non-public material needs its real status AND the source's specific conditions.
  // This does not manufacture a generic warning or treat PUBLISHED as a permission.
  if (material.metadata.editorial_state !== 'PUBLISHED'
      && (metadata.editorial_state !== material.metadata.editorial_state
        || !metadata.editorial_state || !metadata.reading_conditions?.length)) return false;
  if (kind === 'EXCERPT' && !(required.fragmentIds ?? []).every((id) =>
    fragments.some((fragment) => fragment.fragment_id === id))) return false;
  return true;
}

function projected(
  material: StoredMaterial, grant: Grant, action: ReadingOperation['kind'],
): { projection: Projection | null; invalid: boolean } {
  const maximum = LEVELS.indexOf(grant.maximum);
  if (maximum < 2) return { projection: null, invalid: false };
  const reference = { unit_id: material.reference.unit_id, version_id: material.reference.version_id };
  const metadata = permittedMetadata(material, grant);
  const fragments = material.fragments.filter((fragment) => grant.fragmentIds.includes(fragment.fragment_id))
    .map((fragment): Fragment => ({
      fragment_id: fragment.fragment_id, text: fragment.text,
      ...(grant.fragmentLocatorIds.includes(fragment.fragment_id) && fragment.locator !== undefined
        ? { locator: fragment.locator } : {}),
    }));
  const candidates: IdentifiableKind[] = action === 'list' ? ['REFERENCE'] : ['CONTENT', 'EXCERPT', 'REFERENCE'];
  for (const kind of candidates) {
    if (LEVELS.indexOf(kind) > maximum || !prerequisites(material, kind, metadata, fragments)) continue;
    if (kind === 'EXCERPT') {
      if (!fragments.length) continue;
      // Validate explicit selection against the exact original; never compute a replacement.
      if (new Set(fragments.map((item) => item.fragment_id)).size !== fragments.length
          || fragments.some((item) => !item.text.length || !material.originalText.includes(item.text))) {
        return { projection: null, invalid: true };
      }
    }
    const projection: Projection = kind === 'CONTENT'
      ? { kind, reference, metadata, original_language: material.originalLanguage, original_text: material.originalText }
      : kind === 'EXCERPT'
        ? { kind, reference, metadata, original_language: material.originalLanguage, fragments }
        : { kind, reference, metadata };
    const result: DetailResponse = { contract: READING_CONTRACT, projection };
    // Invalid visible data is not silently truncated/downgraded to make a profile pass.
    return validateDetailResponse(result).ok
      ? { projection, invalid: false } : { projection: null, invalid: true };
  }
  return { projection: null, invalid: false };
}

const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A full declared population is prepared before selecting an exact ID. A visible profile
 * failure is therefore independent of whether that requested pair exists. Hidden/local policy
 * failures remain local. No DB health, timing, transmission or completeness proof is claimed.
 */
export function prepareReading(
  population: readonly StoredMaterial[], context: ReadingContext, operation: ReadingOperation, now: number,
): PreparedReading {
  const decisions: { reference: ExactRequest; cause: PolicyCause }[] = [];
  const visible: Projection[] = [];
  let existence = false;
  let invalid = false;
  let earliestExpiry: number | null = null;
  for (const material of population) {
    if (material.deploymentId !== context.deploymentId || material.scopeId !== context.scopeId) continue;
    const decision = evaluatePolicy(material.policy, context, operation.kind, now);
    let cause = decision.cause;
    if (decision.grant) {
      const { grant } = decision;
      let prepared: ReturnType<typeof projected>;
      try { prepared = projected(material, grant, operation.kind); }
      catch {
        decisions.push({ reference: { ...material.reference }, cause: 'INDETERMINATE' });
        continue;
      }
      if (prepared.invalid) { invalid = true; cause = 'PROFILE_INVALID'; }
      else if (grant.maximum === 'EXISTENCE') existence = true;
      else if (prepared.projection) visible.push(prepared.projection);
      else cause = 'CONTEXT_UNAVAILABLE';
      const contributes = operation.kind === 'list'
        ? Boolean(prepared.projection) || grant.maximum === 'EXISTENCE'
        : Boolean(prepared.projection) && material.reference.unit_id === operation.reference.unit_id
          && material.reference.version_id === operation.reference.version_id;
      if (contributes && grant.validUntil !== null) earliestExpiry = earliestExpiry === null
        ? grant.validUntil : Math.min(earliestExpiry, grant.validUntil);
    }
    decisions.push({ reference: { ...material.reference }, cause });
  }
  const keys = visible.map((item) => JSON.stringify([item.reference.unit_id, item.reference.version_id]));
  if (new Set(keys).size !== keys.length) invalid = true;
  if (invalid) return { response: PROBLEMS[503], decisions, earliestExpiry };
  if (operation.kind === 'list') {
    const items = (visible as ReferenceView[]).sort((a, b) =>
      ordinal(a.reference.unit_id, b.reference.unit_id) || ordinal(a.reference.version_id, b.reference.version_id));
    const response = { contract: READING_CONTRACT, items, existence_signal: existence };
    return { response: items.length <= TRIAL_LIMITS.references && validateListResponse(response).ok
      ? response : PROBLEMS[503], decisions, earliestExpiry };
  }
  const projection = visible.find((item) => item.reference.unit_id === operation.reference.unit_id
    && item.reference.version_id === operation.reference.version_id);
  return { response: projection ? { contract: READING_CONTRACT, projection } : PROBLEMS[404], decisions, earliestExpiry };
}
