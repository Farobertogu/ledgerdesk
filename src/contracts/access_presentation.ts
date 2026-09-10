/** Public explanations depend only on the four already-disclosed capability axes. */
export type CapabilityAxes = {
  implemented: boolean;
  enabled: boolean;
  authorized: 'yes' | 'no' | 'unverified';
  executable: 'yes' | 'no' | 'unverified';
};
export const CAPABILITY_STATE_COPY: Record<
  CapabilityAxes['authorized'],
  string
> = {
  yes: 'Yes',
  no: 'No',
  unverified: 'Not verified',
};
export const CAPABILITY_EXPLANATIONS = [
  'available',
  'not_implemented',
  'disabled',
  'unverified',
  'not_authorized',
  'not_executable',
] as const;
export type CapabilityExplanation = (typeof CAPABILITY_EXPLANATIONS)[number];
export type Capability = CapabilityAxes & {
  capability_id: string;
  explanation: CapabilityExplanation;
};
export function capabilityExplanation(
  value: CapabilityAxes,
): CapabilityExplanation {
  if (!value.implemented) return 'not_implemented';
  if (!value.enabled) return 'disabled';
  if (value.authorized === 'unverified' || value.executable === 'unverified')
    return 'unverified';
  if (value.authorized === 'no') return 'not_authorized';
  return value.executable === 'yes' ? 'available' : 'not_executable';
}
export const CAPABILITY_COPY: Record<CapabilityExplanation, string> = {
  available:
    'Available for this session. The server checks each operation again.',
  not_implemented: 'Not implemented in this delivery.',
  disabled: 'Not enabled in this deployment.',
  unverified: 'Availability has not been verified.',
  not_authorized: 'Not authorized for this session.',
  not_executable: 'Cannot be executed now.',
};
export const INVITATION_ACTIONS = [
  'accept_invitation',
  'amend_invitation',
  'withdraw_invitation',
  'withdraw_grant',
] as const;
export type InvitationAction = {
  action: (typeof INVITATION_ACTIONS)[number];
  target_id: string;
  revision: number;
};
