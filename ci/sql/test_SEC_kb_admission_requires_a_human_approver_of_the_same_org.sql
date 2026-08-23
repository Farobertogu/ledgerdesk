-- test_SEC_kb_admission_requires_a_human_approver_of_the_same_org
--
-- The guarantees 0009 puts around letting material INTO a knowledge base, measured as refusals.
--
-- The one that matters most is the quietest. `kb_admission.approved_by` references `app_user(id)`
-- and says nothing about which organisation that user belongs to — so a staff member of one tenant
-- could be recorded as the human who approved material into another tenant's corpus. The row would
-- be valid, auditable, signed, and wrong, and nothing would ever query for it because the join it
-- fails is one nobody writes. With `unique (id, org_id)` on `app_user` and a composite reference,
-- it stops being a rule a writer applies and becomes a row shape the database will not accept.
--
-- Five refusals and one acceptance. The acceptance is not decoration: a set of constraints that
-- refuses everything is indistinguishable from a broken table, and the legitimate admission is what
-- shows the door is still open for the case it was built for.
--
-- Everything runs as the owner, which row-level security does not apply to. That is deliberate: the
-- question is what the SCHEMA refuses, and a policy filtering rows away first would make a refused
-- write look identical to an invisible one.

do $$
declare
  v_org_a     uuid := '11111111-1111-4111-8111-111111111111';
  v_org_b     uuid := '22222222-2222-4222-8222-222222222222';
  v_staff_a   uuid := '1a000000-0000-4000-8000-000000000002';  -- an agent of Northwind
  v_staff_b   uuid := '2b000000-0000-4000-8000-000000000002';  -- an agent of Corella
  v_ticket    uuid := '0c0e0009-0000-4000-8000-00000000000a';
  v_account   uuid := '1acc0000-0000-4000-8000-000000000001';
  v_customer  uuid := '1a000000-0000-4000-8000-000000000001';
  v_gap       uuid := '9a000009-0000-4000-8000-00000000000a';
  v_admission uuid := 'ad000009-0000-4000-8000-00000000000a';
  v_ledger    bigint;
  v_state     text;
  v_reason    text;
