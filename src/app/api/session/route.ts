import { cookies } from 'next/headers';

import { AppError } from '@/server/errors';
import { errorResponse, readJsonBody } from '@/server/http';
import {
  currentIdentity,
  devIdentityEnabled,
  findIdentity,
  listIdentities,
  sessionCookie,
} from '@/server/session';

export const dynamic = 'force-dynamic';

/** The identity in force, and the directory to choose from. Both empty when the selector is off. */
export async function GET(): Promise<Response> {
  try {
    const [identity, identities] = await Promise.all([currentIdentity(), listIdentities()]);
    return Response.json({ enabled: devIdentityEnabled(), identity, identities });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Selects a development identity. The id must be one the seed actually created. */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!devIdentityEnabled()) {
      throw new AppError(
        'E_DEV_IDENTITY_DISABLED',
        403,
        'this build does not carry the development identity selector',
      );
    }

    const body = await readJsonBody(request);
    const userId = typeof body.user_id === 'string' ? body.user_id : '';
    const identity = userId ? await findIdentity(userId) : null;
    if (!identity) {
      throw new AppError('E_FIELD_INVALID', 400, 'user_id is not a seeded identity', {
        field: 'user_id',
      });
    }

    const jar = await cookies();
    jar.set(sessionCookie.name, identity.user_id, sessionCookie.options);
    return Response.json({ identity });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(): Promise<Response> {
  const jar = await cookies();
  jar.delete(sessionCookie.name);
  return Response.json({ identity: null });
}
