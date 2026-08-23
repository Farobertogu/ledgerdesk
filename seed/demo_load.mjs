#!/usr/bin/env node
// seed/demo_load.mjs — load or reset the frozen demonstration dataset, and rehearse against it.
//
// Usage:
//   node seed/demo_load.mjs                 load the dataset, resetting any ticket already there
//   node seed/demo_load.mjs --status        where each beat stands, and how much SLA margin is left
//   node seed/demo_load.mjs --material      the documents the gap beat admits, ready to paste
//   node seed/demo_load.mjs --rewind        move every pointer back to the seeded snapshot
//   node seed/demo_load.mjs --stage <label> point every pointer at a snapshot that already exists
//
// Connection comes from DATABASE_URL, or from the standard PG* environment.
//
// ## THE CLOCK RULE, and it is not a recommendation
//
// **Reload the dataset within twenty minutes of the first beat.** `created_at` is stamped at load
// time and the SLA clause is a fact about the clock: the shortest first-response policy a
// demonstration ticket can land on is thirty minutes, so a dataset loaded an hour before the
// audience arrives has already breached and the beat that was written to show a knowledge gap shows
// an SLA breach instead — correctly, and for a reason that has nothing to do with what is being
// demonstrated.
//
// **No test can catch this and none pretends to.** The dataset test freezes the instant to one
// minute after creation, which is the right thing for it to do and makes it structurally incapable
// of seeing an aged dataset. The defence is this procedure and the margin column in `--status`.
//
// ## A REHEARSAL SPENDS A VARIANT
//
// Said plainly because the first person to discover it will discover it on the day. An admission
// cannot be repeated: the advance refuses a snapshot that already exists and refuses an advance from
// a label to itself. A gap record cannot be reopened without deleting it, because its uniqueness is
// over (ticket, query, corpus) and the query is the same one. So each beat has two variants and a
// rehearsal spends one. A THIRD rehearsal needs new data, with its own row in the dataset and its
// own passage through the dataset test.
//
// `--rewind` puts the pointer back so the corpus in force is the seeded one again. It **deletes
// nothing**, and that is a prohibition rather than a limitation:
//
//   · articles and ledger rows cannot be deleted at all — a trigger refuses it, which is the whole
//     point of an append-only corpus and an append-only chain;
//   · gap records and admissions CAN be deleted by the owner, and must not be. The gap record is the
//     evidence that the system noticed it could not answer something, which is the requirement this
//     card exists to satisfy. A rehearsal that tidied it away would be deleting the proof in order
//     to re-stage the demonstration of it.
//
// What `--rewind` therefore buys is a corpus that answers the way it did before, over a record that
// still says everything that happened. The gap it left behind stays closed and stays visible.
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

/**
 * Where each beat stands, and how long it has left.
 *
 * `sla_due_at` is null until triage assigns a policy, so the margin before that is computed the
 * conservative way: the SHORTEST first-response policy the ticket's own account tier can land on. A
 * margin that assumed the most generous policy would report comfort a triage is about to remove.
 */
const STATUS = `
  select t.id, t.status, t.category, t.severity, t.sentiment, t.confidence, t.priority,
         t.escalation_reason, t.escalation_clause, t.retries, t.created_at, t.sla_due_at,
         coalesce(
           t.sla_due_at,
           t.created_at + make_interval(mins =>
             (select min(p.first_response_minutes) from sla_policy p where p.tier = a.tier))
         ) as effective_due_at,
         (select count(*)::int from ledger_entry l where l.ticket_id = t.id) as ledger_rows,
         (select count(*)::int from response r where r.ticket_id = t.id)    as drafts,
         (select count(*)::int from kb_gap g where g.ticket_id = t.id)      as gaps,
         (select g.state::text from kb_gap g where g.ticket_id = t.id
           order by g.created_at desc limit 1)                              as gap_state,
         (select r.grounded from response r where r.ticket_id = t.id
           order by r.created_at desc, r.id desc limit 1)                   as grounded
    from ticket t join account a on a.id = t.account_id
   where t.id = any($1::uuid[])
   order by t.id`;

const REWIND = `
  update kb_snapshot_head set kb_snapshot = $2, set_by = null, set_at = now()
   where org_id = $1::uuid
  returning org_id`;

const SNAPSHOT_EXISTS = `
  select count(*)::int as articles from kb_article
   where org_id = $1::uuid and kb_snapshot = $2`;

/** How much margin is left before a beat escalates on the clock instead of on its own subject. */
const ALARM_MINUTES = 15;

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

/**
 * The documents the gap beat admits, printed for the person who will paste them into the form.
 *
 * They are NOT applied here and there is no mode that applies them. The act is a supervisor filling
 * in a form and pressing a control under their own name — that is what ties the approver in the
 * record to a person — and a script that admitted material would produce a row signed by nobody,
 * which the advance refuses anyway because a component carries no subject.
 */
