import type {ReceptionV2} from '../../contracts/intake_reception_v2.ts';
import type {ItemPhase} from './view_model.ts';

/** A displayed receipt never supplies an unobserved extraction or preparation result. */
export function receptionStatus(receipt: ReceptionV2): {phase: ItemPhase; detail: string} {
  if (receipt.state === 'stopped') return {phase: 'stopped', detail: 'The service recorded a stop. Retained history and the original were not erased.'};
  if (receipt.state !== 'received') return {phase: receipt.state === 'uncertain' ? 'uncertain' : 'recorded',
    detail: `Current reception state: ${receipt.state}. This is not a completed receipt.`};
  const work = receipt.work?.state;
  if (work && ['claimed', 'running', 'result_staged', 'stopping'].includes(work))
    return {phase: 'extracting', detail: `Original received. Extraction state: ${work}. No accepted result is implied.`};
  if (work === 'uncertain')
    return {phase: 'uncertain', detail: 'Original received. The extraction outcome is uncertain; do not infer that it failed or repeat its effect.'};
  return {phase: 'received', detail: 'Original received. Extraction and preparation are separate stages.'};
}

export function extractionStatus(view: string, content: {outcome: string} | null | undefined): {phase: ItemPhase; detail: string} {
  if (view !== 'content' || !content) return {phase: 'received', detail: 'Only extraction metadata is currently available.'};
  return {phase: content.outcome === 'failed' ? 'failed' : 'extracted',
    detail: `Extraction observed: ${content.outcome}. Preparation is a separate human act.`};
}

export function recoveredPreparationStatus(observed: string): {phase: ItemPhase; detail: string} {
  return {phase: 'recorded', detail: `Retained preparation result: ${observed}. No operation was repeated.`};
}

export function rejectedReceptionStatus(status: number): {phase: ItemPhase; detail: string} {
  return {phase: 'failed', detail: `The service rejected this reception request (${status}). Earlier recorded work is retained; reconcile its current state.`};
}
