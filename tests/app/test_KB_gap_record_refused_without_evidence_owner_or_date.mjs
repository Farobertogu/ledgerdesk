// test_KB_gap_record_refused_without_evidence_owner_or_date
//
// The other half of the requirement: a record missing evidence, owner or date **is rejected by the
// writer**. Not by a column, and the distinction is the whole reason this file exists.
//
// Four of those columns are already `not null`, so a caller that omitted one would get `23502` — a
// code that names a column and not a rule, from inside a transaction, with nothing in it about what
// the caller was supposed to have done. The requirement asks for the writer to refuse, so the writer
// refuses by name, and the constraints stay where they are as the second line they always were.
//
// **The blank test is why "present" means something.** A null rule of three spaces satisfies
// `not null` and declares nothing at all, which is exactly the record the requirement is written to
// prevent: one that looks complete and commits to nothing.
//
// **And the cases below carry whitespace that is not a SPACE for a reason.** The first version of
// that guard used `btrim`, whose default trim set is the space character alone — so a tab or a
// newline walked through it, and a record whose entire query evidence was a line break was written
// and accepted. `not null` was satisfied, the guard was satisfied, and the evidence said nothing.
// These cases are what found it, and they are here so that nothing can quietly put it back.
//
// Every call goes through `app_rw` under real claims, because that is the only role the application
// ever has and the function is reachable to it through EXECUTE and to nothing else. A test that
// called as the owner would be measuring a path no request can take.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  asOwner,
  asTenant,
  cleanup,
  fileBeatTicket,
  identities,
  sessionFor,
  snapshotHead,
  waitForServer,
} from './harness.mjs';

const hex64 = (c) => c.repeat(64);

/** This file admits nothing; it needs a ticket, and a question nothing was ever admitted for. */
const BEAT = 'consignment-label-reprint';

let people;
let ticketId;
let head;

/** The complete call, from which each case removes exactly one thing. */
function completeArguments(overrides = {}) {
  return {
    gap: randomUUID(),
    org: people.northwindAgent.org_id,
    ticket: ticketId,
    terms: 'who may reprint a consignment label',
    snapshot: head,
    zero_match: true,
    digest: hex64('a'),
    // The second identity: the question with the corpus left out. The writer takes both, and a call
    // that named only the first stopped resolving to any function at all the day it did.
    question: hex64('b'),
    owner: people.northwindSupervisor.user_id,
    committed: '2099-01-01',
    null_rule: 'a rule declared before the null',
    ...overrides,
  };
}

async function open(claims, args) {
  return asTenant(claims, async (client) => {
    try {
      await client.query(
        `select kb_gap_open($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::boolean, $7, $8, $9::uuid,
                            $10::date, $11, null, null)`,
        [
          args.gap,
          args.org,
          args.ticket,
          args.terms,
          args.snapshot,
          args.zero_match,
          args.digest,
          args.question,
          args.owner,
          args.committed,
          args.null_rule,
        ],
      );
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: String(error.message ?? error) };
    }
  });
}

function claimsOf(person, role) {
  return { org_id: person.org_id, role, sub: person.user_id };
}

before(async () => {
  await waitForServer();
  people = await identities();

  const customer = await sessionFor(people.northwindCustomer.user_id);
  const filed = await fileBeatTicket(customer, BEAT, 'refuse');
  ticketId = filed.ticketId;
  head = await snapshotHead(people.northwindAgent.org_id);
});

after(cleanup);