function reportMaterial(dataset) {
  const material = dataset.admissible_material ?? [];
  if (material.length === 0) {
    console.log('the dataset carries no admissible material');
    return;
  }
  for (const item of material) {
    console.log(`--- ${item.beat}/${item.variant} · ticket ${item.for_ticket}`);
    console.log(`canonical key : ${item.canonical_key}`);
    console.log(`title         : ${item.title}`);
    console.log(`citable       : ${item.citable ? 'yes' : 'no'}`);
    console.log(`source        : ${item.provenance.source}`);
    console.log(`obtained at   : ${item.provenance.obtained_at}`);
    console.log(`citability    : ${item.provenance.citability}`);
    console.log('body          :');
    console.log(item.body);
    console.log('');
  }
  console.log('Paste these into the admission form on the ticket screen. One document per rehearsal.');
}

/**
 * Puts every pointer back to the snapshot the seed wrote, and deletes nothing.
 *
 * See the prohibition at the top of this file. The corpus admitted during a rehearsal stays exactly
 * where it is — `kb_article` is append-only by trigger and this does not try — so what a rewind
 * restores is which corpus is IN FORCE, not which rows exist. A gap closed during the rehearsal
 * stays closed, its admission stays on the panel, and the chain still holds every row it held.
 */
async function rewind(client, tickets) {
  const orgs = [...new Set(tickets.map((ticket) => ticket.org_id))];
  for (const orgId of orgs) {
    const moved = await client.query(REWIND, [orgId, SNAPSHOT]);
    if (moved.rowCount === 0) {
      console.log(`rewind: ${orgId} has no snapshot pointer; run the loader first`);
      continue;
    }
    console.log(`rewind: ${orgId} → ${SNAPSHOT}`);
  }
  console.log('');
  console.log('Nothing was deleted. Gap records and admissions are the evidence of the cycle and stay.');
  await reportCorpus(client);
}

/**
 * Points every pointer at a snapshot that ALREADY EXISTS.
 *
 * This is the dry run: it moves the corpus in force without admitting anything, so the whole act can
 * be walked through against a chain that was already seeded — no new advance, no variant spent, no
 * gap record consumed. A label with no articles under it is refused rather than staged, because a
 * pointer at an empty corpus is a retrieval that finds nothing for a reason nobody would guess.
 */
async function stage(client, tickets, label) {
  const orgs = [...new Set(tickets.map((ticket) => ticket.org_id))];
  for (const orgId of orgs) {
    const found = await client.query(SNAPSHOT_EXISTS, [orgId, label]);
    const articles = found.rows[0]?.articles ?? 0;
    if (articles === 0) {
      console.log(`stage: ${orgId} holds no article under '${label}'; left where it was`);
      continue;
    }
    await client.query(REWIND, [orgId, label]);
    console.log(`stage: ${orgId} → ${label} (${articles} article(s))`);
  }
  console.log('');
  await reportCorpus(client);
}

async function main() {
  const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
  const tickets = dataset.tickets ?? [];
  if (tickets.length === 0) {
    console.error('demo_load: the dataset carries no tickets');
    process.exit(1);
  }

  // Before the connection, and deliberately: printing what a rehearsal will paste is a question
  // about a file, and a mode that demanded a database to answer it would be unusable on the way to
  // the room.
  if (process.argv.includes('--material')) {
    reportMaterial(dataset);
    return;
  }

  const client = new pg.Client(connectionOptions());
  await client.connect();

  try {
    if (process.argv.includes('--rewind')) {
      await rewind(client, tickets);
      return;
    }

    const stageAt = process.argv.indexOf('--stage');
    if (stageAt !== -1) {
      const label = process.argv[stageAt + 1];
      if (!label || label.startsWith('--')) {
        console.error('demo_load: --stage needs the label of a snapshot that already exists');
        process.exit(1);
      }
      await stage(client, tickets, label);
      return;
    }

    if (process.argv.includes('--status')) {
      const result = await client.query(STATUS, [tickets.map((ticket) => ticket.id)]);
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      const now = Date.now();
      let tightest = Infinity;

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
        const margin = Math.round((new Date(row.effective_due_at).getTime() - now) / 60_000);
        if (margin < tightest) tightest = margin;
        console.log(
          `${ticket.beat}/${ticket.variant}  ${row.status.padEnd(14)} reason ${String(got).padEnd(7)} ` +
            `intended ${String(intended).padEnd(13)} retrieval ${wanted.padEnd(12)} ` +
            `ledger ${row.ledger_rows} drafts ${row.drafts} grounded ${String(row.grounded ?? '—').padEnd(5)} ` +
            `gap ${String(row.gap_state ?? '—').padEnd(16)} margin ${String(margin).padStart(4)} min`,
        );
      }

      console.log('');
      // The one line that decides whether the rehearsal can start. No test can produce it: the
      // dataset test freezes the clock a minute after creation and is structurally unable to see an
      // aged dataset, so the margin is measured here or it is not measured at all.
      if (tightest === Infinity) {
        console.log('SLA margin: no ticket is loaded, so there is nothing to measure');
      } else if (tightest < 0) {
        console.log(
          `SLA margin: ALARM — the tightest beat is ${-tightest} min PAST its first response. ` +
            'Reload before starting: these tickets will escalate on the clock, not on their subject.',
        );
      } else if (tightest < ALARM_MINUTES) {
        console.log(
          `SLA margin: ALARM — ${tightest} min left on the tightest beat, below the ${ALARM_MINUTES} min floor. ` +
            'Reload the dataset before the first beat.',
        );
      } else {
        console.log(`SLA margin: ${tightest} min on the tightest beat (floor ${ALARM_MINUTES} min)`);
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
