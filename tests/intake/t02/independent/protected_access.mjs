// These successful boundary events all count toward protected-access claims.
export const protectedReadKinds=Object.freeze(['open','read']);
export const protectedWriteKinds=Object.freeze(['capture','append','seal','restore_write']);
export const protectedAccessKinds=Object.freeze([...protectedReadKinds,...protectedWriteKinds]);
export const isProtectedAccess=kind=>protectedAccessKinds.includes(kind);
export const isProtectedWrite=kind=>protectedWriteKinds.includes(kind);

// A restore controller's authority is not capture authority. The current
// other-call exclusion profile has no independently bound restore proof.
export function applicableAdmissionPhase(kind) {
  if(protectedReadKinds.includes(kind))return 'read_admission';
  if(['capture','append','seal'].includes(kind))return 'capture_admission';
  return null;
}
