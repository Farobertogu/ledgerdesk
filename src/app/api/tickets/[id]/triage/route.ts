import { AppError } from '@/server/errors';
import { errorResponse } from '@/server/http';
import { currentClaims, isUuid } from '@/server/session';
import { transitionsFrom } from '@/server/states';
import { getTicket } from '@/server/tickets';
import { runTriageCycle } from '@/server/triage/runner';

export const dynamic = 'force-dynamic';

/**
 * Fires one triage cycle over one ticket.
 *
 * **It takes no payload, and that is the whole design of this endpoint.** The caller says *run
 * triage on this ticket*; it does not say what triage should conclude, which state to move to, or
 * why. A body of `{to}` would be a caller choosing a transition, and a body of `{to, reason}` would
 * be a caller choosing an escalation reason — and the entire value of the recorded reason is that
 * a written rule chose it from a feature vector, not that somebody typed it. The transition stays
 * the component's, taken through `applyComponentTransition`, and the HTTP surface of the state
 * machine is untouched: `{console: 3, guarded: 16, illegal: 81}` is the same partition it was.
 *
 * **Staff only.** Not because a customer's ticket is not theirs, but because the cycle spends
 * money against an organisation's ceiling and a person who can spend it is a person the
 * organisation employs. The visibility check comes first, as it does everywhere on this surface: a
 * ticket this session cannot see is reported as not visible rather than as a refused operation,
 * which would confirm that it exists.
 *
 * The response carries the outcome the cycle reported, the ticket as it now stands and the edges
 * the machine publishes out of its new state — so a console can render the result of one request
 * without a second one.
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
    if (claims.role !== 'agent' && claims.role !== 'supervisor') {
      throw new AppError('E_ROLE_NOT_PERMITTED', 403, 'triage is run by an agent or a supervisor', {
        role: claims.role,
      });
    }

    const { id } = await context.params;
    if (!isUuid(id)) {
      throw new AppError('E_FIELD_INVALID', 400, 'the ticket id is not a uuid', { field: 'id' });
    }

    const before = await getTicket(claims, id);
    if (!before) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no ticket with that id is visible to this session', {
        ticket_id: id,
      });
    }

    const outcome = await runTriageCycle(claims.org_id, id);

    // Read back under the session's own claims rather than reporting what the component believes:
    // what the caller is shown is what the database will show anybody else.
    const after = await getTicket(claims, id);
    if (!after) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'the ticket is no longer visible to this session', {
        ticket_id: id,
      });
    }

    return Response.json({ triage: outcome, ticket: after, transitions: transitionsFrom(after.status) });
  } catch (error) {
    return errorResponse(error);
  }
}
