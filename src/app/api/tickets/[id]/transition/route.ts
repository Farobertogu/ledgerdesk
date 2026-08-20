import { AppError } from '@/server/errors';
import { errorResponse, readJsonBody } from '@/server/http';
import { currentClaims, isUuid } from '@/server/session';
import { isTicketState, transitionsFrom } from '@/server/states';
import { transitionTicket } from '@/server/tickets';

export const dynamic = 'force-dynamic';

/**
 * Moves a ticket along one edge of the state machine.
 *
 * The machine is evaluated on the server and only on the server. The consoles disable the controls
 * they know are unavailable, but that is a courtesy to the person clicking; a request that arrives
 * with an edge the machine does not publish is refused here with 409 and a typed code, whatever
 * the client believed.
 */
export async function POST(
  request: Request,
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

    const body = await readJsonBody(request);
    if (!isTicketState(body.to)) {
      throw new AppError('E_FIELD_INVALID', 400, 'to is not a ticket state', { field: 'to', to: body.to });
    }

    const ticket = await transitionTicket(claims, id, body.to);
    return Response.json({ ticket, transitions: transitionsFrom(ticket.status) });
  } catch (error) {
    return errorResponse(error);
  }
}
