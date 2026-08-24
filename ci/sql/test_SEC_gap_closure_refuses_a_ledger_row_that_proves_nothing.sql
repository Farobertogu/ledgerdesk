-- test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing
--
-- The four clauses of the closure requirement, as four refusals of the database rather than four
-- sentences in a record.
--
-- A gap closes when the original query, re-run against the snapshot in force, comes back **grounded
-- on the admitted source**. Four things have to be true, and each one is a way of closing a gap that
-- looks right and is not:
--
--   1. the answer is ANCHORED — `grounded` is true, and not merely present;
--   2. it belongs to the same organisation as the gap;
--   3. it was produced under the snapshot IN FORCE;
--   4. it cites material admitted against THIS gap, BY CANONICAL KEY.
--
-- **The witness is read from the answer and never taken from the caller**, which is what the name of
-- this file is about. A closure that accepted a row number would accept any row number: a caller
-- could name a checkpoint written last week and the gap would close carrying a witness that proves
-- nothing about it. Reading it out of the answer's own validation row makes the witness the
-- answer's.
--
-- **And neither is the canonical key.** The function takes a gap and an answer and nothing else: the
-- key comes out of the admission's own article. A key supplied by the caller would let anybody
-- holding EXECUTE close a gap "on the admitted source" by naming whatever the answer happened to
-- cite — a pre-existing article, for instance — which is the caller being believed instead of
-- refused. The last two refusals below are what measure that.
--
-- **And the fourth is by key because identity does not survive an advance.** An advance mints a new
-- identity for every row it copies, so the article that answers the gap afterwards is a different
-- row from anything that existed when the gap was opened. The key is copied verbatim and its shape
-- is constrained; the identity is not comparable across the advance at all.

do $$
declare
  v_org_a     uuid := '11111111-1111-4111-8111-111111111111';
  v_org_b     uuid := '22222222-2222-4222-8222-222222222222';
  v_super_a   uuid := '1a000000-0000-4000-8000-000000000003';
  v_acct_a    uuid := '1acc0000-0000-4000-8000-000000000001';
  v_cust_a    uuid := '1a000000-0000-4000-8000-000000000001';
  v_acct_b    uuid := '2acc0000-0000-4000-8000-000000000001';
  v_cust_b    uuid := '2b000000-0000-4000-8000-000000000001';
  v_ticket_a  uuid := '0c0e0011-0000-4000-8000-00000000000a';
  v_ticket_b  uuid := '0c0e0011-0000-4000-8000-00000000000b';
  v_gap       uuid := '9a000011-0000-4000-8000-00000000000a';
  v_gap_bare  uuid := '9a000011-0000-4000-8000-00000000000b';
  v_from      text := 'kb-2026-08-01';
  v_to        text := 'kb-2026-11-01';
  v_admitted  text := 'ops/admitted-key';
  v_other     text := 'ops/other-key';
  v_art_ok    uuid := 'c0de0011-0000-4000-8000-00000000000a';
  v_art_other uuid := 'c0de0011-0000-4000-8000-00000000000b';
  v_row       bigint;
  v_r_unanchored uuid := '4e500011-0000-4000-8000-000000000001';
  v_r_nowitness  uuid := '4e500011-0000-4000-8000-000000000002';
  v_r_foreign    uuid := '4e500011-0000-4000-8000-000000000003';
  v_r_oldsnap    uuid := '4e500011-0000-4000-8000-000000000004';
  v_r_wrongkey   uuid := '4e500011-0000-4000-8000-000000000005';
  v_r_good       uuid := '4e500011-0000-4000-8000-000000000006';
  v_state     text;
  v_witness   bigint;
