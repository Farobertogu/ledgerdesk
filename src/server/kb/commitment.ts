/**
 * The commitment an organisation makes in advance about the gaps it has not met yet.
 *
 * ## The problem this exists to solve, stated before the solution
 *
 * A gap record carries two facts no machine knows: **who owns closing it** and **by when**. Both are
 * `not null`. And the instant they are needed is the worst possible one for asking anybody: the
 * record is emitted inside the server transaction that escalates the ticket, downstream of a
 * retrieval that found nothing, with no person in the loop and none available. `owner_id` also
 * carries a composite reference to a real user of the same organisation, so there is no placeholder
 * that would even be accepted.
 *
 * The three ways out were: type them into the admission form — which is a different moment, hours
 * later, and would leave the record unwritable in the meantime; read them per gap from a system
 * that tracks who work is assigned to — which this deployment has none of, and which the contract
 * does not ask for; or **have the organisation declare them in advance**. This is the third, and it
 * is the only one the schema as it stands accepts.
 *
 * ## What it is
 *
 * A typed, versioned artefact per organisation: the person who owns knowledge gaps there, the term
 * within which they are answered, and the sentence a human wrote saying so. It is authored, reviewed
 * and changed like any other artefact in this repository. **Nobody invents an owner at escalation
 * time: a person wrote one down beforehand**, and the record points back at what they wrote.
 *
 * ## Which side of the channel it sits on, which is not a detail
 *
 * The producer's. The published division of labour says the receiver **validates** `owner_id` and
 * `committed_date` and never supplies them, and the reason is the single-source rule: a field with
 * two origins is a field that can diverge, and a test that refused a record could not say which of
 * the two producers was wrong. So the commitment is read HERE, on the way into the channel, and the
 * receiver's job is exactly what the contract says it is — check that the owner resolves to a live
 * user of the same organisation, and refuse the record if it does not.
 *
 * **This is not a departure from the contract, and an earlier version of this comment wrongly said
 * it was.** The contract says the channel transports these two fields and that the receiver
 * validates rather than supplies them. It says nothing about where the producer gets them: no
 * upstream system is named in it anywhere. And it publishes the precedent for this exact shape one
 * row above, for a field whose origin is a human declaration made beforehand — `null_rule`, supplied
 * *from configuration, declared in advance*. This is that form, on the side the contract puts these
 * two fields on. What the requirement insists on is that nobody invents an owner at the instant of
 * failure; a declaration made in advance by a named person is the strongest way of not inventing
 * one, and the only one available at an instant when nothing can be asked.
 *
 * ## What it is not
 *
 * Not a table. On a deployment target this becomes one, owned by whoever administers the tenant, and
 * this module becomes its reader. It is a file today for the reason the seeded identities are fixed:
 * the demonstration runs against two organisations whose identifiers the seed fixes, and an artefact
 * nobody can point at is an artefact nobody reviewed.
 *
 * ## If the instantiation is decided differently, THIS FILE is what moves
 *
 * Three instantiations were considered and ADR-026 §1 records why the other two are not executable
 * against the schema as it stands. Should either be taken instead, the change is bounded to this
 * module and to the producer half of `gapChannelRecordFor` in `gap.ts` — the receiver, the channel,
 * the published document and the writer are all indifferent to where the commitment came from,
 * because the receiver's job is to VALIDATE it either way. That is the whole reason the artefact
 * sits on the producer's side: it keeps the decision cheap to revisit.
 */

// Relative specifiers where the rest of this layer uses the `@/` alias, and the exception is
// deliberate. The alias is resolved by the bundler; this module is also read directly by the check
// that measures the declared commitments against the database, which runs with no bundler at all.
// For that to work EVERY import here has to be relative, which is why both are — the moment one is
// not, the artefact stops being checkable against the people it names.
import { GAP_CHANNEL_BYTES, byteLength } from '../../alg/gap_channel.ts';
import { AppError } from '../errors.ts';

export type GapCommitment = {
  /** The artefact and its generation, as the record points back at it. */
  ref: string;
  org_id: string;
  /** The user who owns closing a gap here. Checked against the database by the receiver. */
  owner_id: string;
  /**
   * Who decided that.
   *
   * **The artefact had no author, and that is the first question anybody asks of it.** An owner
   * assigned by a document nobody signed is an owner assigned by nobody — which is the exact failure
   * the commitment exists to avoid, moved one level up. So the declaration names the person who made
   * it, and the test resolves that person against the database exactly as it resolves the owner.
   */
  declared_by: string;
  /** When it was declared. A commitment with no date is one nobody can say has been reviewed. */
  declared_on: string;
  /** How long after the gap is opened the answer is committed for, in days. */
  term_days: number;
  /** The sentence a person wrote. It travels as the record's one piece of open content. */
  statement: string;
};