begin
  -- --- fixtures ------------------------------------------------------------------------------
  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key)
  values (v_ticket, v_org_a, v_account, v_customer,
          'admission fixture', 'a body', 'sqltest-kb-admission')
  on conflict (id) do nothing;

  -- A ledger row for the references to point at. It is a non-model row, so every cost is zero and
  -- the agent is the system's own identity, exactly as the class contract requires.
  insert into ledger_entry (run_id, seq, org_id, agent, state_hash, toolchain, restarts,
                            tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
                            class, output, ts, prev_hash, row_hash)
  values ('0d000009-0000-4000-8000-00000000000a', 1, v_org_a, 'system', repeat('a', 64),
          '{"app":"test"}'::jsonb, 0, 0, 0, 0, 0, 0, 'checkpoint',
          jsonb_build_object('seq_covered', 1, 'head_row_hash', repeat('b', 64), 'k', 50),
          now(), 'GENESIS', repeat('c', 64))
  returning id into v_ledger;

  -- 1 · The gap's owner must belong to the gap's organisation.
  begin
    insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                        question_sha256, owner_id, committed_date, null_rule)
    values (v_gap, v_org_a, v_ticket, 'a query', 'kb-2026-08-01', true, repeat('d', 64),
            repeat('e', 64), v_staff_b, current_date, 'a declared rule');
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a gap took an owner from another organisation';
  exception when foreign_key_violation then null;
  end;

  -- The same gap with an owner of its own organisation is accepted.
  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, owner_id, committed_date, null_rule)
  values (v_gap, v_org_a, v_ticket, 'a query', 'kb-2026-08-01', true, repeat('d', 64),
          repeat('e', 64), v_staff_a, current_date, 'a declared rule');

  -- 2 · Exactly one gap record per (ticket, query). The retry of a failed emission is idempotent
  --     by mechanism rather than by the writer remembering to look first.
  begin
    insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                        question_sha256, owner_id, committed_date, null_rule)
    values ('9a000009-0000-4000-8000-00000000000b', v_org_a, v_ticket, 'a query', 'kb-2026-08-01',
            true, repeat('d', 64), repeat('f', 64), v_staff_a, current_date, 'a declared rule');
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a second gap for the same query was accepted';
  exception when unique_violation then null;
  end;

  -- 3 · The approver of an admission must belong to the admitting organisation.
  begin
    insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                              content_hash, provenance, ledger_ref)
    values (v_admission, v_org_a, v_gap, v_staff_b, 'kb-2026-08-01', 'kb-2026-08-22',
            repeat('e', 64), '{"source":"handbook"}'::jsonb, v_ledger);
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: an approver from another organisation was accepted';
  exception when foreign_key_violation then null;
  end;

  -- 4 · There is no automatic path: the approver column is NOT NULL, so an admission with no human
  --     behind it cannot be written at all.
  begin
    insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                              content_hash, provenance, ledger_ref)
    values (v_admission, v_org_a, v_gap, null, 'kb-2026-08-01', 'kb-2026-08-22',
            repeat('e', 64), '{"source":"handbook"}'::jsonb, v_ledger);
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: an admission with no approver was accepted';
  exception when not_null_violation then null;
  end;

  -- 5 · An admission that changes nothing is not an admission.
  begin
    insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                              content_hash, provenance, ledger_ref)
    values (v_admission, v_org_a, v_gap, v_staff_a, 'kb-2026-08-01', 'kb-2026-08-01',
            repeat('e', 64), '{"source":"handbook"}'::jsonb, v_ledger);
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: an admission from a snapshot to itself was accepted';
  exception when check_violation then null;
  end;

  -- 6 · And the legitimate one goes through.
  insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                            content_hash, provenance, ledger_ref)
  values (v_admission, v_org_a, v_gap, v_staff_a, 'kb-2026-08-01', 'kb-2026-08-22',
          repeat('e', 64), '{"source":"handbook"}'::jsonb, v_ledger);

  -- --- the gap's two closures, which were one reachable state and one unreachable one -----------

  -- 7 · The guard refuses a state change that does not carry the marker only kb_gap_close_by_check
  --     sets. That is the first of the two things standing between a gap and a false closure.
  begin
    update kb_gap set state = 'CLOSED' where id = v_gap;
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a gap changed state with no marker set';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_GAP_CIERRE_NO_VERIFICADO%' then raise; end if;
  end;

  -- 7b · And the second: a CLOSED row without its witnesses is refused by the check, even for a
  --      caller that has satisfied the guard. The marker is a session setting and a session setting
  --      is something its own session can set — so the guard alone was never the whole defence, and
  --      the two together are what make a hand-written closure impossible to complete.
  --
  --      The privilege check below is the third leg and the load-bearing one.
  begin
    perform set_config('ledgerdesk.kb_gap_close', v_gap::text, true);
    update kb_gap set state = 'CLOSED' where id = v_gap;
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a CLOSED gap was written without the witnesses that prove it';
  exception when check_violation then null;
  end;
  perform set_config('ledgerdesk.kb_gap_close', '', true);

  -- 7c · The function does it properly, and leaves both witnesses behind.
  perform kb_gap_close_by_check(v_gap, v_ledger);
  select state into v_state from kb_gap where id = v_gap;
  if v_state <> 'CLOSED' then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: the verified closure left the gap %', v_state;
  end if;
  if not exists (select 1 from kb_gap
                  where id = v_gap and closed_by_check_at is not null and closing_ledger_ref = v_ledger) then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a closed gap carries no witness';
  end if;

  -- Put it back OPEN for the NOT_DOCUMENTABLE case below. Only the owner can do this, which is the
  -- point of the privilege assertion at the bottom of this file.
  perform set_config('ledgerdesk.kb_gap_close', v_gap::text, true);
  update kb_gap set state = 'OPEN', closed_by_check_at = null, closing_ledger_ref = null where id = v_gap;
  perform set_config('ledgerdesk.kb_gap_close', '', true);

  -- 8 · NOT_DOCUMENTABLE was a value the enum offered and nothing on earth could write. It has a
  --     writer now, and the writer insists on a reason.
  begin
    perform kb_gap_mark_not_documentable(v_gap, '   ');
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a gap was marked not documentable with no reason';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_GAP_SIN_MOTIVO%' then raise; end if;
  end;

  perform kb_gap_mark_not_documentable(v_gap, 'no admissible source states a retention period');
  select state, not_documentable_reason into v_state, v_reason from kb_gap where id = v_gap;
  if v_state <> 'NOT_DOCUMENTABLE' or v_reason is null then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: the gap is % with reason %', v_state, v_reason;
  end if;

  -- --- the corpus itself ------------------------------------------------------------------------

  -- 9 · A snapshot is a promise that the bodies under it do not move.
  begin
    update kb_article set body = 'something else' where kb_snapshot = 'kb-2026-08-01';
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a knowledge-base article was edited in place';
  exception when raise_exception then
    if sqlerrm not like '%E_LEDGER_APPEND_ONLY%' then raise; end if;
  end;

  begin
    delete from kb_article where kb_snapshot = 'kb-2026-08-01';
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: a knowledge-base article was deleted';
  exception when raise_exception then
    if sqlerrm not like '%E_LEDGER_APPEND_ONLY%' then raise; end if;
  end;

  -- 10 · A citation names an article UNDER A SNAPSHOT, and citing one under a snapshot it does not
  --      exist in is not a mistake somebody has to check for. It cannot be written down.
  declare
    v_response uuid := '4e500009-0000-4000-8000-00000000000a';
    v_article  uuid;
  begin
    insert into response (id, ticket_id, draft) values (v_response, v_ticket, 'a draft');
    select id into v_article from kb_article where kb_snapshot = 'kb-2026-08-01' limit 1;

    begin
      insert into response_citation (response_id, kb_article_id, kb_snapshot)
      values (v_response, v_article, 'kb-2026-08-22');
      raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: an article was cited under a snapshot it does not exist in';
    exception when foreign_key_violation then null;
    end;

    insert into response_citation (response_id, kb_article_id, kb_snapshot)
    values (v_response, v_article, 'kb-2026-08-01');

    delete from response_citation where response_id = v_response;
    delete from response where id = v_response;
  end;

  -- --- clean up the fixtures this test owns -----------------------------------------------------
  delete from kb_admission where id = v_admission;
  delete from kb_gap where id = v_gap;
  delete from ticket where id = v_ticket;
