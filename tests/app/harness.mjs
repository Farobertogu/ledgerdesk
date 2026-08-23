// tests/app/harness.mjs — what the application tests share: the running server, an owner
// connection used only as an oracle, and the seeded identities.
//
// The distinction the file is built around: every assertion ABOUT THE APPLICATION goes through
// HTTP, so what is measured is the behaviour a browser would get, row-level security included.
// The direct connection is the owner's and bypasses those policies on purpose — it is how the
// test asks the database what is actually stored, which is a question the application must not be
// the one to answer.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

/**
 * Runs one cycle-driving request, and absorbs a single refusal for a runtime holding a stale label.
 *
 * ## Why this exists, and why it is a retry rather than a workaround
 *
 * A file that admits material moves the snapshot pointer and puts it back when it finishes. The
 * server caches the label its runtime was built with, so a pointer moved from a test — in either
 * direction — arms the product's own staleness guard: the next cycle is refused with
 * `E_RUNTIME_SNAPSHOT_STALE`, the runtime is evicted on the way out, and the one after it works.
 * That is the declared behaviour, in as many words: **noisy once, then recovered.**
 *
 * An earlier version tried to spend that refusal inside the restore itself, by verifying a gap that
 * could do no work. It depended on such a gap existing, and the first time one did not — a file
 * whose second case failed before it opened one — the refusal fell through to the NEXT file's first
 * cycle, which is exactly what the restore was written to prevent.
 *
 * So the harness drives the product the way the product says it behaves. **This does not hide a
 * defect**: it retries exactly once, only on that code, and a runtime that were genuinely unable to
 * recover would be refused a second time and fail here — which makes this an assertion of the
 * recovery rather than an accommodation of it.
 */
async function throughStaleRuntime(perform) {
  const first = await perform();
  if (first.status !== 409 || first.body?.error?.code !== 'E_RUNTIME_SNAPSHOT_STALE') return first;

  const second = await perform();
  assert.notEqual(
    second.body?.error?.code,
    'E_RUNTIME_SNAPSHOT_STALE',
    'the runtime was still holding a stale snapshot after being refused once, so the eviction that ' +
      'the refusal is supposed to perform did not happen',
  );
  return second;
}

/**
 * Fires one triage cycle through the endpoint that exists to fire one.
 *
 * Wrapped like its drafting sibling, and it was the absence of this that made a whole file measure
 * the wrong thing. A file that admits puts the pointer back when it finishes, which leaves the
 * server holding the label it admitted into — and triage was the one cycle-driving call that
 * neither compared the two nor retried, so the next file's FIRST row went into the chain under a
 * corpus that was no longer in force. The row was real, the label was stale, and nothing said so.
 */
export async function triage(cookie, ticketId) {
  return throughStaleRuntime(() =>
    request(cookie, `/api/tickets/${ticketId}/triage`, { method: 'POST' }),
  );
}

