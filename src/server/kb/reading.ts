import type { DetailResponse, ExactRequest, ListResponse, Problem } from '../../contracts/material_reading.ts';
import type { ReadingContext } from '../reading/context.ts';

export type ReadingOperation = Readonly<{ kind: 'list' } | { kind: 'exact'; reference: ExactRequest }>;
export type ReadingOutcome = ListResponse | DetailResponse | Problem;

/** An internal receipt names durable evidence; it is not material and never travels in the DTO.
 * These interfaces specify obligations for T04; TypeScript cannot prove durability, current
 * authorization, faithful substring selection or an irreversible transport handoff.
 */
export type EvidenceReceipt = Readonly<{ receiptId: string }>;
export type TransportObservation = Readonly<{
  outcome: 'finished' | 'interrupted' | 'uncertain';
  // An observed Node handoff is not human reception. Unknown stays null, never invented zero.
  observedBytes: number | null;
}>;

export interface ReadingEvidencePort {
  // Minimal decision metadata only; no document body, SQL, credential or public error detail.
  persistBeforeAccess(input: Readonly<{
    context: ReadingContext;
    operation: ReadingOperation;
    restrictionRevision: string;
    decisionId: string;
  }>): Promise<EvidenceReceipt>;
  recordObservedResult(receipt: EvidenceReceipt, observation: TransportObservation): Promise<void>;
}

/** Preparation stays behind the common admission owner. Its implementation must keep the
 * admission across known commit -> controlled transport handoff, without holding SQL on I/O.
 * Returning a DTO or resolving this function alone does not discharge those obligations.
 */
export interface ReadingMaterialPort {
  deliverUnderAdmission(
    context: ReadingContext,
    operation: ReadingOperation,
    evidence: ReadingEvidencePort,
    // Called by the admission owner only after known durable evidence/commit and with the
    // guard still held. This must instrument the selected transport, not merely return a Response.
    terminal: (prepared: Readonly<{ response: ReadingOutcome; evidence: EvidenceReceipt }>) => Promise<TransportObservation>,
  ): Promise<TransportObservation>;
}
