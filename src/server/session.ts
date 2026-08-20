import { cookies } from 'next/headers';

import { withAppSession, type Claims, type UserRole } from '@/server/db';

/**
 * Identity for the build, and only for the build.
 *
 * On the deployment target the platform issues the session token and the database reads its claims
 * through `auth.jwt()`. That integration is not this card's, so the consoles carry a development
 * session selector instead: a cookie holding the id of one of the seeded users, resolved against
 * `app_user` on every request.
 *
 * What that means, said plainly rather than dressed up: this is NOT authentication. Anyone who can
 * set a cookie can act as any seeded user. It is deliberately not a fake sign-in page, because a
 * fake sign-in page would look like the real thing in a screenshot. What it does buy is that the
 * claims a request runs under always come from the database's own record of that user — the
 * application never invents an organisation or a role — so the policies are exercised against real
 * claim sets from the first day.
 */

const SESSION_COOKIE = 'ld_dev_user';

export type Identity = {
  user_id: string;
  role: UserRole;
  locale: string;
  org_id: string;
  org_name: string;
};

type IdentityRow = {
  user_id: string;
  role: UserRole;
  locale: string;
  org_id: string;
  org_name: string;
};

const IDENTITY_SELECT = `
  select u.id as user_id, u.role, u.locale, o.id as org_id, o.name as org_name
    from app_user u
    join org o on o.id = u.org_id`;

/** Every seeded identity, ordered so the two organisations always list the same way. */
export async function listIdentities(): Promise<Identity[]> {
  return withAppSession(null, async (client) => {
    const result = await client.query<IdentityRow>(
      `${IDENTITY_SELECT} order by o.name, u.role, u.id`,
    );
    return result.rows;
  });
}

export async function findIdentity(userId: string): Promise<Identity | null> {
  if (!isUuid(userId)) return null;
  return withAppSession(null, async (client) => {
    const result = await client.query<IdentityRow>(`${IDENTITY_SELECT} where u.id = $1`, [userId]);
    return result.rows[0] ?? null;
  });
}

/** The identity of the current request, or null when no session is selected. */
export async function currentIdentity(): Promise<Identity | null> {
  const jar = await cookies();
  const userId = jar.get(SESSION_COOKIE)?.value;
  if (!userId) return null;
  return findIdentity(userId);
}

/** The claim set the current request runs under, in the shape the policies read. */
export async function currentClaims(): Promise<Claims | null> {
  const identity = await currentIdentity();
  return identity ? claimsFor(identity) : null;
}

export function claimsFor(identity: Identity): Claims {
  return { org_id: identity.org_id, role: identity.role, sub: identity.user_id };
}

export const sessionCookie = {
  name: SESSION_COOKIE,
  // httpOnly keeps the selector out of client script; it is a development convenience, not a
  // security control, and the comment at the top of this file is the honest description of it.
  options: { httpOnly: true, sameSite: 'lax', path: '/' } as const,
};

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
