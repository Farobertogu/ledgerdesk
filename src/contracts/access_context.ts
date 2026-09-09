/** Internal producer contracts. Never deserialize these as authority from a client. */
export type IdentityContext =
  | { kind: 'reception'; treatmentRef: string; flowId: string }
  | { kind: 'provisional'; treatmentRef: string; flowId: string; proofId: string; exactEmail: string; expiresAt: number }
  | { kind: 'session'; sessionId: string; accountId: string; personLinkRef: string | null; sessionRevision: number }
  | { kind: 'service'; credentialRef: string; serviceId: string; treatmentRef: string; expiresAt: number };

export type AuthorityDecision =
  | { kind: 'verified'; snapshotRef: string; evidenceRef: string; authorityRevision: number; earliestExpiry: number | null }
  | { kind: 'rejected'; internalReason: string; revealable: boolean }
  | { kind: 'unverifiable'; internalReason: string };

export type InvestitureDeclaration = Readonly<{
  issuerPersonRef: string;
  issuerCapacityRef: string;
  holderPersonRef: string;
  functionRef: string;
  scope: { matters: readonly string[]; partitions: readonly string[]; risks: readonly string[]; populationRef: string };
  purposeRef: string;
  startsAt: number;
  continuousObligationAcceptanceRef: string | null;
  termination: { kind: 'expires'; at: number } | { kind: 'revalidate'; eventRef: string };
  maximumGradeRef: string;
  independenceDeclarationRef: string;
  replacementOrChallengeProcedureRef: string;
  revision: number;
}>;

/** Implement T02/T03 before reading consumes this port; no allow-all implementation. */
export interface CurrentAuthority {
  evaluate(input: Readonly<{
    context: IdentityContext; routeBindingRef: string; purposeRef: string;
    objectRef: string | null; expectedRevision: number | null;
    recipientRef: string; processorRef: string; admittedSnapshotRef: string;
  }>): Promise<AuthorityDecision>;
}