begin
  -- --- fixtures ---------------------------------------------------------------------------------
  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key)
  values (v_ticket_a, v_org_a, v_acct_a, v_cust_a, 'closure fixture', 'a body', 'sqltest-closure-a'),
         (v_ticket_b, v_org_b, v_acct_b, v_cust_b, 'closure fixture', 'a body', 'sqltest-closure-b')
  on conflict (id) do nothing;

  -- A row for the references to point at. It carries NO ticket, deliberately: the chain is
  -- append-only for the owner too, so a row naming one of these tickets would make the ticket
  -- undeletable and this file would have to leave its fixtures behind for ever.
  insert into ledger_entry (run_id, seq, org_id, agent, state_hash, toolchain, restarts,
                            tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
                            class, output, ts, prev_hash, row_hash)
  values ('0d000011-0000-4000-8000-00000000000a', 1, v_org_a, 'system', repeat('a', 64),
          '{"app":"test"}'::jsonb, 0, 0, 0, 0, 0, 0, 'checkpoint',
          jsonb_build_object('seq_covered', 1, 'head_row_hash', repeat('b', 64), 'k', 50),
          now(), 'GENESIS', repeat('3', 64))
  returning id into v_row;

  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, owner_id, committed_date, null_rule)
  values (v_gap, v_org_a, v_ticket_a, 'who may reprint a consignment label', v_from, true,
          repeat('c', 64), repeat('d', 64), v_super_a, current_date + 5, 'a declared rule');

  -- A second gap on the same ticket with NOTHING admitted against it. It exists so that "the answer
  -- cites an admitted document" and "the answer cites a document admitted against THIS gap" are two
  -- different questions with two different answers.
  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, owner_id, committed_date, null_rule)
  values (v_gap_bare, v_org_a, v_ticket_a, 'a different unanswered question', v_from, true,
          repeat('7', 64), repeat('8', 64), v_super_a, current_date + 5, 'a declared rule');

  -- The corpus after the admission: the admitted document and one other, both under the incoming
  -- snapshot. The second one exists so that "the answer cites something" and "the answer cites the
  -- admitted thing" are two different questions with two different answers.
  insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
  values (v_art_ok, v_org_a, v_to, v_admitted, 'The admitted document',
          'A consignment label is reprinted by a supervisor once the lorry has left.',
          encode(sha256(convert_to('A consignment label is reprinted by a supervisor once the lorry has left.', 'UTF8')), 'hex'),
          true),
         (v_art_other, v_org_a, v_to, v_other, 'Something else entirely',
          'An unrelated article that happens to clear the relevance floor.',
          encode(sha256(convert_to('An unrelated article that happens to clear the relevance floor.', 'UTF8')), 'hex'),
          true);

  -- The corpus in force moves to where the admission put it. Leg 3 is an equality against this
  -- pointer — "the current snapshot", in the requirement's own words — so a fixture that left the
  -- pointer behind would be exercising a world the closure never runs in.
  update kb_snapshot_head set kb_snapshot = v_to, set_by = null where org_id = v_org_a;

  insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                            content_hash, provenance, ledger_ref, article_id)
  values ('ad000011-0000-4000-8000-00000000000a', v_org_a, v_gap, v_super_a, v_from, v_to,
          encode(sha256(convert_to('A consignment label is reprinted by a supervisor once the lorry has left.', 'UTF8')), 'hex'),
          '{"source":"handbook"}'::jsonb, v_row, v_art_ok);

  insert into response (id, ticket_id, draft, kb_snapshot, grounded, validate_ledger_ref) values
    (v_r_unanchored, v_ticket_a, 'a reply nobody stands behind', v_to,   false, v_row),
    (v_r_nowitness,  v_ticket_a, 'a reply with no validation',  v_to,   true,  null),
    (v_r_foreign,    v_ticket_b, 'another tenant''s reply',     v_to,   true,  v_row),
    (v_r_oldsnap,    v_ticket_a, 'a reply from before',         v_from, true,  v_row),
    (v_r_wrongkey,   v_ticket_a, 'a reply citing the wrong thing', v_to, true, v_row),
    (v_r_good,       v_ticket_a, 'the reply that earns it',     v_to,   true,  v_row);

  insert into response_citation (response_id, kb_article_id, kb_snapshot) values
    (v_r_wrongkey, v_art_other, v_to),
    (v_r_good,     v_art_ok,    v_to);

  -- --- 0 · the CALLER, which this file used not to have at all -------------------------------------
  --
  -- Every case below used to run as the owner with no claims, so the whole file measured what the
  -- function decides and none of it measured **who is allowed to decide**. The closure is
  -- `security definer`, so RLS does not apply inside it: a session that cannot see a gap could still
  -- close it, and no case here would have noticed. The claims are set once for the legitimate caller
  -- and case 0·bis is the one that attacks from outside.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_a, 'role', 'supervisor', 'sub', v_super_a)::text, true);

  -- --- 0·bis · a caller of ANOTHER organisation ----------------------------------------------------
  --
  -- The gap, the answer, the admission and the corpus are all in order — everything the function
  -- decides on would pass. What is wrong is the session, and the refusal has to be the one that says
  -- NOTHING: "no such gap", indistinguishable from a gap that does not exist. A distinct code here
  -- would confirm to a foreign tenant that this gap is real, which is the leak the application
  -- surface already refuses to produce.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_b, 'role', 'supervisor', 'sub', v_super_a)::text, true);
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_good);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a session of another organisation closed this gap, so the closure undoes the policy that hides it';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_SIN_HUECO%' then raise; end if;
  end;

  if (select state::text from kb_gap where id = v_gap) <> 'OPEN' then
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: the refused foreign closure moved the gap anyway';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_a, 'role', 'supervisor', 'sub', v_super_a)::text, true);

  -- --- 1 · an answer that is not anchored ---------------------------------------------------------
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_unanchored);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a gap closed on an answer that is not grounded';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_SIN_ANCLAJE%' then raise; end if;
  end;

  -- --- 2 · an anchored answer with no row of the chain behind the verdict --------------------------
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_nowitness);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a gap closed with no witness at all';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_SIN_TESTIGO%' then raise; end if;
  end;

  -- --- 3 · another organisation's answer ----------------------------------------------------------
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_foreign);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a gap closed on another organisation''s answer';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_ORG_AJENA%' then raise; end if;
  end;

  -- --- 4 · an answer produced under a corpus that is no longer in force ---------------------------
  --     "Later" is not a question a snapshot label can answer: the labels are text, and ordering
  --     them alphabetically is an accident that happens to agree with time. The requirement says
  --     *the current snapshot*, and "current" is an equality against the pointer.
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_oldsnap);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a gap closed on an answer from a corpus that is not in force';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_SNAPSHOT_NO_VIGENTE%' then raise; end if;
  end;

  -- --- 5 · an anchored answer that cites something else -------------------------------------------
  --     The case the whole design turns on. This answer is grounded, it is this organisation's, it
  --     was produced under the right corpus, and it stands on a document nobody admitted. A closure
  --     conditioned on "the re-run found something" would accept it, and would be demonstrating
  --     anchoring by accident — the one failure nobody watching could tell from success.
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_wrongkey);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a gap closed on an answer that cites the wrong document';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_SIN_CITA_ADMITIDA%' then raise; end if;
  end;

  -- The other direction, and the one a caller-supplied key used to leave open. The SAME answer:
  -- anchored, in force, citing a document that really was admitted — against a DIFFERENT gap. The
  -- key is derived from THIS gap's own admission, and this gap has none, so there is nothing for the
  -- citation to match and no argument a caller can make about it.
  begin
    perform kb_gap_close_by_verification(v_gap_bare, v_r_good);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a gap with nothing admitted against it closed on another gap''s admission';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_SIN_CITA_ADMITIDA%' then raise; end if;
  end;

  -- --- 6 · the closure that is earned, with both witnesses left behind -----------------------------
  perform kb_gap_close_by_verification(v_gap, v_r_good);

  select state::text, closing_ledger_ref into v_state, v_witness from kb_gap where id = v_gap;
  if v_state <> 'CLOSED' then
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: the verified closure left the gap %', v_state;
  end if;
  if v_witness is distinct from v_row then
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: the closing witness is % and the answer was validated by %', v_witness, v_row;
  end if;
  if not exists (select 1 from kb_gap where id = v_gap and closed_by_check_at is not null) then
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a closed gap carries no verification instant';
  end if;

  -- --- 7 · and a gap that is already closed is not closed again ------------------------------------
  begin
    perform kb_gap_close_by_verification(v_gap, v_r_good);
    raise exception 'test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing: a closed gap was closed a second time';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_CIERRE_HUECO_NO_ABIERTO%' then raise; end if;
  end;

  -- The claims go with the cases that needed them, so nothing after this file inherits a session.
  perform set_config('request.jwt.claims', '', true);

  -- --- the fixtures this test owns ----------------------------------------------------------------
  delete from response_citation where response_id in (v_r_wrongkey, v_r_good);
  delete from response where id in (v_r_unanchored, v_r_nowitness, v_r_foreign, v_r_oldsnap,
                                    v_r_wrongkey, v_r_good);
  delete from kb_admission where id = 'ad000011-0000-4000-8000-00000000000a';
  delete from kb_gap where id in (v_gap, v_gap_bare);
  -- The pointer goes back where the rest of the suite expects it. The copied rows stay: kb_article
  -- is append-only and this test is not exempt from that.
  update kb_snapshot_head set kb_snapshot = v_from, set_by = null where org_id = v_org_a;
  delete from ticket where id in (v_ticket_a, v_ticket_b);
end $$;