/**
 * The declared commitments.
 *
 * Both name a **supervisor** where the organisation seeds one and its agent where it does not, and
 * that is the honest reading rather than a convenience: the owner is whoever answers for the gap
 * being closed, and Corella Health seeds no supervisor. An organisation with neither would have no
 * commitment here and its gap emission would refuse — loudly, naming the organisation — which is the
 * correct outcome and better than a record naming somebody who never agreed to anything.
 *
 * **Which is also why the owner is not inferred from the role.** "Whoever is the supervisor" reads
 * like the obvious rule and produces no owner at all for one of the two organisations seeded here,
 * silently, at the moment a retrieval fails. A named person is a named person.
 */
export const GAP_COMMITMENTS: readonly GapCommitment[] = [
  {
    ref: 'northwind-knowledge-gap-commitment@1',
    org_id: '11111111-1111-4111-8111-111111111111',
    owner_id: '1a000000-0000-4000-8000-000000000003',
    declared_by: '1a000000-0000-4000-8000-000000000003',
    declared_on: '2026-08-24',
    term_days: 5,
    statement:
      'Knowledge gaps raised against Northwind Freight are owned by the support supervisor and answered within five days of being opened.',
  },
  {
    ref: 'corella-knowledge-gap-commitment@1',
    org_id: '22222222-2222-4222-8222-222222222222',
    owner_id: '2b000000-0000-4000-8000-000000000002',
    declared_by: '2b000000-0000-4000-8000-000000000002',
    declared_on: '2026-08-24',
    term_days: 3,
    statement:
      'Knowledge gaps raised against Corella Health are owned by the duty agent and answered within three days of being opened.',
  },
];

/**
 * The commitment in force for one organisation, or a refusal naming it.
 *
 * **Typed, and it was not always.** An organisation with no commitment is a deployment that was not
 * finished, not a request that did something wrong — and an untyped throw makes those two
 * indistinguishable where it matters most. The emission runs inside a savepoint and files the code
 * it was refused with beside the escalation, so a bare `Error` arrives in the chain as
 * `E_INTERNAL`: whoever reads it is told the system broke, when what happened is that nobody
 * declared who owns gaps here. The code says which, and the message says where to fix it.
 */
export function gapCommitmentFor(orgId: string): GapCommitment {
  const found = GAP_COMMITMENTS.find((entry) => entry.org_id === orgId);
  if (!found) {
    throw new AppError(
      'E_GAP_COMMITMENT_MISSING',
      500,
      `no knowledge-gap commitment is declared for organisation ${orgId}, so no gap record for it ` +
        'could name an owner or a date. Declare one in src/server/kb/commitment.ts.',
      { org_id: orgId },
    );
  }
  return found;
}

/**
 * The date a gap opened now is committed for.
 *
 * Calendar days and not working days, declared rather than assumed: working days need a calendar of
 * public holidays per jurisdiction, which is a table this system does not have and would get wrong
 * quietly. The term is short enough that the difference is a day either way, and the number is the
 * organisation's own to set.
 *
 * Computed in UTC from the instant the cycle is evaluated at — the same instant the rule was
 * evaluated at, never a second reading of the clock — so that a record and the decision beside it
 * cannot land on two different days.
 */
export function committedDateFrom(now: number, termDays: number): string {
  const due = new Date(now + termDays * 24 * 60 * 60 * 1000);
  const iso = due.toISOString();
  return iso.slice(0, 10);
}

/**
 * Whether an artefact is fit to be put on the channel at all.
 *
 * Checked here rather than only at the receiver because a commitment that cannot produce a valid
 * record is an authoring mistake, and an authoring mistake should fail where it was made. The
 * statement is measured in bytes against the channel's cap for its one open field, which is the
 * unit that cap is written in.
 */
export function commitmentViolations(commitment: GapCommitment): string[] {
  const problems: string[] = [];
  if (commitment.term_days <= 0) {
    problems.push(`${commitment.ref}: a term of ${commitment.term_days} days commits to nothing`);
  }
  if (byteLength(commitment.statement) > GAP_CHANNEL_BYTES.note) {
    problems.push(
      `${commitment.ref}: the statement is ${byteLength(commitment.statement)} bytes and the channel caps its open content at ${GAP_CHANNEL_BYTES.note}`,
    );
  }
  if (byteLength(commitment.ref) === 0 || commitment.statement.trim() === '') {
    problems.push(`${commitment.ref}: a commitment with no words is not one`);
  }
  if (!ISO_DAY.test(commitment.declared_on)) {
    problems.push(`${commitment.ref}: '${commitment.declared_on}' is not a day a person declared it on`);
  }
  if (!UUID.test(commitment.owner_id) || !UUID.test(commitment.declared_by)) {
    problems.push(`${commitment.ref}: an owner and a declarer are identities, not names`);
  }
  return problems;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Today, in the zone every date in this cycle is computed and stored in. */
export function todayUtc(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
