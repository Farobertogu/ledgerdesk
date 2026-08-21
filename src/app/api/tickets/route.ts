import { AppError } from '@/server/errors';
import { errorResponse, readJsonBody } from '@/server/http';
import { currentClaims } from '@/server/session';
import { createTicket, listTickets, validateDraft } from '@/server/tickets';

export const dynamic = 'force-dynamic';

/**
 * Intake.
 *
 * The acknowledgement is the response itself: 201, the tracking number in the payload, and the row
 * persisted in NEW. Nothing about the ticket is decided here beyond the two fields the customer
 * typed — category, severity, sentiment and the SLA policy are assigned downstream, and writing a
 * placeholder for any of them would put a value on screen that nothing computed.
 *
 * A submission that repeats one already held is answered with **200** and the tracking number of
 * the ticket that holds it. The customer is told the same sentence either way, because from their
 * side the same thing happened: their enquiry is on file under that number. What must not happen
 * is a 201, which would claim a ticket was created when none was.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const claims = await currentClaims();
    if (!claims) {
      throw new AppError('E_NO_SESSION', 401, 'no session is selected');
    }
    if (claims.role !== 'customer') {
      throw new AppError('E_ROLE_NOT_PERMITTED', 403, 'a ticket is filed by a customer', {
        role: claims.role,
      });
    }

    const body = await readJsonBody(request);
    const draft = validateDraft({ subject: body.subject, body: body.body });
    const { acknowledgement, collapsed } = await createTicket(claims, draft);

    return Response.json(acknowledgement, {
      status: collapsed ? 200 : 201,
      headers: { Location: `/api/tickets/${acknowledgement.tracking_id}` },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The tickets the session may see. Which ones those are is the database's decision. */
export async function GET(): Promise<Response> {
  try {
    const claims = await currentClaims();
    if (!claims) {
      throw new AppError('E_NO_SESSION', 401, 'no session is selected');
    }
    const tickets = await listTickets(claims);
    return Response.json({ tickets });
  } catch (error) {
    return errorResponse(error);
  }
}
