import {BINDINGS} from './intake_bindings.ts';
import {exactReference} from './intake.ts';
import {canonicalValue} from './access_canonical.ts';
import {PREPARATION_BOUNDS} from './intake_preparation.ts';

/** A normative comparison specification, never a granted permission or an enabled catalog entry. */
export const PREPARATION_GOVERNING_SOURCE = Object.freeze({
  document: 'M04', sha256: '0ffce4be357f2d16f2abf205643117582bc168c3f442b8b10f2e8ec0dc47dd69',
  sections: ['M04-C01', 'M04-C04', 'M04-C05', 'M04-C06', 'M04-D02'],
});
export const PREPARATION_PARTITIONS: Record<string, string> = Object.freeze({
  reserve_preparation: 'preparation_work', upload_preparation: 'preparation_work', finalize_preparation: 'preparation_work',
  preparation: 'prepared_content', resource: 'prepared_resource', difference: 'preparation_difference',
  propose: 'preparation_work', constitute: 'constitution_work', lookup_operation: 'own_record',
});
const objects: Record<string, string[]> = {
  reserve_preparation: ['accepted-inputs', 'bounded-preparation-attempt'],
  upload_preparation: ['predecessor-reservation', 'exact-staged-document'],
  finalize_preparation: ['accepted-inputs', 'staged-document', 'preparation-revision', 'differences', 'selected-resources'],
  preparation: ['exact-preparation', 'visible-differences'], resource: ['preparation-association', 'exact-resource'],
  difference: ['exact-difference-pair', 'permitted-antecedents'],
  propose: ['exact-preparation', 'closed-item', 'constitution-proposal'],
  constitute: ['exact-proposal', 'exact-preparation', 'candidate-or-C9-outcome'], lookup_operation: ['editorial-effect-record'],
};
export function preparationSignature(operation: string, purpose: string, limits: unknown, mode = 'person') {
  if (!objects[operation] || !exactReference(limits) || !BINDINGS[operation].modes.includes(mode)) return null;
  return {objects: objects[operation], transitions: [BINDINGS[operation].effect], purpose,
    // These describe the affected roles. Their actual person/service/storage and scope
    // identities are resolved separately in the current admission and treatment.
    affected: ['current-principal', 'controlled-preparation-service', 'current-treatment-storage'],
    surfaces: ['current-session-origin'], autonomy: mode, limits,
    residues: ['retained-preparation-history', 'exact-source-references', 'technical-evidence']};
}
export function preparationEffectComparison(operation: string, scope: string, purpose: string, limits: unknown) {
  if (!['reserve_preparation', 'upload_preparation', 'finalize_preparation', 'propose'].includes(operation)) return null;
  const mode = operation === 'upload_preparation' ? 'authorized_consequence' : 'person';
  return {profile: 'preparation-effect-comparison/1', operation, source: PREPARATION_GOVERNING_SOURCE,
    responsibility: 'existing-internal-prepare-candidate-material', holder: 'FN-APROBACION', scope, purpose, mode,
    signature: preparationSignature(operation, purpose, limits, mode),
    population: 'currently-authorized-selected-antecedents',
    bound: {document_bytes: PREPARATION_BOUNDS.documentBytes, prepared_bytes: PREPARATION_BOUNDS.payloadBytes,
      pool_bytes: PREPARATION_BOUNDS.poolBytes, attempts: PREPARATION_BOUNDS.attempts},
    excluded_effects: ['constitute-candidate', 'approve', 'publish', 'alter-previous-version', 'grant-authority']};
}
export function comparisonMatches(operation: string, observed: unknown, scope: string, purpose: string, limits: unknown): boolean {
  const expected = preparationEffectComparison(operation, scope, purpose, limits);
  try {return expected !== null && canonicalValue(expected) === canonicalValue(observed);} catch {return false;}
}
