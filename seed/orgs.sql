-- seed/orgs.sql · two organisations with fixed identifiers.
--
-- Two organisations are seeded on purpose: tenant isolation is only demonstrable when there is
-- a second tenant whose rows the first must not see. Every identifier here is fixed so the
-- ordering of any replay is byte-reproducible.

insert into org (id, name, tier_default) values
  ('11111111-1111-4111-8111-111111111111', 'Northwind Freight', 'standard'),
  ('22222222-2222-4222-8222-222222222222', 'Corella Health',    'premium');

insert into app_user (id, org_id, role, locale) values
  ('1a000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'customer',   'en-AU'),
  ('1a000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'agent',      'en-AU'),
  ('1a000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'supervisor', 'en-AU'),
  ('2b000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'customer',   'en-AU'),
  ('2b000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'agent',      'en-AU');

insert into account (id, org_id, tier, value_band) values
  ('1acc0000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'standard', 3),
  ('2acc0000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'premium',  5);

insert into sla_policy (id, tier, severity, first_response_minutes, resolution_minutes) values
  -- The four corner rows complete the declared demo policy family (minutes halve as severity
  -- rises), so a triage that assigns severity 1 or 4 always finds its policy row.
  ('5a1a0000-0000-4000-8000-000000000005', 'standard', 1, 480, 5760),
  ('5a1a0000-0000-4000-8000-000000000006', 'standard', 4,  60,  720),
  ('5a1a0000-0000-4000-8000-000000000007', 'premium',  1, 120, 1440),
  ('5a1a0000-0000-4000-8000-000000000008', 'premium',  4,  15,  180),
  ('5a1a0000-0000-4000-8000-000000000001', 'standard', 2, 240, 2880),
  ('5a1a0000-0000-4000-8000-000000000002', 'standard', 3, 120, 1440),
  ('5a1a0000-0000-4000-8000-000000000003', 'premium',  2,  60,  720),
  ('5a1a0000-0000-4000-8000-000000000004', 'premium',  3,  30,  360);

insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, channel, language,
                    created_at, status, sla_policy_id, sla_due_at, dedupe_key) values
  ('aaaa0001-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   '1acc0000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001',
   'Duplicate charge on invoice INV-10021',
   'My card was billed A$49.00 twice for the same invoice on 3 March.',
   'web', 'en', timestamptz '2026-08-18 09:00:00+10', 'NEW',
   '5a1a0000-0000-4000-8000-000000000001', timestamptz '2026-08-18 13:00:00+10', 'nf-inv-10021'),
  ('aaaa0002-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
   '1acc0000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000001',
   'Exports timing out since this morning',
   'Nightly exports have been timing out since about 06:00.',
   'web', 'en', timestamptz '2026-08-18 10:30:00+10', 'NEW',
   '5a1a0000-0000-4000-8000-000000000002', timestamptz '2026-08-18 12:30:00+10', 'nf-export-timeout'),
  ('bbbb0001-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
   '2acc0000-0000-4000-8000-000000000001', '2b000000-0000-4000-8000-000000000001',
   'Locked out after password reset',
   'I reset my password this morning and the new one is rejected on the sign-in page.',
   'web', 'en', timestamptz '2026-08-18 08:15:00+10', 'NEW',
   '5a1a0000-0000-4000-8000-000000000003', timestamptz '2026-08-18 09:15:00+10', 'ch-locked-out'),
  ('bbbb0002-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222',
   '2acc0000-0000-4000-8000-000000000001', '2b000000-0000-4000-8000-000000000001',
   'Refund request for the unused term',
   'We cancelled on 2 March and would like the unused portion of the term refunded.',
   'web', 'en', timestamptz '2026-08-18 11:00:00+10', 'NEW',
   '5a1a0000-0000-4000-8000-000000000004', timestamptz '2026-08-18 11:30:00+10', 'ch-refund-term');

-- one draft per organisation: without them the tenant isolation of the write path has nothing
-- to be demonstrated against
insert into response (id, ticket_id, draft) values
  ('4e500001-0000-4000-8000-000000000001', 'aaaa0001-0000-4000-8000-000000000001',
   'Thank you for reporting the duplicate charge. We are checking the invoice now.'),
  ('4e500002-0000-4000-8000-000000000001', 'bbbb0001-0000-4000-8000-000000000001',
   'Thank you for reporting the sign-in problem. We are looking at your account now.');

-- The knowledge base, and the snapshot each organisation reads it under.
--
-- **Every beat that must NOT escalate needs an article of its own, in its OWN organisation.** That
-- is the sentence this block exists for. The demonstration does not break because of what the
-- drafting increment adds, it breaks because of what that increment turns on: a retrieval that
-- returns nothing escalates a ticket on a knowledge gap, correctly, and the beat written to show a
-- calm question being answered would have shown an escalation instead — against a corpus that held
-- one article about billing and nothing about the subject the ticket actually raises.
--
-- **Nothing here contains a value the redactor would remove.** No address, no card, no run of
-- digits long enough to look like an account. An article with a redactable literal in it is a mine
-- under the one agent whose whole job is to quote it: the excerpt would arrive at the model with a
-- marker where a fact used to be, and the reply would be grounded in `[REDACTED:id]`.
-- `test_KB_seeded_articles_survive_redaction` reads the articles back out of the database and puts
-- every one of them through the redactor, which is where that claim is measured rather than
-- promised.
insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable, created_at) values
  ('c0de0001-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'kb-2026-08-01',
   'billing/duplicate-charge', 'Duplicate charges',
   'A duplicate charge is refunded to the original payment method within five business days of confirmation.',
   encode(sha256(convert_to('A duplicate charge is refunded to the original payment method within five business days of confirmation.', 'UTF8')), 'hex'),
   true, timestamptz '2026-08-01 00:00:00+10'),
  ('c0de0003-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'kb-2026-08-01',
   'exports/destinations', 'Adding an export destination',
   'A plan covers a fixed number of export destinations. Adding a further destination for a second team is a plan change and it alters the monthly total, which we confirm in writing before it takes effect.',
   encode(sha256(convert_to('A plan covers a fixed number of export destinations. Adding a further destination for a second team is a plan change and it alters the monthly total, which we confirm in writing before it takes effect.', 'UTF8')), 'hex'),
   true, timestamptz '2026-08-01 00:00:00+10'),
  ('c0de0004-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'kb-2026-08-01',
   'exports/schedule', 'Moving the nightly export window',
   'The nightly export window can be moved by an account owner from the scheduling screen. Moving it later avoids an overlap with a batch that starts at midnight, and the new time applies from the following night.',
   encode(sha256(convert_to('The nightly export window can be moved by an account owner from the scheduling screen. Moving it later avoids an overlap with a batch that starts at midnight, and the new time applies from the following night.', 'UTF8')), 'hex'),
   true, timestamptz '2026-08-01 00:00:00+10'),
  ('c0de0002-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'kb-2026-08-01',
   'access/password-reset', 'Password reset',
   'A password reset link expires after thirty minutes; requesting a second link invalidates the first.',
   encode(sha256(convert_to('A password reset link expires after thirty minutes; requesting a second link invalidates the first.', 'UTF8')), 'hex'),
   true, timestamptz '2026-08-01 00:00:00+10');

-- The snapshot in force, per organisation, as a pointer rather than a derivation.
--
-- Written here and not only in 0009 because the two paths into a database are different: the
-- migration backfills organisations that already exist, and this covers the clean install, where
-- the organisations are created a few lines above and the migration ran before any of them did.
insert into kb_snapshot_head (org_id, kb_snapshot) values
  ('11111111-1111-4111-8111-111111111111', 'kb-2026-08-01'),
  ('22222222-2222-4222-8222-222222222222', 'kb-2026-08-01')
  on conflict (org_id) do nothing;
