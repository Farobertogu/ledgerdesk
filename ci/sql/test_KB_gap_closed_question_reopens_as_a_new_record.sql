-- test_KB_gap_closed_question_reopens_as_a_new_record
--
-- What "at most one standing record per question" actually means, and what it deliberately does not.
--
-- The requirement counts **escalations**: *every `GROUND` escalation has exactly one gap record*.
-- The upper half of that is held by a PARTIAL unique index — unique over `(ticket_id,
-- question_sha256)` **where the record is not closed** — and the word `partial` is the whole design:
--
--   · while a record stands, the same question re-asked reuses it, however many times the corpus
--     moves underneath and however many different query digests that produces;
--   · once a record is CLOSED by verification, the question is **finished**, not banned. If it fails
--     again the system opens a new episode, with its own evidence, its own owner and its own date.
--
-- A closure that also forbade the question for ever would be a system that answered a question once
-- and then had no way to say that the answer stopped being enough. That is the opposite of what
-- closure by verification is for.
--
-- The last section is the **declared residual**, asserted rather than hidden: when the same question
-- fails again under the SAME corpus and nothing is standing, the writer returns the closed record,
-- because 0009's `unique (ticket_id, query_sha256)` — untouched, and not this migration's to change
-- — says that pair is one row. It is honest and it is visible; a supervisor following the link from
-- a live escalation lands on a record marked CLOSED. It is asserted here so that it cannot change
-- into something else without somebody deciding to.

do $$
declare
  v_org      uuid := '11111111-1111-4111-8111-111111111111';
  v_super    uuid := '1a000000-0000-4000-8000-000000000003';
  v_account  uuid := '1acc0000-0000-4000-8000-000000000001';
  v_customer uuid := '1a000000-0000-4000-8000-000000000001';
  v_ticket   uuid := '0c0e0012-0000-4000-8000-00000000000a';
  v_other    uuid := '0c0e0012-0000-4000-8000-00000000000b';
  v_question text := repeat('a', 64);   -- one question, asked under two corpora
  v_query_s1 text := repeat('1', 64);   -- ... its digest under the first
  v_query_s2 text := repeat('2', 64);   -- ... and under the second
  v_row      bigint;
  v_first    uuid;
  v_second   uuid;
  v_again    uuid;
  v_closed   uuid;
  v_standing int;
  v_total    int;
begin
  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key)
  values (v_ticket, v_org, v_account, v_customer, 'reopen fixture', 'a body', 'sqltest-reopen-a'),
         (v_other,  v_org, v_account, v_customer, 'reopen fixture', 'a body', 'sqltest-reopen-b');

  -- A row for the closure's witness to point at. No ticket on it, so these fixtures stay deletable.
  insert into ledger_entry (run_id, seq, org_id, agent, state_hash, toolchain, restarts,
                            tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
                            class, output, ts, prev_hash, row_hash)
  values ('0d000012-0000-4000-8000-00000000000a', 1, v_org, 'system', repeat('a', 64),
          '{"app":"test"}'::jsonb, 0, 0, 0, 0, 0, 0, 'checkpoint',
          jsonb_build_object('seq_covered', 1, 'head_row_hash', repeat('b', 64), 'k', 50),
          now(), 'GENESIS', repeat('4', 64))
  returning id into v_row;

  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org, 'role', 'agent', 'sub', v_super)::text, true);

  -- --- the first episode, opened and then closed --------------------------------------------------
  v_first := kb_gap_open(gen_random_uuid(), v_org, v_ticket, 'who may reprint a consignment label',
                         'kb-2026-08-01', true, v_query_s1, v_question, v_super,
                         current_date + 5, 'a declared rule');
  if v_first is null then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the first record was not written';
  end if;

  -- While it stands, the same question under a DIFFERENT corpus reuses it. This is the half that
  -- keeps one escalation from becoming a pile of records for one unanswered question.
  v_again := kb_gap_open(gen_random_uuid(), v_org, v_ticket, 'who may reprint a consignment label',
                         'kb-2026-09-01', true, v_query_s2, v_question, v_super,
                         current_date + 5, 'a declared rule');
  if v_again is distinct from v_first then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the same question under a moved corpus opened a second standing record (% then %)', v_first, v_again;
  end if;

  perform kb_gap_close_by_check(v_first, v_row);
  if (select state from kb_gap where id = v_first) <> 'CLOSED' then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the fixture did not close';
  end if;

  -- --- and the same question, failing again under a corpus that has moved --------------------------
  v_second := kb_gap_open(gen_random_uuid(), v_org, v_ticket, 'who may reprint a consignment label',
                          'kb-2026-09-01', true, v_query_s2, v_question, v_super,
                          current_date + 5, 'a declared rule');

  if v_second is null or v_second = v_first then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: a verified closure left the question unable to be raised again';
  end if;

  select count(*) into v_total from kb_gap where ticket_id = v_ticket;
  select count(*) into v_standing from kb_gap where ticket_id = v_ticket and state <> 'CLOSED';
  if v_total <> 2 then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the ticket holds % records and the episodes are two', v_total;
  end if;
  if v_standing <> 1 then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: % records are standing at once for one question', v_standing;
  end if;

  -- And the new episode is idempotent in its own right.
  v_again := kb_gap_open(gen_random_uuid(), v_org, v_ticket, 'who may reprint a consignment label',
                         'kb-2026-09-01', true, v_query_s2, v_question, v_super,
                         current_date + 5, 'a declared rule');
  if v_again is distinct from v_second then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the standing record was not reused';
  end if;

  -- --- the declared residual, asserted so that it cannot drift ------------------------------------
  -- Same question, same corpus, nothing standing: the frozen uniqueness of 0009 says that pair is
  -- one row, so the writer returns the closed one.
  v_closed := kb_gap_open(gen_random_uuid(), v_org, v_other, 'who may reprint a consignment label',
                          'kb-2026-08-01', true, repeat('3', 64), repeat('b', 64), v_super,
                          current_date + 5, 'a declared rule');
  perform kb_gap_close_by_check(v_closed, v_row);

  v_again := kb_gap_open(gen_random_uuid(), v_org, v_other, 'who may reprint a consignment label',
                         'kb-2026-08-01', true, repeat('3', 64), repeat('b', 64), v_super,
                         current_date + 5, 'a declared rule');
  if v_again is distinct from v_closed then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the residual changed — the same question under the same corpus no longer returns the closed record';
  end if;
  if (select state from kb_gap where id = v_again) <> 'CLOSED' then
    raise exception 'test_KB_gap_closed_question_reopens_as_a_new_record: the residual is not what it says it is';
  end if;

  -- --- the fixtures this test owns ----------------------------------------------------------------
  perform set_config('request.jwt.claims', '', true);
  delete from kb_gap where ticket_id in (v_ticket, v_other);
  delete from ticket where id in (v_ticket, v_other);
end $$;
