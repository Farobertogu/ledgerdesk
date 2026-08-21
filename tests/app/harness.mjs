// tests/app/harness.mjs — what the application tests share: the running server, an owner
// connection used only as an oracle, and the seeded identities.
//
// The distinction the file is built around: every assertion ABOUT THE APPLICATION goes through
// HTTP, so what is measured is the behaviour a browser would get, row-level security included.
// The direct connection is the owner's and bypasses those policies on purpose — it is how the
// test asks the database what is actually stored, which is a question the application must not be
// the one to answer.

import assert from 'node:assert/strict';
import pg from 'pg';

export const BASE_URL = process.env.LEDGERDESK_BASE_URL ?? 'http://127.0.0.1:3123';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set: the tests need the database the server is pointed at');
}

/** A short marker so a run's rows are identifiable and removable, and two runs never collide. */
export const RUN_ID = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export function owner() {
  return new pg.Client({ connectionString: DATABASE_URL });
}

/** Runs `work` against an owner connection. RLS does not apply here; that is the point. */
export async function asOwner(work) {
  const client = owner();
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export async function waitForServer(attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      const payload = await response.json();
      if (response.ok && payload.ok) {
        assert.equal(
          payload.role_in_force,
          'app_rw',
          'the server is not running its statements as app_rw, so no policy below would be exercised',
        );
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no healthy server at ${BASE_URL}`);
}

/**
 * Selects a development identity through the real endpoint and returns the cookie header that
 * carries it. Building the cookie by hand would test a session the server never issued.
 */
export async function sessionFor(userId) {
  const response = await fetch(`${BASE_URL}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  assert.equal(response.status, 200, `the session for ${userId} was refused`);

  const setCookie = response.headers.getSetCookie();
  const pair = setCookie
    .map((line) => line.split(';')[0])
    .find((value) => value.startsWith('ld_dev_user='));
  assert.ok(pair, 'the session endpoint issued no session cookie');
  return pair;
}

/** One request as a given session. `cookie` is null for a request with no session at all. */
export async function request(cookie, path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  return { status: response.status, headers: response.headers, body: payload };
}

/** The seeded identities, read from the database rather than copied into this file. */
export async function identities() {
  const rows = await asOwner(async (client) => {
    const result = await client.query(
      `select u.id as user_id, u.role, o.id as org_id, o.name as org_name
         from app_user u join org o on o.id = u.org_id
        order by o.name, u.role, u.id`,
    );
    return result.rows;
  });

  const pick = (orgName, role) => {
    const found = rows.find((row) => row.org_name === orgName && row.role === role);
    assert.ok(found, `the seed has no ${role} for ${orgName}`);
    return found;
  };

  return {
    all: rows,
    northwindCustomer: pick('Northwind Freight', 'customer'),
    northwindAgent: pick('Northwind Freight', 'agent'),
    northwindSupervisor: pick('Northwind Freight', 'supervisor'),
    corellaCustomer: pick('Corella Health', 'customer'),
    corellaAgent: pick('Corella Health', 'agent'),
  };
}

/**
 * Removes every row this run created. A test that leaves rows behind changes the next run.
 *
 * It only reaches tickets that nothing has recorded against. `ledger_entry` is append-only by
 * trigger — for the owner too — so a ticket a triage cycle has paid for cannot be deleted, and the
 * tests that produce one say so and leave their rows where they are. `ci/app_check.sh` builds its
 * database from nothing and drops it afterwards, so what those tests leave behind is a database
 * that no longer exists.
 */
export async function cleanup() {
  await asOwner(async (client) => {
    await client.query(
      `delete from ticket
        where (dedupe_key like $1 or subject like $2)
          and not exists (select 1 from ledger_entry l where l.ticket_id = ticket.id)`,
      [`apptest-${RUN_ID}%`, `%[${RUN_ID}]%`],
    );
  });
}

/** One ticket as the database holds it, read past every policy. */
export async function ticketRow(ticketId) {
  return asOwner(async (client) => {
    const result = await client.query('select * from ticket where id = $1', [ticketId]);
    return result.rows[0] ?? null;
  });
}

/** Every ledger row written against a ticket, oldest first. */
export async function ledgerRowsFor(ticketId) {
  return asOwner(async (client) => {
    const result = await client.query(
      'select * from ledger_entry where ticket_id = $1 order by id',
      [ticketId],
    );
    return result.rows;
  });
}

/** Every audit event filed against a ticket, oldest first. */
export async function auditRowsFor(ticketId) {
  return asOwner(async (client) => {
    const result = await client.query(
      'select * from audit_event where object_type = $1 and object_id = $2 order by id',
      ['ticket', ticketId],
    );
    return result.rows;
  });
}

/** Fires one triage cycle through the endpoint that exists to fire one. */
export async function triage(cookie, ticketId) {
  return request(cookie, `/api/tickets/${ticketId}/triage`, { method: 'POST' });
}

/**
 * Files a ticket through the real intake and returns the whole response.
 *
 * The subject carries the run marker so that `cleanup` can find it, and the body carries whatever
 * the test needs the fixture provider to answer to.
 */
export async function fileTicket(cookie, { subject, body }) {
  return request(cookie, '/api/tickets', { method: 'POST', body: { subject, body } });
}
