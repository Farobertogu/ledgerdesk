/** Explicit synthetic-trial bounds, not production configuration or a security guarantee. */
export type AccessSecurity = Readonly<{
  profile: 'access-trial/1'; sessionSeconds: number; proofSeconds: number; invitationSeconds: number;
  proofAttempts: number; loginAttempts: number; attemptWindowSeconds: number;
  bodyBytes: number; resendSeconds: number; resendLimit: number; retryLimit: number;
}>;
const bounds = {
  sessionSeconds: [1, 86400], proofSeconds: [1, 3600], invitationSeconds: [1, 604800], proofAttempts: [1, 10], loginAttempts: [1, 10],
  attemptWindowSeconds: [1, 3600], bodyBytes: [128, 16384], resendSeconds: [1, 3600], resendLimit: [1, 10], retryLimit: [0, 3],
} as const;
export function accessSecurity(input: unknown): AccessSecurity {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_SECURITY_CONFIG');
  const v = input as Record<string, unknown>;
  if (v.profile !== 'access-trial/1' || Object.keys(v).length !== Object.keys(bounds).length + 1 ||
    !Object.entries(bounds).every(([key, [min, max]]) => typeof v[key] === 'number' && Number.isSafeInteger(v[key]) && v[key] >= min && v[key] <= max)) throw new Error('INVALID_SECURITY_CONFIG');
  if (Number(v.proofSeconds) > Number(v.sessionSeconds) || Number(v.resendSeconds) > Number(v.proofSeconds)) throw new Error('INVALID_SECURITY_CONFIG');
  return Object.freeze({ ...v }) as AccessSecurity;
}

/** Issuance-time bound; acceptance must separately recheck the stored absolute expiry. */
export function invitationExpiryAllowed(config: AccessSecurity, issuedAt: number, expiresAt: number): boolean {
  const seconds = config.invitationSeconds;
  return Number.isSafeInteger(seconds) && seconds >= bounds.invitationSeconds[0] && seconds <= bounds.invitationSeconds[1] &&
    Number.isSafeInteger(issuedAt) && issuedAt >= 0 && Number.isSafeInteger(expiresAt) &&
    expiresAt > issuedAt && expiresAt - issuedAt <= seconds * 1000;
}
export const TRIAL_PASSWORD_OPTIONS = Object.freeze({ algorithm: 2, version: 1, memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 });