describe('test_KB_gap_record_refused_without_evidence_owner_or_date', () => {
  const agentClaims = () => claimsOf(people.northwindAgent, 'agent');

  it('refuses a record with no query evidence, naming the rule and not the column', async () => {
    for (const [what, overrides] of [
      ['no terms at all', { terms: '' }],
      // Whitespace that is not a SPACE, which is the case that caught a real hole: the guard used
      // `btrim`, whose default trim set is the space character alone, so a newline satisfied it and
      // a record whose entire query evidence was a line break was written.
      ['terms that are only whitespace', { terms: '   \n  ' }],
      ['terms that are a single tab', { terms: '\t' }],
      ['a snapshot that is only a newline', { snapshot: '\n' }],
      ['no snapshot', { snapshot: '   ' }],
      ['no statement about what was found', { zero_match: null }],
      ['a digest that is not a digest', { digest: 'not-a-sha256' }],
      ['no identity for the question itself', { question: null }],
      ['a question digest that is not a digest', { question: 'not-a-sha256' }],
    ]) {
      const result = await open(agentClaims(), completeArguments(overrides));
      assert.equal(result.ok, false, `a record with ${what} was accepted`);
      assert.match(
        result.message,
        /E_KB_HUECO_SIN_EVIDENCIA/,
        `a record with ${what} was refused by something other than the writer: ${result.message}`,
      );
    }
  });

  it('refuses a record with no owner and one with no date', async () => {
    const noOwner = await open(agentClaims(), completeArguments({ owner: null }));
    assert.equal(noOwner.ok, false, 'a record with no owner was accepted');
    assert.match(noOwner.message, /E_KB_HUECO_SIN_DUENO/, noOwner.message);

    const noDate = await open(agentClaims(), completeArguments({ committed: null }));
    assert.equal(noDate.ok, false, 'a record with no committed date was accepted');
    assert.match(noDate.message, /E_KB_HUECO_SIN_FECHA/, noDate.message);
  });

  it('refuses a record whose rule for the null is blank', async () => {
    // Spaces, and then whitespace that is not a space — the second is what caught the guard using a
    // trim whose default set is the space character alone.
    for (const blank of ['  ', '\t', '\n', ' \r\n ']) {
      const result = await open(agentClaims(), completeArguments({ null_rule: blank }));
      assert.equal(
        result.ok,
        false,
        `a record declaring nothing about the null was accepted (${JSON.stringify(blank)})`,
      );
      assert.match(result.message, /E_KB_HUECO_SIN_REGLA_DE_NULO/, result.message);
    }
  });

  it('refuses an owner from another organisation', async () => {
    // The composite foreign key is what makes this unrepresentable rather than merely wrong, and it
    // is the case nothing would ever query for: a row that is valid, auditable, signed and names a
    // person who works somewhere else.
    const result = await open(
      agentClaims(),
      completeArguments({ owner: people.corellaAgent.user_id }),
    );
    assert.equal(result.ok, false, 'a gap took an owner from another organisation');
    assert.match(result.message, /foreign key|fk_gap_owner_same_org/i, result.message);
  });

  it('refuses to write into an organisation the session does not hold', async () => {
    // `security definer` runs the body with the owner's privileges, so a function that took an
    // organisation on trust would let any holder of EXECUTE write into any tenant. This is the check
    // that the organisation comes from the session rather than from the argument.
    const result = await open(
      { org_id: people.corellaAgent.org_id, role: 'agent', sub: people.corellaAgent.user_id },
      completeArguments(),
    );
    assert.equal(result.ok, false, 'a session wrote a record into another organisation');
    assert.match(result.message, /E_KB_HUECO_ORG_AJENA/, result.message);
  });

  it('accepts the complete record, so the refusals above are not a broken table', async () => {
    const args = completeArguments({ digest: hex64('b') });
    const result = await open(agentClaims(), args);
    assert.equal(result.ok, true, `the complete record was refused: ${result.message}`);

    // `asTenant` rolls back, so nothing is left behind — and that is also what makes the acceptance
    // measurable without spending the ticket's one record per query.
    const written = await asOwner(async (client) => {
      const found = await client.query('select count(*)::int as n from kb_gap where id = $1', [
        args.gap,
      ]);
      return found.rows[0].n;
    });
    assert.equal(written, 0, 'the accepted record survived a rolled-back transaction');
  });
});
