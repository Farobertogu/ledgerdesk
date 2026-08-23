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

/**
 * Runs `work` the way a component runs: as `app_rw`, under one set of claims, inside a transaction
 * that is rolled back.
 *
 * This is how a test asks what a TENANT can see, as opposed to `asOwner`, which asks what is
 * stored. The two questions have different answers wherever a policy is doing its job, and a test
 * that only ever asks the second one never measures the first.
 *
 * `claims` is passed whole rather than assembled from an organisation, because the SHAPE of the
 * claim set is itself under test in places: a session with `{org_id}` and no `role` is what the
 * retrieval runs under, and a session with no `sub` is what every component in this system holds.
 */
export async function asTenant(claims, work) {
  return asOwner(async (client) => {
    await client.query('begin');
    await client.query('set local role app_rw');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify(claims),
    ]);
    try {
      return await work(client);
    } finally {
      await client.query('rollback');
    }
  });
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
 * It only reaches tickets that nothing has recorded against, and there are two kinds of record now.
 * `ledger_entry` is append-only by trigger — for the owner too — so a ticket a cycle has paid for
 * cannot be deleted at all. `response` is not append-only, but a ticket with an answer is a ticket
 * whose answer references it, and deleting the ticket would fail on that reference rather than
 * quietly taking the answer with it.
 *
 * Both exclusions are stated as predicates instead of being handled by deleting the children first,
 * and that is deliberate: a cleanup helper that could remove an answer is a cleanup helper one edit
 * away from removing the evidence a test was written to leave behind. `ci/app_check.sh` builds its
 * database from nothing and drops it afterwards, so what the tests leave behind is a database that
 * no longer exists.
 */
export async function cleanup() {
  await asOwner(async (client) => {
    await client.query(
      `delete from ticket
        where (dedupe_key like $1 or subject like $2)
          and not exists (select 1 from ledger_entry l where l.ticket_id = ticket.id)
          and not exists (select 1 from response r where r.ticket_id = ticket.id)`,
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

/** Fires one drafting cycle — retrieval, a draft, a verdict on the draft — through its endpoint. */
export async function draft(cookie, ticketId) {
  return request(cookie, `/api/tickets/${ticketId}/draft`, { method: 'POST' });
}

/** Every answer written for a ticket, newest first, as the database holds them. */
export async function responsesFor(ticketId) {
  return asOwner(async (client) => {
    const result = await client.query(
      'select * from response where ticket_id = $1 order by created_at desc, id desc',
      [ticketId],
    );
    return result.rows;
  });
}

/** The citations of one answer, joined to the article each one names under its own snapshot. */
export async function citationsFor(responseId) {
  return asOwner(async (client) => {
    const result = await client.query(
      `select c.kb_article_id::text as kb_article_id, c.kb_snapshot, a.canonical_key, a.title
         from response_citation c
         join kb_article a on a.id = c.kb_article_id and a.kb_snapshot = c.kb_snapshot
        where c.response_id = $1
        order by a.canonical_key asc, a.id asc`,
      [responseId],
    );
    return result.rows;
  });
}

/** The corpus of one organisation under the snapshot in force for it. */
export async function corpusOf(orgId) {
  return asOwner(async (client) => {
    const result = await client.query(
      `select a.id::text as id, a.canonical_key, a.title, a.body, a.kb_snapshot
         from kb_article a
         join kb_snapshot_head h on h.org_id = a.org_id and h.kb_snapshot = a.kb_snapshot
        where a.org_id = $1
        order by a.canonical_key asc, a.id asc`,
      [orgId],
    );
    return result.rows;
  });
}

/** The snapshot in force for an organisation, read from the pointer. */
export async function snapshotHead(orgId) {
  return asOwner(async (client) => {
    const result = await client.query('select kb_snapshot from kb_snapshot_head where org_id = $1', [
      orgId,
    ]);
    return result.rows[0]?.kb_snapshot ?? null;
  });
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