end $$;

-- The leg that actually holds the gap record shut, asserted as the grant it is.
--
-- The guard reads a session marker, and a session marker is something a session can set for itself.
-- `security definer` on `kb_gap_close_by_check` does not change that — it changes whose privileges
-- the update runs under, and pins the search_path the body resolves through — so the sentence "no
-- application path can close a gap by hand" rests on something else entirely: **the application role
-- holds no UPDATE on the table at all**, so there is no hand for it to be closed by.
--
-- The closure is reachable through the function and through nothing else, which is the pattern
-- ADR-020 and ADR-021 established for every writer that has to hold an invariant a table cannot
-- state. This is where that stops being an intention.
do $$
begin
  if has_table_privilege('app_rw', 'kb_gap', 'update') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw can update kb_gap, so a gap can be closed by hand after all';
  end if;
  if has_table_privilege('app_rw', 'kb_gap', 'insert') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw can insert into kb_gap, so a gap record has a second producer';
  end if;
  if has_table_privilege('app_rw', 'kb_gap', 'delete') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw can delete a gap record';
  end if;
  if not has_table_privilege('app_rw', 'kb_gap', 'select') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw cannot read kb_gap, so the panel cannot show a closed gap beside its ticket';
  end if;

  -- The corpus is readable and not writable, for the same division of labour.
  if not has_table_privilege('app_rw', 'kb_article', 'select') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw cannot read the knowledge base';
  end if;
  if has_table_privilege('app_rw', 'kb_article', 'insert') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw can write the knowledge base';
  end if;

  -- And the answer is insertable and NOT updatable: editing, approving and sending arrive with the
  -- agent console's own migration, and a grant handed over early is a grant nobody notices is
  -- unused until something uses it.
  if not has_table_privilege('app_rw', 'response', 'insert') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw cannot write an answer';
  end if;
  if has_table_privilege('app_rw', 'response', 'update') then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: app_rw can update a response, which is a later increment''s grant';
  end if;
end $$;

-- The two ticket-state triggers, exercised on their own so a failure names which guard broke.
do $$
declare
  v_org      uuid := '11111111-1111-4111-8111-111111111111';
  v_account  uuid := '1acc0000-0000-4000-8000-000000000001';
  v_customer uuid := '1a000000-0000-4000-8000-000000000001';
  v_ticket   uuid := '0c0e0009-0000-4000-8000-00000000000b';
  v_response uuid := '4e500009-0000-4000-8000-00000000000b';
  v_staff    uuid := '1a000000-0000-4000-8000-000000000002';
