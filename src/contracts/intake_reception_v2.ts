import {array, choice, closed, exactReference, identifier, integer, record, revision, type Rule} from './intake.ts';
import {RECEPTION_RESPONSE, RECEPTION_FORMATS, type ReceptionResponse} from './intake_reception.ts';
import {EXTRACTION_STATES, type Exact, type ExtractionState} from './intake_extraction.ts';

export type ExtractionStatus = {
  id: string; revision: number; state: ExtractionState; attempt_generation: number;
  result_effect: Exact | null;
};
export const EXTRACTION_STATUS: Rule = value => {
  if (!closed({id: identifier, revision, state: choice(...EXTRACTION_STATES), attempt_generation: integer,
    result_effect: item => item === null || exactReference(item)})(value) || !record(value)) return false;
  if (Number(value.attempt_generation) > 2) return false;
  if ((value.state === 'accepted') !== (value.result_effect !== null)) return false;
  if (['claimed', 'running', 'result_staged', 'accepted'].includes(String(value.state)) && value.attempt_generation === 0) return false;
  return true;
};
export type ReceptionV2 = Omit<ReceptionResponse, 'representation' | 'work'> & {
  representation: 'intake-reception/2';
  work: null | {id: string; state: ExtractionState; dispatchable: boolean; extraction: ExtractionStatus | null};
};
/** Validate legacy receipt facts independently of the separately produced job status. */
export const RECEPTION_RESPONSE_V2: Rule = value => {
  if (!record(value) || value.representation !== 'intake-reception/2') return false;
  if (value.work !== null && (!closed({id: identifier, state: choice(...EXTRACTION_STATES), dispatchable: choice(true, false),
    extraction: item => item === null || EXTRACTION_STATUS(item)})(value.work) || !record(value.work))) return false;
  const work = value.work as ReceptionV2['work'];
  if (work && (work.dispatchable !== (work.state === 'eligible') ||
    (work.extraction ? work.extraction.id !== work.id || work.extraction.state !== work.state : !['not_started', 'stopped'].includes(work.state)))) return false;
  return RECEPTION_RESPONSE({...value, representation: 'intake-reception/1', work: work ? {
    id: work.id, state: value.state === 'stopped' ? 'stopped' : 'not_started', dispatchable: false,
  } : null});
};
export function receptionV2(receipt: ReceptionResponse, extraction: ExtractionStatus | null): ReceptionV2 {
  if (!RECEPTION_RESPONSE(receipt) || (extraction !== null && !EXTRACTION_STATUS(extraction))) throw Error('RECEPTION_V2_SOURCE');
  if (extraction && receipt.work?.id !== extraction.id) throw Error('RECEPTION_V2_JOB');
  const result: ReceptionV2 = {...receipt, representation: 'intake-reception/2', work: receipt.work ? {
    id: receipt.work.id, state: extraction?.state ?? receipt.work.state,
    dispatchable: extraction?.state === 'eligible', extraction,
  } : null};
  if (!RECEPTION_RESPONSE_V2(result)) throw Error('RECEPTION_V2_PROJECTION');
  return result;
}
const profileEntry = closed({format_profile: choice(...RECEPTION_FORMATS), configuration: exactReference,
  original_bytes: choice(1048576), reception_available: choice(true, false), processing_available: choice(true, false)});
export const AVAILABILITY_RESPONSE_V2: Rule = value => {
  if (!closed({profile: choice('intake/1'), representation: choice('intake-availability/2'), profiles: array(profileEntry, 4)})(value) || !record(value)) return false;
  const entries = value.profiles as Record<string, unknown>[];
  return new Set(entries.map(entry => entry.format_profile)).size === entries.length;
};
