import { admitMaterial } from '@/server/kb/admission';
import { gapVisibleTo } from '@/server/kb/gap';
import { AppError } from '@/server/errors';
import { errorResponse, readBoundedJsonBody, REQUEST_BODY_MAX_BYTES } from '@/server/http';
import { currentClaims, isUuid } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * Admits one document into the corpus against one open knowledge gap.
 *
 * **This route carries a payload, and it is the only one in the system that carries a document.**
 * Its two siblings — triage and drafting — take none, deliberately: a caller asks for a cycle and
 * does not say what the cycle should conclude. Here the caller supplies the one thing no component
 * can produce, which is the material itself, and that is why the body exists and why it is bounded
 * by a ceiling of its own. See `REQUEST_BODY_MAX_BYTES` for why that ceiling is not the channel's.
 *
 * **Supervisor only, and the reason is not seniority.** Admission changes what every future answer
 * for this organisation may be built from, and the record of it names a person. The advance ties
 * `auth.uid()` to the approver the chain row declares, so whoever approves is whoever executes: a
 * component cannot reach this at all, because the machine actor carries no subject and there is no
 * session it could present that satisfies the tie. The role check here is the weaker, earlier line.
 *
 * **Visibility before role.** A gap this session cannot see is reported as not visible rather than
 * as a refused operation, which would confirm that it exists.
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
      throw new AppError('E_FIELD_INVALID', 400, 'the gap id is not a uuid', { field: 'id' });
    }

    const gap = await gapVisibleTo(claims, id);
    if (!gap) {
      throw new AppError('E_TICKET_NOT_VISIBLE', 404, 'no gap with that id is visible to this session', {
        gap_id: id,
      });
    }

    if (claims.role !== 'supervisor') {
      throw new AppError('E_ROLE_NOT_PERMITTED', 403, 'material is admitted by a supervisor', {
        role: claims.role,
      });
    }

    const body = await readBoundedJsonBody(request, REQUEST_BODY_MAX_BYTES);
    const document = readAdmission(body, gap.id);
    const outcome = await admitMaterial(claims, document);

    return Response.json({ admission: outcome });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The payload, field by field.
 *
 * Read rather than spread, so a key nobody published cannot reach the writer. `citable` is required
 * and has no default in either direction: the flag decides whether a document may be quoted to a
 * customer, and a default is a decision somebody did not make being taken for them.
 */
function readAdmission(body: Record<string, unknown>, gapId: string) {
  const text = (key: string): string => {
    const value = body[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppError('E_FIELD_INVALID', 400, `'${key}' is required and must be a non-empty string`, {
        field: key,
      });
    }
    return value;
  };

  const citable = body.citable;
  if (typeof citable !== 'boolean') {
    throw new AppError(
      'E_FIELD_INVALID',
      400,
      "'citable' is required and is a boolean; whether a document may be quoted is not a default",
      { field: 'citable' },
    );
  }

  const provenance = body.provenance;
  if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    throw new AppError('E_FIELD_INVALID', 400, "'provenance' is required and is an object", {
      field: 'provenance',
    });
  }
  const source = (provenance as Record<string, unknown>).source;
  const obtained_at = (provenance as Record<string, unknown>).obtained_at;
  const citability = (provenance as Record<string, unknown>).citability;
  for (const [key, value] of Object.entries({ source, obtained_at, citability })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new AppError('E_FIELD_INVALID', 400, `'provenance.${key}' is required`, {
        field: `provenance.${key}`,
      });
    }
  }

  return {
    gap_id: gapId,
    canonical_key: text('canonical_key'),
    title: text('title'),
    body: text('body'),
    citable,
    provenance: {
      source: source as string,
      obtained_at: obtained_at as string,
      citability: citability as string,
    },
  };
}
