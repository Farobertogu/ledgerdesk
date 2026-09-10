import type { AccessStore } from './postgres/store.ts';

/** A restored snapshot cannot attest to its own currency. The expected generation
 * is supplied independently by the trusted launcher, never loaded from that backup. */
export async function currentReadingControl(db: AccessStore, expected?: string, requireTreatment=true): Promise<any | null> {
  const exists = (await db.client.query("SELECT to_regclass('material_trial.control') AS relation")).rows[0].relation;
  if (!exists) {
    if (expected !== undefined) throw new Error('CURRENT_CONTROL_MISSING');
    return null;
  }
  const c = (await db.client.query('SELECT * FROM material_trial.control')).rows[0];
  if (!expected || !c || c.generation !== expected || !c.active ||
      (requireTreatment && (!c.capture_ready || !c.processing_ready || !c.conservation_ready || !c.trace_ready || !c.destination_ready)))
    throw new Error('CURRENT_CONTROL_UNVERIFIED');
  return c;
}
