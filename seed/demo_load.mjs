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
// **created_at is stamped here and not in the file.** The SLA clause is a fact about the clock: a
// dataset with fixed timestamps escalates on SLA before any model is asked, the moment it is a day
// old, and the beat that was meant to show triage shows a breach instead.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATASET = path.join(ROOT, 'seed', 'demo_tickets.json');

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

const STATUS = `
  select id, status, category, severity, sentiment, confidence, priority,
         escalation_reason, escalation_clause, retries,
         (select count(*)::int from ledger_entry l where l.ticket_id = ticket.id) as ledger_rows
    from ticket where id = any($1::uuid[])
   order by id`;

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
        if (!row) {
          console.log(`${ticket.beat}/${ticket.variant}  NOT LOADED           intended ${intended}`);
          continue;
        }
        const got = row.escalation_reason ?? '—';
        console.log(
          `${ticket.beat}/${ticket.variant}  ${row.status.padEnd(14)} reason ${String(got).padEnd(7)} ` +
            `intended ${String(intended).padEnd(13)} ledger rows ${row.ledger_rows}`,
        );
      }
      return;
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

    console.log(`demo dataset ready: ${loaded} inserted, ${reset} reset to NEW`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('demo_load:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
