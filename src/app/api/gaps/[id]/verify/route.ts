import { AppError } from '@/server/errors';
import { errorResponse } from '@/server/http';
import { gapVisibleTo } from '@/server/kb/gap';
import { verifyGap } from '@/server/kb/verification';
import { currentClaims, isUuid } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Re-runs the question one gap was opened against, and closes the gap if the answer earns it.
 *
 * **It takes no payload**, for the reason the triage and drafting routes take none: the caller asks
 * for the question to be asked again and does not say what the answer should be. A body naming a
 * source would be a caller choosing what the reply may stand on; a body naming a state would be a
 * caller closing a gap by hand, which the whole record exists to make impossible.
 *
 * **Staff only, and it does not move the ticket.** The re-run writes a new answer beside the one
 * before it and leaves the ticket exactly where the escalation put it — in somebody's queue. Pulling
 * an escalated ticket back because a later search went better would be undoing a person's work while
 * they were looking at it.
 *
 * **Visibility before role**, and the outcome is reported rather than assumed: `STILL_OPEN` carries
 * the sentence saying why, because a control that appears to do nothing is worse in front of an
 * audience than one that says what happened.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const claims = await currentClaims();
    if (!claims) {
      throw new AppError('E_NO_SESSION', 401, 'no session is selected');
    }

    const { id } = await context.params;
    if (!isUuid(id)) {
      throw new AppError('E_FIELD_INVALID', 400, 'the gap id is not a uuid', { field: 'id' });
    }

    const gap = await gapVisibleTo(claims, id);
    if (!gap) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no gap with that id is visible to this session', {
        gap_id: id,
      });
    }

    if (claims.role !== 'agent' && claims.role !== 'supervisor') {
      throw new AppError('E_ROLE_NOT_PERMITTED', 403, 'a verification is run by an agent or a supervisor', {
        role: claims.role,
      });
    }

    const outcome = await verifyGap(claims, id);
    return Response.json({ verification: outcome });
  } catch (error) {
    return errorResponse(error);
  }
}
