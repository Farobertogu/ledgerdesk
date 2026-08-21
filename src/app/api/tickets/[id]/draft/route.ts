import { AppError } from '@/server/errors';
import { errorResponse } from '@/server/http';
import { runDraftCycle } from '@/server/draft/runner';
import { currentClaims, isUuid } from '@/server/session';
import { transitionsFrom } from '@/server/states';
import { getTicket } from '@/server/tickets';

export const dynamic = 'force-dynamic';

/**
 * Fires one drafting cycle over one ticket: retrieval, a draft, a verdict on the draft.
 *
 * **It takes no payload**, for the reason its sibling takes none: the caller asks for a cycle, it
 * does not say what the cycle should conclude. A body carrying a target state would be a caller
 * choosing a transition; a body carrying sources would be a caller choosing what the answer may
 * stand on, which is the one thing the whole increment exists to decide from the corpus.
 *
 * **Staff only, and only from an authenticated action.** Not because the ticket is not the
 * customer's, but because this cycle spends money — up to three calls against an organisation's
 * ceiling, one of them on the expensive model — and a person who can spend it is a person the
 * organisation employs.
 *
 * **And never in cascade from the intake.** It is worth naming the thing that is NOT wired: a
 * ticket arriving could trigger a triage and a draft automatically, which reads as the obvious
 * product. It is also an unbounded spend controlled by whoever writes tickets: every distinct body
 * is a distinct cache key, so a customer submitting varied text is a customer choosing how much of
 * an organisation's term budget to consume, with nothing between them and it. The trigger is a
 * person pressing a control, and the ceiling is behind that.
 *
 * **Visibility before role.** A ticket this session cannot see is reported as not visible rather
 * than as a refused operation, which would confirm that it exists.
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
      throw new AppError('E_FIELD_INVALID', 400, 'the ticket id is not a uuid', { field: 'id' });
    }

    const before = await getTicket(claims, id);
    if (!before) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no ticket with that id is visible to this session', {
        ticket_id: id,
      });
    }

    if (claims.role !== 'agent' && claims.role !== 'supervisor') {
      throw new AppError('E_ROLE_NOT_PERMITTED', 403, 'drafting is run by an agent or a supervisor', {
        role: claims.role,
      });
    }

    const outcome = await runDraftCycle(claims.org_id, id);

    // Read back under the session's own claims rather than reporting what the component believes:
    // what the caller is shown is what the database will show anybody else.
    const after = await getTicket(claims, id);
    if (!after) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'the ticket is no longer visible to this session', {
        ticket_id: id,
      });
    }

    return Response.json({ draft: outcome, ticket: after, transitions: transitionsFrom(after.status) });
  } catch (error) {
    return errorResponse(error);
  }
}
