import type { TrialConfig } from './config.ts';

/** Server-resolved reading context, not a grant of access and never a browser DTO.
 * Restriction revisions and the current instant must be resolved under admission in T04,
 * not cached in this launch context. Only the internal trial harness changes the subject.
 */
export type ReadingContext = Readonly<{
  deploymentId: string;
  scopeId: string;
  subjectId: string;
  surface: string;
  purpose: string;
  generation: string;
}>;

export function contextFromTrial(config: TrialConfig | null): ReadingContext | null {
  return config && Object.freeze({
    ...config,
    surface: 'material-reader' as const,
    purpose: 'synthetic-reading-trial' as const,
  });
}
