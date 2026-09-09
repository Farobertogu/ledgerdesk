import type { ReadingContext } from './context.ts';
import type { ReadingOperation, TransportObservation } from '../kb/reading.ts';
import type { PreparedReading } from './policy.ts';

export type CommittedReading = PreparedReading & Readonly<{ receiptId: string; revision: string }>;

/** The T04 persistence refinement keeps preparation and pre-access evidence in one commit.
 * Admission must survive that commit until the actual transport observation. No engine,
 * framework, credential or raw database row crosses this port.
 */
export interface ReadingPersistencePort {
  connect(): Promise<void>;
  acquire(): Promise<void>;
  prepare(context: ReadingContext, operation: ReadingOperation): Promise<CommittedReading>;
  observe(receiptId: string, observation: TransportObservation, responseStatus: number | null): Promise<void>;
  release(): Promise<void>;
  available(): boolean;
  close(): Promise<void>;
}
