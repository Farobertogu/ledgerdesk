-- test_SEC_snapshot_advance_refuses_a_foreign_organisation
--
-- The hole this function was re-signed to close, measured as the refusals that close it.
--
-- The original advance takes the organisation and both snapshots as arguments and runs
-- `security definer`. Anything holding EXECUTE — which, by the default `create function` applies, was
-- everything — could therefore write articles into another tenant's corpus and move that tenant's
-- pointer, with no approver, no admission and no row in any chain. Nothing about the call would look
-- unusual, and nothing downstream would notice.
--
-- The re-signed one takes a row of the chain and nothing else. The organisation and both snapshots
-- come out of that row, so there is nothing left for a caller to be wrong about; and two ties are
-- checked in the body:
--
--   · the session's organisation must be the row's, so a caller cannot name somebody else's corpus;
--   · `auth.uid()` must be the approver the row declares — **whoever approves is whoever executes**.
--
-- The second tie is the one that puts a person in the loop by construction rather than by rule. The
-- machine actor carries an organisation and a role and NO subject, so there is no session it can
-- present that satisfies it. That is asserted below as its own case, because "a component cannot do
-- this" is a claim worth measuring rather than reasoning about.
--
-- **And a third tie, which is to the corpus rather than to a person.** The outgoing label the row
-- carries must be the corpus in force at the moment the corpus moves, on a LOCKED pointer. Two
-- admissions decided in the same window otherwise read one head, mint two successors and both
-- advance — the second overwriting the first, and the first's document falling out of force with
-- every record of it still saying it was admitted. Case 11 measures the refusal and, more to the
-- point, that the first admission is still the one in force afterwards.

do $$
declare
  v_org_a      uuid := '11111111-1111-4111-8111-111111111111';
  v_org_b      uuid := '22222222-2222-4222-8222-222222222222';
  v_agent_a    uuid := '1a000000-0000-4000-8000-000000000002';
  v_super_a    uuid := '1a000000-0000-4000-8000-000000000003';
  v_account    uuid := '1acc0000-0000-4000-8000-000000000001';
  v_customer   uuid := '1a000000-0000-4000-8000-000000000001';
  v_ticket     uuid := '0c0e0010-0000-4000-8000-00000000000a';
  v_gap        uuid := '9a000010-0000-4000-8000-00000000000a';
  v_from       text := 'kb-2026-08-01';
  v_to         text := 'kb-2026-10-01';
  v_body       text := 'A consignment label is reprinted by a supervisor once the lorry has left.';
  v_hash       text;
  v_admitted   jsonb;
  v_row        bigint;
  v_wrong_row  bigint;
  v_late_row   bigint;
  v_late_gap   uuid := '9a000010-0000-4000-8000-00000000000b';
  -- A destination label OWNED BY THIS CASE, and the qualifier is not decoration. The first version
  -- reached for `kb-2026-11-01`, which reads like a free label and is not:
  -- `test_SEC_gap_closure_refuses_a_ledger_row_that_proves_nothing` stands articles under it for this
  -- same organisation and runs earlier in the list, so case 11 met `E_KB_SNAPSHOT_ALREADY_EXISTS` —
  -- correctly, and from the check it was written to prove could not answer. A label nobody else can
  -- reach for is what makes the case measure the refusal it names.
  v_late       text := 'kb-2026-12-01-advance-race';
  v_head       text;
  v_article    uuid;
  v_count      int;
