#!/usr/bin/env node
// seed/demo_load.mjs — load or reset the frozen demonstration dataset.
//
// Usage:
//   node seed/demo_load.mjs            load the dataset, resetting any ticket already there
//   node seed/demo_load.mjs --status   report where each demonstration ticket currently stands
//
// Connection comes from DATABASE_URL, or from the standard PG* environment.
//
// **Reset updates, it never deletes.** A demonstration ticket that has been triaged has ledger
// rows pointing at it by foreign key and audit rows naming it, and deleting the ticket would
// either fail against the constraint or, worse, take the evidence of the previous run with it. So
// a reset puts the row back in NEW, clears every column a triage cycle wrote, and stamps a fresh
// created_at — and the chain of what happened last time stays exactly where it was.
//
// **The answers of previous runs are left alone too, deliberately.** A reset ticket that is drafted
// again gets a NEW `response` row rather than an edited one, so a rehearsal accumulates the drafts
// it produced instead of overwriting them. That is the same property the closing act depends on:
// the same question answered badly and then well is two rows a panel can put side by side.
//
// **created_at is stamped here and not in the file.** The SLA clause is a fact about the clock: a
// dataset with fixed timestamps escalates on SLA before any model is asked, the moment it is a day
// old, and the beat that was meant to show triage shows a breach instead.
//
// **The knowledge base is not loaded from here, and the head is checked rather than written.**
// `seed/orgs.sql` holds the corpus, because every database the checks build applies the seed and
// none of them runs this script — an article the demonstration needs that lived only here would be
// an article the tests never saw. What this script does is make sure the pointer that says which
// snapshot is in force exists, and report what the corpus holds, because a rehearsal that starts
// against an organisation with no head fails at the first retrieval with a refusal that reads like
// a bug in the retrieval.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = path.join(ROOT, 'seed', 'demo_tickets.json');

/** The snapshot the seeded corpus was written under. */
const SNAPSHOT = 'kb-2026-08-01';

const RESET = `
  update ticket set
    subject = $2, body_raw = $3, language = $4, dedupe_key = $5, body_sha256 = $6,
    status = 'NEW', created_at = now(),
    category = null, severity = null, sentiment = null, confidence = null,
    body_redacted = null, sla_policy_id = null, sla_due_at = null, breached_at = null,
    priority = null, escalation_reason = null, escalation_clause = null, retries = 0
  where id = $1
  returning id`;

const INSERT = `
  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, channel, language,
                      created_at, status, dedupe_key, body_sha256)
  values ($1, $2, $3, $4, $5, $6, 'web', $7, now(), 'NEW', $8, $9)
  returning id`;

const HEAD = `
  insert into kb_snapshot_head (org_id, kb_snapshot)
  values ($1::uuid, $2)
  on conflict (org_id) do nothing
  returning org_id`;

const CORPUS = `
  select h.org_id::text as org_id, o.name, h.kb_snapshot,
         (select count(*)::int from kb_article a
           where a.org_id = h.org_id and a.kb_snapshot = h.kb_snapshot) as articles
    from kb_snapshot_head h join org o on o.id = h.org_id
   order by o.name`;

const STATUS = `
  select t.id, t.status, t.category, t.severity, t.sentiment, t.confidence, t.priority,
         t.escalation_reason, t.escalation_clause, t.retries,
         (select count(*)::int from ledger_entry l where l.ticket_id = t.id) as ledger_rows,
         (select count(*)::int from response r where r.ticket_id = t.id)    as drafts,
         (select r.grounded from response r where r.ticket_id = t.id
           order by r.created_at desc, r.id desc limit 1)                   as grounded
    from ticket t where t.id = any($1::uuid[])
   order by t.id`;

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function connectionOptions() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'postgres',
  };
}

async function reportCorpus(client) {
  const corpus = await client.query(CORPUS);
  if (corpus.rowCount === 0) {
    console.log('knowledge base: NO ORGANISATION HAS A SNAPSHOT IN FORCE — apply migrations and seed/orgs.sql');
    return;
  }
  for (const row of corpus.rows) {
    console.log(
      `knowledge base: ${String(row.name).padEnd(18)} snapshot ${row.kb_snapshot}  ${row.articles} article(s)`,
    );
  }
}

async function main() {
  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const tickets = dataset.tickets ?? [];
  if (tickets.length === 0) {
    console.error('demo_load: the dataset carries no tickets');
    process.exit(1);
  }

  const client = new pg.Client(connectionOptions());
  await client.connect();

  try {
    if (process.argv.includes('--status')) {
      const result = await client.query(STATUS, [tickets.map((ticket) => ticket.id)]);
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      for (const ticket of tickets) {
        const row = byId.get(ticket.id);
        const intended = ticket.intended?.reason ?? 'no escalation';
        const wanted = ticket.intended?.retrieval
          ? Object.keys(ticket.intended.retrieval).join(',')
          : 'no retrieval';
        if (!row) {
          console.log(`${ticket.beat}/${ticket.variant}  NOT LOADED           intended ${intended}`);
          continue;
        }
        const got = row.escalation_reason ?? '—';
        console.log(
          `${ticket.beat}/${ticket.variant}  ${row.status.padEnd(14)} reason ${String(got).padEnd(7)} ` +
            `intended ${String(intended).padEnd(13)} retrieval ${wanted.padEnd(12)} ` +
            `ledger ${row.ledger_rows} drafts ${row.drafts} grounded ${row.grounded ?? '—'}`,
        );
      }
      console.log('');
      await reportCorpus(client);
      return;
    }

    // The pointer first: a ticket loaded against an organisation with no snapshot in force is a
    // ticket whose first drafting cycle refuses to run, and the refusal names a migration rather
    // than the thing that is actually missing.
    let heads = 0;
    for (const orgId of new Set(tickets.map((ticket) => ticket.org_id))) {
      const written = await client.query(HEAD, [orgId, SNAPSHOT]);
      heads += written.rowCount ?? 0;
    }

    let loaded = 0;
    let reset = 0;
    for (const ticket of tickets) {
      const digest = sha256Hex(ticket.body);
      const updated = await client.query(RESET, [
        ticket.id,
        ticket.subject,
        ticket.body,
        ticket.language,
        ticket.dedupe_key,
        digest,
      ]);

      if (updated.rowCount === 1) {
        reset += 1;
        continue;
      }

      await client.query(INSERT, [
        ticket.id,
        ticket.org_id,
        ticket.account_id,
        ticket.customer_id,
        ticket.subject,
        ticket.body,
        ticket.language,
        ticket.dedupe_key,
        digest,
      ]);
      loaded += 1;
    }

    console.log(
      `demo dataset ready: ${loaded} inserted, ${reset} reset to NEW, ${heads} snapshot pointer(s) written`,
    );
    await reportCorpus(client);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('demo_load:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