begin
  insert into ticket (id, org_id, account_id, customer_id, subject, body_raw, dedupe_key)
  values (v_ticket, v_org, v_account, v_customer, 'state guard fixture', 'a body', 'sqltest-state-guards');

  -- AWAITING_AGENT means a grounded answer exists. Without one it is not reachable.
  begin
    update ticket set status = 'AWAITING_AGENT' where id = v_ticket;
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: AWAITING_AGENT with no response at all';
  exception when raise_exception then
    if sqlerrm not like '%E_TICKET_ESPERA_SIN_ANCLAJE%' then raise; end if;
  end;

  insert into response (id, ticket_id, draft, kb_snapshot, grounded)
  values (v_response, v_ticket, 'a draft', 'kb-2026-08-01', false);

  begin
    update ticket set status = 'AWAITING_AGENT' where id = v_ticket;
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: AWAITING_AGENT with an ungrounded response';
  exception when raise_exception then
    if sqlerrm not like '%E_TICKET_ESPERA_SIN_ANCLAJE%' then raise; end if;
  end;

  -- SENT means a person approved it and it went. Neither half alone will do.
  begin
    update ticket set status = 'SENT' where id = v_ticket;
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: SENT with nothing approved';
  exception when raise_exception then
    if sqlerrm not like '%E_TICKET_ENVIO_SIN_APROBACION%' then raise; end if;
  end;

  update response set approved_by = v_staff where id = v_response;
  begin
    update ticket set status = 'SENT' where id = v_ticket;
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: SENT with an approval and no send';
  exception when raise_exception then
    if sqlerrm not like '%E_TICKET_ENVIO_SIN_APROBACION%' then raise; end if;
  end;

  -- Both halves, and the state becomes reachable. `no_autosend` on the response is the other end of
  -- the same rule: a sent_at with no approver is refused there.
  update response set sent_at = now() where id = v_response;
  update ticket set status = 'SENT' where id = v_ticket;

  -- And the grounded response makes the other state reachable too.
  update response set grounded = true where id = v_response;
  update ticket set status = 'AWAITING_AGENT' where id = v_ticket;

  delete from response where id = v_response;
  delete from ticket where id = v_ticket;
end $$;

-- kb_snapshot_advance copies a COMPLETE set, and moves the pointer with it.
do $$
declare
  v_org    uuid := '11111111-1111-4111-8111-111111111111';
  v_before int;
  v_after  int;
  v_copied int;
  v_head   text;
begin
  select count(*) into v_before from kb_article where org_id = v_org and kb_snapshot = 'kb-2026-08-01';

  v_copied := kb_snapshot_advance(
    v_org, 'kb-2026-08-01', 'kb-2026-08-99',
    jsonb_build_array(jsonb_build_object(
      'canonical_key', 'ops/retention',
      'title', 'How long an archived record is kept',
      'body', 'An archived record stays visible for ninety days and can be restored by a supervisor.',
      'citable', true)));

  select count(*) into v_after from kb_article where org_id = v_org and kb_snapshot = 'kb-2026-08-99';
  if v_after <> v_before + 1 then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: the advance produced % rows from % plus one admission', v_after, v_before;
  end if;
  if v_copied <> v_after then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: the advance reported % and wrote %', v_copied, v_after;
  end if;

  -- The outgoing snapshot is untouched, which is the whole point: the replay under it is intact.
  if (select count(*) from kb_article where org_id = v_org and kb_snapshot = 'kb-2026-08-01') <> v_before then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: the advance disturbed the snapshot it copied from';
  end if;

  select kb_snapshot into v_head from kb_snapshot_head where org_id = v_org;
  if v_head <> 'kb-2026-08-99' then
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: the head is % after the advance', v_head;
  end if;

  -- Advancing into a snapshot that already exists is refused rather than doubling it.
  begin
    perform kb_snapshot_advance(v_org, 'kb-2026-08-01', 'kb-2026-08-99');
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: an advance into an existing snapshot was accepted';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_SNAPSHOT_YA_EXISTE%' then raise; end if;
  end;

  -- And an advance that changes nothing is refused too.
  begin
    perform kb_snapshot_advance(v_org, 'kb-2026-08-01', 'kb-2026-08-01');
    raise exception 'test_SEC_kb_admission_requires_a_human_approver_of_the_same_org: an advance from a snapshot to itself was accepted';
  exception when raise_exception then
    if sqlerrm not like '%E_KB_SNAPSHOT_NO_AVANZA%' then raise; end if;
  end;

  -- Put the corpus back where the rest of the suite expects it. The copied rows stay, because
  -- kb_article is append-only and this test is not exempt from that.
  update kb_snapshot_head set kb_snapshot = 'kb-2026-08-01' where org_id = v_org;
end $$;