begin
  -- The pointer this file starts from, asserted instead of assumed.
  --
  -- Case 9 advances OUT OF `v_from`, and since the advance began comparing the outgoing label
  -- against the pointer it is about to move, that case now DEPENDS on the pointer being there — a
  -- coupling it did not have before. Two files earlier in this battery move this organisation's
  -- pointer and put it back; the day one of them stops, the failure belongs here, naming the file
  -- that owes a restore, rather than in case 9 under a message about a corpus having moved.
  select kb_snapshot into v_head from kb_snapshot_head where org_id = v_org_a;
  if v_head is distinct from v_from then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: this file starts from pointer %, not %; a file earlier in the battery moved it and did not put it back',
      coalesce(v_head, '<no pointer at all>'), v_from;
  end if;

  v_hash := encode(sha256(convert_to(v_body, 'UTF8')), 'hex');
  v_admitted := jsonb_build_array(jsonb_build_object(
    'canonical_key', 'ops/consignment-label-reprint',
    'title', 'Reprinting a consignment label',
    'body', v_body,
    'citable', true));

  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key)
  values (v_ticket, v_org_a, v_account, v_customer,
          'advance fixture', 'a body', 'sqltest-advance')
  on conflict (id) do nothing;

  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, owner_id, committed_date, null_rule)
  values (v_gap, v_org_a, v_ticket, 'who may reprint a consignment label', v_from, true,
          repeat('a', 64), repeat('b', 64), v_super_a, current_date + 5, 'a declared rule')
  on conflict (id) do nothing;

  -- The row of the chain the advance derives everything from. Its own run, so the chain it opens
  -- cannot collide with anything else this suite writes.
  insert into ledger_entry (run_id, seq, org_id, ticket_id, agent, state_hash, toolchain, restarts,
                            tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
                            class, output, ts, prev_hash, row_hash)
  values ('0d000010-0000-4000-8000-00000000000a', 1, v_org_a, v_ticket, 'system', repeat('a', 64),
          '{"app":"test"}'::jsonb, 0, 0, 0, 0, 0, 0, 'kb_admission',
          jsonb_build_object(
            'admission_id', 'ad000010-0000-4000-8000-00000000000a',
            'gap_id', v_gap,
            'approved_by', v_super_a,
            'snapshot_from', v_from,
            'snapshot_to', v_to,
            'content_hash', v_hash,
            'provenance_source', 'operations handbook',
            'provenance', jsonb_build_object('source', 'operations handbook',
                                             'obtained_at', '2026-08-24',
                                             'citability', 'cleared')),
          now(), 'GENESIS', repeat('1', 64))
  returning id into v_row;

  -- A row of another class, for the case where the identity names something that is not an admission.
  insert into ledger_entry (run_id, seq, org_id, ticket_id, agent, state_hash, toolchain, restarts,
                            tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
                            class, output, ts, prev_hash, row_hash)
  values ('0d000010-0000-4000-8000-00000000000b', 1, v_org_a, v_ticket, 'system', repeat('a', 64),
          '{"app":"test"}'::jsonb, 0, 0, 0, 0, 0, 0, 'checkpoint',
          jsonb_build_object('seq_covered', 1, 'head_row_hash', repeat('b', 64), 'k', 50),
          now(), 'GENESIS', repeat('2', 64))
  returning id into v_wrong_row;

  -- 1 · A session of another organisation cannot advance this one's corpus. This is the demonstrated
  --     hole, closed.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_b, 'role', 'supervisor', 'sub', v_super_a)::text, true);
  begin
    perform * from kb_snapshot_advance(v_row, v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: another organisation advanced this corpus';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADVANCE_FOREIGN_ORG%' then raise; end if;
  end;

  -- 2 · The right organisation, the wrong person. Whoever approves is whoever executes.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_a, 'role', 'agent', 'sub', v_agent_a)::text, true);
  begin
    perform * from kb_snapshot_advance(v_row, v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: somebody other than the approver executed the admission';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADVANCE_CALLER_NOT_APPROVER%' then raise; end if;
  end;

  -- 3 · The machine actor: an organisation, a role, and no subject. It fails the tie by
  --     construction — there is no session it can present that satisfies it.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_a, 'role', 'agent')::text, true);
  begin
    perform * from kb_snapshot_advance(v_row, v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: a session with no subject admitted material';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADVANCE_CALLER_NOT_APPROVER%' then raise; end if;
  end;

  -- From here on the session is the approver's own.
  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_a, 'role', 'supervisor', 'sub', v_super_a)::text, true);

  -- 4 · An identity that names a row of another class is not an admission.
  begin
    perform * from kb_snapshot_advance(v_wrong_row, v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: a checkpoint row was accepted as an admission';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADVANCE_LEDGER_ROW_MISSING%' then raise; end if;
  end;

  -- 5 · Citability has no default. The original advance treated an absent flag as "yes", which is
  --     the wrong direction for a value deciding whether a document may be quoted to a customer.
  begin
    perform * from kb_snapshot_advance(v_row, jsonb_build_array(jsonb_build_object(
      'canonical_key', 'ops/consignment-label-reprint',
      'title', 'Reprinting a consignment label',
      'body', v_body)));
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: a document with no citability decision was admitted';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADMISSION_CITABLE_MISSING%' then raise; end if;
  end;

  -- 6 · The declared hash has to be the hash of the body that is actually inserted. Without this the
  --     row the demonstration exhibits could declare one digest and store another.
  begin
    perform * from kb_snapshot_advance(v_row, jsonb_build_array(jsonb_build_object(
      'canonical_key', 'ops/consignment-label-reprint',
      'title', 'Reprinting a consignment label',
      'body', v_body || ' And one more sentence nobody declared.',
      'citable', true)));
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: a body was admitted under a hash of a different body';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADMISSION_HASH_MISMATCH%' then raise; end if;
  end;

  -- 7 · A body that does not fit whole into one excerpt is refused rather than trimmed.
  begin
    perform * from kb_snapshot_advance(v_row, jsonb_build_array(jsonb_build_object(
      'canonical_key', 'ops/consignment-label-reprint',
      'title', 'Reprinting a consignment label',
      'body', repeat('a consignment label ', 200),
      'citable', true)));
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: a body longer than an excerpt was admitted';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADMISSION_EXCEEDS_EXCERPT%' then raise; end if;
  end;

  -- 8 · One body per admission: the admission names a single article and a list would have to pick
  --     one of its own elements to put in that column.
  begin
    perform * from kb_snapshot_advance(v_row, v_admitted || v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: two documents were admitted under one admission';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_ADMISSION_NOT_EXACTLY_ONE%' then raise; end if;
  end;

  -- 9 · And the legitimate one goes through, which is what shows the door is still open.
  select count(*) into v_count from kb_article where org_id = v_org_a and kb_snapshot = v_from;

  select article_id into v_article from kb_snapshot_advance(v_row, v_admitted);
  if v_article is null then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the advance minted no article';
  end if;

  if (select count(*) from kb_article where org_id = v_org_a and kb_snapshot = v_to) <> v_count + 1 then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the incoming snapshot is not the outgoing one plus the admitted document';
  end if;

  select kb_snapshot into v_head from kb_snapshot_head where org_id = v_org_a;
  if v_head <> v_to then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the pointer is % after the advance', v_head;
  end if;

  -- The admission row is written by the advance, from the chain row, so the two cannot disagree.
  if not exists (
       select 1 from kb_admission m
        where m.id = 'ad000010-0000-4000-8000-00000000000a'
          and m.org_id = v_org_a
          and m.gap_id = v_gap
          and m.approved_by = v_super_a
          and m.snapshot_from = v_from
          and m.snapshot_to = v_to
          and m.content_hash = v_hash
          and m.ledger_ref = v_row
          and m.article_id = v_article) then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the admission row does not match the chain row it was derived from';
  end if;

  -- 10 · And the same admission cannot be performed twice: the incoming snapshot now exists.
  begin
    perform * from kb_snapshot_advance(v_row, v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: an advance into an existing snapshot was accepted';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_SNAPSHOT_ALREADY_EXISTS%' then raise; end if;
  end;

  -- 11 · The lost update: a second admission decided under the SAME corpus, refused rather than
  --      allowed to strand the first one's document.
  --
  -- This is the shape the console produces the moment two gaps are worked at once, which ADR-026 §8
  -- says has to be possible in either order. Both admissions read one head and mint two DIFFERENT
  -- successors — so neither trips `E_KB_SNAPSHOT_ALREADY_EXISTS`, which only sees a label that already
  -- exists. Before the pointer was locked and compared, both advanced: the second overwrote the
  -- first, and the document the first admitted stopped being in force while every record of it — the
  -- chain row, the admission row, the approver — went on saying it had been admitted. Nothing was
  -- destroyed and nothing turned red; the gap the first was raised for simply never closed again,
  -- because the closure asks the corpus IN FORCE for the admitted key.
  --
  -- It is measured serially, and that is not a weaker version of the race: the property is that the
  -- outgoing label must be the corpus in force AT THE MOMENT THE CORPUS MOVES, and after case 9 it
  -- is not. `for update` is what turns the same check into a serialisation under real concurrency,
  -- and a lock cannot be asserted from one session.
  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, owner_id, committed_date, null_rule)
  values (v_late_gap, v_org_a, v_ticket, 'who signs off a pallet weight override', v_from, true,
          repeat('c', 64), repeat('d', 64), v_super_a, current_date + 5, 'a declared rule')
  on conflict (id) do nothing;

  insert into ledger_entry (run_id, seq, org_id, ticket_id, agent, state_hash, toolchain, restarts,
                            tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
                            class, output, ts, prev_hash, row_hash)
  values ('0d000010-0000-4000-8000-00000000000c', 1, v_org_a, v_ticket, 'system', repeat('a', 64),
          '{"app":"test"}'::jsonb, 0, 0, 0, 0, 0, 0, 'kb_admission',
          jsonb_build_object(
            'admission_id', 'ad000010-0000-4000-8000-00000000000b',
            'gap_id', v_late_gap,
            'approved_by', v_super_a,
            -- The head this admission was decided under, which case 9 has since moved.
            'snapshot_from', v_from,
            -- A successor of its own, so the label-already-exists refusal cannot be what answers.
            'snapshot_to', v_late,
            'content_hash', v_hash,
            'provenance_source', 'operations handbook',
            'provenance', jsonb_build_object('source', 'operations handbook',
                                             'obtained_at', '2026-08-24',
                                             'citability', 'cleared')),
          now(), 'GENESIS', repeat('3', 64))
  returning id into v_late_row;

  perform set_config('request.jwt.claims',
    json_build_object('org_id', v_org_a, 'role', 'supervisor', 'sub', v_super_a)::text, true);
  begin
    perform * from kb_snapshot_advance(v_late_row, v_admitted);
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: an admission decided under a corpus that had already moved advanced anyway, stranding the document admitted before it';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_SNAPSHOT_MOVED%' then raise; end if;
  end;

  -- And the half that matters more than the refusal: the FIRST admission is still the one in force.
  select kb_snapshot into v_head from kb_snapshot_head where org_id = v_org_a;
  if v_head <> v_to then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the refused admission moved the pointer to % anyway', v_head;
  end if;
  if exists (select 1 from kb_article where org_id = v_org_a and kb_snapshot = v_late) then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the refused admission wrote its corpus before being refused';
  end if;
  if exists (select 1 from kb_admission where id = 'ad000010-0000-4000-8000-00000000000b') then
    raise exception 'test_SEC_snapshot_advance_refuses_a_foreign_organisation: the refused admission left an admission row';
  end if;

  -- Put the corpus back where the rest of the suite expects it. The copied rows stay: kb_article is
  -- append-only and this test is not exempt from that.
  update kb_snapshot_head set kb_snapshot = v_from, set_by = null where org_id = v_org_a;

  -- The fixtures this test owns. The chain rows cannot be deleted and are not: they are two rows in
  -- two runs of their own, which is what letting them stay costs.
  delete from kb_admission where id = 'ad000010-0000-4000-8000-00000000000a';
  delete from kb_gap where id in (v_gap, v_late_gap);

  perform set_config('request.jwt.claims', '', true);
end $$;
