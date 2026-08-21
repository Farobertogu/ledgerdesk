import { withAppSession } from '@/server/db';

export const dynamic = 'force-dynamic';

/**
 * Readiness. It answers the only question a caller has before sending real traffic: is the server
 * up AND can it reach the database as the application role? A probe that reports the process alive
 * while the database is unreachable is a probe that turns a connection failure into a test failure
 * somewhere else.
 */
export async function GET(): Promise<Response> {
  try {
    const role = await withAppSession(null, async (client) => {
      const result = await client.query<{ role_in_force: string }>(
        'select current_user as role_in_force',
      );
      return result.rows[0].role_in_force;
    });
    return Response.json({ ok: true, role_in_force: role });
  } catch (error) {
    return Response.json(
      { ok: false, message: error instanceof Error ? error.message : 'database unreachable' },
      { status: 503 },
    );
  }
}
