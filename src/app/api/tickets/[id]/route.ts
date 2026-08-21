import { AppError } from '@/server/errors';
import { errorResponse } from '@/server/http';
import { currentClaims, isUuid } from '@/server/session';
import { transitionsFrom } from '@/server/states';
import { getTicket } from '@/server/tickets';

export const dynamic = 'force-dynamic';

/**
 * One ticket, with the edges the machine publishes out of its current state.
 *
 * A row the session cannot see and a row that does not exist give the same answer on purpose:
 * distinguishing them would confirm the existence of another organisation's ticket to a caller
 * who is not allowed to know it.
 */
export async function GET(
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
      throw new AppError('E_FIELD_INVALID', 400, 'the ticket id is not a uuid', { field: 'id' });
    }

    const ticket = await getTicket(claims, id);
    if (!ticket) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no ticket with that id is visible to this session', {
        ticket_id: id,
      });
    }

    return Response.json({ ticket, transitions: transitionsFrom(ticket.status) });
  } catch (error) {
    return errorResponse(error);
  }
}