/** Fires one drafting cycle — retrieval, a draft, a verdict on the draft — through its endpoint. */
export async function draft(cookie, ticketId) {
  return throughStaleRuntime(() =>
    request(cookie, `/api/tickets/${ticketId}/draft`, { method: 'POST' }),
  );
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

/**
 * Puts an organisation's snapshot pointer back where a file found it, and leaves the SERVER
 * agreeing with it.
 *
 * ## Why any of this is necessary
 *
 * **The runner does not execute these files in the order the list names them — it sorts them.** The
 * list in `ci/app_check.sh` is a reconciliation, not a schedule, and a run proves it: the suites
 * come back in alphabetical order whatever order they are passed in. So "the tests that move the
 * corpus run last" is not something a list can arrange, and a file that admits material leaves every
 * alphabetically-later file reading a corpus it did not expect. Three of them pin the seeded
 * snapshot by name and one asserts that both organisations share it, and all four broke on exactly
 * that.
 *
 * So a file that moves the pointer puts it back. The articles it admitted stay where they are —
 * `kb_article` is append-only and this does not pretend otherwise — but they sit under a snapshot
 * that is no longer in force, which is precisely how a corpus is supposed to keep its history.
 *
 * ## And the refusal it arms, which is absorbed elsewhere
 *
 * Moving the pointer from here, behind the server's back, arms the product's staleness guard: the
 * next cycle meets a runtime holding the label this file left behind. An earlier version tried to
 * spend that refusal here, by verifying a gap that could do no work — and it depended on such a gap
 * existing, which the first time one did not it silently stopped doing anything. The refusal is
 * absorbed by `throughStaleRuntime` instead, on every cycle-driving request, where no state of the
 * world can make it not happen.
 */
export async function restoreCorpusHead(orgId, label) {
  await asOwner(async (client) => {
    await client.query(
      'update kb_snapshot_head set kb_snapshot = $2, set_by = null where org_id = $1::uuid',
      [orgId, label],
    );
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

/** Every gap record written against a ticket, newest first, as the database holds them. */
export async function gapsFor(ticketId) {
  return asOwner(async (client) => {
    const result = await client.query(
      'select * from kb_gap where ticket_id = $1 order by created_at desc, id desc',
      [ticketId],
    );
    return result.rows;
  });
}

/** Every admission written against a gap, newest first. */
export async function admissionsFor(gapId) {
  return asOwner(async (client) => {
    const result = await client.query(
      'select * from kb_admission where gap_id = $1 order by admitted_at desc',
      [gapId],
    );
    return result.rows;
  });
}

/** Admits one document against one gap, through the route a supervisor presses. */
export async function admit(cookie, gapId, document) {
  return throughStaleRuntime(() =>
    request(cookie, `/api/gaps/${gapId}/admit`, { method: 'POST', body: document }),
  );
}

/** Re-runs the question a gap was opened against, through the route the panel offers. */
export async function verifyGap(cookie, gapId) {
  return throughStaleRuntime(() =>
    request(cookie, `/api/gaps/${gapId}/verify`, { method: 'POST' }),
  );
}

/**
 * The beats of the gap cycle: an enquiry this corpus cannot answer, and the document that answers it.
 *
 * ## Why there are four and not one
 *
 * The application tests share one database and one server, in a fixed order, and admitting a
 * document CHANGES THE CORPUS for everything that runs afterwards. One shared enquiry would mean the
 * first test that admits an answer to it makes every later test's enquiry answerable — and the later
 * tests, which are written to begin from a retrieval that finds nothing, would begin from one that
 * finds something. They would fail, or worse, pass for the wrong reason.
 *
 * So each test that admits gets a beat of its own, and the beats are written to be **lexically
 * disjoint**: no enquiry shares a stemmed word with any other beat's document, so admitting one
 * answers exactly one question. That is checked below rather than asserted here.
 *
 * ## And why none of them shares a word with the seed
 *
 * Every beat has to open on a retrieval that matches NOTHING. A single incidental word in common
 * with a seeded article is enough for the query to match it, and the outcome would come back as
 * `below_threshold` rather than `zero_match` — a different fact, correctly recorded, about a beat
 * that was measuring something else.
 */
const BEATS = [
  {
    slug: 'consignment-label-reprint',
    subject: 'Reprinting a consignment label after the lorry has left',
    body:
      'Somebody in the depot asked whether a consignment label can be reprinted once a lorry has ' +
      'already left, and which staff member is permitted to do that.',
    document: {
      canonical_key: 'ops/consignment-label-reprint',
      title: 'Reprinting a consignment label',
      body:
        'A consignment label can be reprinted by any depot staff member while the lorry is still ' +
        'in transit. Once the lorry has left, a reprint is permitted only by a supervisor, and ' +
        'the reprint is logged against the consignment.',
    },
  },
  {
    slug: 'pallet-weight-tolerance',
    subject: 'Tolerance on a declared pallet weight',
    body:
      'A colleague asked how much a pallet may differ from its declared weight before the gantry ' +
      'rejects it, and who signs off on an override.',
    document: {
      canonical_key: 'ops/pallet-weight-tolerance',
      title: 'Tolerance on a declared pallet weight',
      body:
        'A pallet may vary from its declared weight by up to three per cent before the gantry ' +
        'rejects it. An override above that tolerance is signed off by a duty supervisor and the ' +
        'override is logged against the pallet.',
    },
  },
  {
    slug: 'trailer-seal-reissue',
    subject: 'Reissuing the seal on a trailer',
    body:
      'Our yard crew asked how a seal is reissued when a trailer is opened for inspection, and ' +
      'who records the replacement.',
    document: {
      canonical_key: 'ops/trailer-seal-reissue',
      title: 'Reissuing the seal on a trailer',
      body:
        'A seal is reissued whenever a trailer is opened for inspection. The replacement seal is ' +
        'recorded against the trailer by the yard crew, and the previous seal stays on the ' +
        'inspection record.',
    },
  },
  {
    slug: 'driver-rest-interval',
    subject: 'Rest interval between two driver shifts',
    body:
      'Somebody asked what the minimum rest interval is between two driver shifts, and whether ' +
      'it differs at the weekend.',
    document: {
      canonical_key: 'ops/driver-rest-interval',
      title: 'Rest interval between two driver shifts',
      body:
        'The minimum rest interval between two driver shifts is eleven hours, and it is the same ' +
        'at the weekend. A shorter interval requires written approval from a duty supervisor ' +
        'before the shift begins.',
    },
  },
  {
    slug: 'forklift-battery-bay',
    subject: 'Rotating the forklift battery bay',
    body:
      'A colleague asked how often the forklift battery bay is rotated between the north and ' +
      'south aisles, and who publishes the rotation.',
    document: {
      canonical_key: 'ops/forklift-battery-bay',
      title: 'Rotating the forklift battery bay',
      body:
        'The forklift battery bay is rotated between the north and south aisles every fortnight. ' +
        'The rotation is published by the duty supervisor on the noticeboard.',
    },
  },
  {
    slug: 'dock-slot-booking',
    subject: 'Assigning a dock slot to an early vehicle',
    body:
      'A colleague asked how a dock slot is assigned when a vehicle turns up early, and who ' +
      'authorises it.',
    document: {
      canonical_key: 'ops/dock-slot-booking',
      title: 'Assigning a dock slot to an early vehicle',
      body:
        'A dock slot is assigned to a vehicle that turns up early only when the next slot is free. ' +
        'The duty supervisor authorises the reassignment and it is logged against the vehicle.',
    },
  },
  {
    slug: 'reefer-alarm',
    subject: 'Raising a refrigeration alarm on a reefer unit',
    body:
      'A colleague asked where a refrigeration alarm on a reefer unit is raised, and who ' +
      'acknowledges it overnight.',
    document: {
      canonical_key: 'ops/reefer-alarm',
      title: 'Raising a refrigeration alarm on a reefer unit',
      body:
        'A refrigeration alarm on a reefer unit is raised at the control room and acknowledged ' +
        'overnight by the duty controller.',
    },
  },
];

/** The provenance every admitted document in these tests declares. */
const PROVENANCE = {
  source: 'Northwind Freight operations handbook',
  obtained_at: '2026-08-24',
  citability: 'cleared for customer replies by operations',
};

/**
 * One beat, by name.
 *
 * Named rather than numbered so that a test says which question it is asking, and so that two tests
 * cannot quietly end up on the same one.
 */
export function beat(slug) {
  const found = BEATS.find((entry) => entry.slug === slug);
  assert.ok(found, `no beat named '${slug}'`);
  return {
    subject: found.subject,
    body: found.body,
    document: { ...found.document, citable: true, provenance: { ...PROVENANCE } },
  };
}

/** Every beat, for the test that measures that they stay disjoint. */
export function allBeats() {
  return BEATS.map((entry) => beat(entry.slug));
}

/**
 * An opaque token that makes one invocation of a beat distinct from every other.
 *
 * ## Two reasons, and the second is the one that is easy to get wrong
 *
 * **It goes in the BODY, because that is what intake deduplicates on.** The dedupe key is
 * `sha256(body)` and the subject plays no part in it, by design: a customer who resends the same
 * enquiry under a new subject line has still sent the same enquiry. So two tickets that shared a
 * beat's body collapsed onto the first, the second came back **200 with the incumbent's tracking
 * number instead of 201**, and every test that filed a second ticket for one beat failed on its own
 * first assertion. The mechanism was working exactly as I6 built it; the harness was feeding it two
 * identical enquiries and expecting two tickets.
 *
 * **And it is OPAQUE, because the marker travels into the retrieval query.** The query is the
 * subject and the body together, so a readable marker like `-owner` or `-early` is a real English
 * word in the search — and `owner` appears in one seeded article, `early` in one beat's admissible
 * document. A marker of that kind turns a beat that must match **nothing** into one that matches
 * something with a low rank, which comes back as `below_threshold` rather than `zero_match`: a
 * different fact, correctly recorded, about a beat that was measuring something else. This is
 * `RUN_ID` plus a digest of the caller's marker — one alphanumeric run, no separator, no word.
 *
 * The subject still carries `[RUN_ID]` verbatim, because that is what `cleanup` matches on.
 */
function markerToken(marker) {
  return `${RUN_ID}${createHash('sha256').update(String(marker), 'utf8').digest('hex').slice(0, 8)}`;
}

/**
 * Files one beat's enquiry as a ticket of its own, and returns the exact words it was filed with.
 *
 * The words come back because they ARE the query: a caller that rebuilt them would be a second
 * producer of the thing under test, and the first test to disagree with the harness about a marker
 * would fail somewhere that has nothing to do with what it measures.
 */
export async function fileBeatTicket(customerCookie, slug, marker) {
  const which = beat(slug);
  const token = markerToken(marker);
  const subject = `${which.subject} [${RUN_ID}] ${token}`;
  const body = `${which.body} ${token}`;

  const filed = await fileTicket(customerCookie, { subject, body });
  assert.equal(
    filed.status,
    201,
    `the ticket was not created (${filed.status}); a 200 here is intake collapsing this enquiry ` +
      'onto one already on file, which means two invocations shared a body',
  );
  return { ticketId: filed.body.tracking_id, subject, body, beat: which };
}

/**
 * Takes one ticket from intake to an open knowledge gap, and returns both.
 *
 * Several tests need exactly this preamble and none of them is about the preamble, so it is written
 * once. Every step goes through HTTP, because a test that reached past the routes would be measuring
 * a path the demonstration does not take.
 */
export async function ticketWithAnOpenGap(customerCookie, staffCookie, slug, marker) {
  const { ticketId, subject, body, beat: which } = await fileBeatTicket(customerCookie, slug, marker);

  const triaged = await triage(staffCookie, ticketId);
  assert.equal(triaged.status, 200, 'the triage cycle was refused');

  const drafted = await draft(staffCookie, ticketId);
  assert.equal(drafted.status, 200, 'the drafting cycle was refused');
  assert.equal(
    drafted.body.draft.outcome,
    'ESCALATED_NO_SOURCES',
    `the '${slug}' enquiry is supposed to retrieve nothing at all; it retrieved ${drafted.body.draft.retrieval}`,
  );

  const gaps = await gapsFor(ticketId);
  assert.equal(gaps.length, 1, 'exactly one gap record stands for this escalation');
  return { ticketId, gap: gaps[0], beat: which, subject, body, drafted: drafted.body.draft };
}
