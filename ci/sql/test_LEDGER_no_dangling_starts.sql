-- test_LEDGER_no_dangling_starts
--
-- The conservation invariant, in SQL, under the name the specification gives it.
--
-- It is published in two clauses at once: "for every `start` row of the run there is exactly one
-- `promotion_attempt` with its `attempt_id` and a terminal `outcome`, and
-- `count(start) == count(terminals)`". Set equality satisfies both clauses; two counts satisfy only
-- the second. So the query below is an anti-join in BOTH directions, and the third case of this file
-- is the one that shows why: a start of A beside a terminal of B balances at one and one while the
-- run holds an attempt that never ended and an attempt that never began — the exact signature of the
-- peek-and-abort the invariant exists to catch.
--
-- And a row that claims to be a terminal while carrying an outcome outside the three published ones
-- is NOT a terminal here. Counting it would let an invalid row stand as evidence of conservation:
-- the line would read green because of the row that should have turned it red.
--
-- The scope is the RUN, because that is what the invariant's own text publishes. The screen counts a
-- different scope — the rows one session may see — and says so on screen; the two scopes are a
-- decision of each caller and the function is the same one.
--
-- Everything is seeded as the owner inside a transaction that is rolled back, like its sibling
-- `test_LEDGER_class_payload.sql`. Each case gets a run of its own, so it is the reconciliation that
-- answers and never the chain check.

begin;

-- A row hash that is sixty-four hexadecimal characters, deterministic per (run, seq), and different
-- from its predecessor — which is all `ledger_hash_shape` and `ledger_one_child_per_head` require of
-- a fixture. Nothing here is a digest of anything: this file measures the invariant over the chain,
-- not the chain itself, and `test_LEDGER_append_only` owns that.
create or replace function pg_temp.chain_hash(p_run uuid, p_seq bigint) returns text
  language sql immutable as $$
    select md5(p_run::text || ':' || p_seq::text) || md5(p_seq::text || ':' || p_run::text)
  $$;

create or replace function pg_temp.prev_hash(p_run uuid, p_seq bigint) returns text
  language sql immutable as $$
    select case when p_seq <= 1 then 'GENESIS' else pg_temp.chain_hash(p_run, p_seq - 1) end
  $$;

create or replace function pg_temp.put_start(p_run uuid, p_seq bigint, p_attempt text)
returns void language plpgsql as $$
begin
  insert into ledger_entry (
    run_id, seq, org_id, agent, state_hash, toolchain, restarts,
    tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
  values (p_run, p_seq, '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
    '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'start',
    jsonb_build_object(
      'attempt_id', p_attempt,
      'started_at', '2026-08-26T09:00:00.000Z',
      'budget_reserved', 0,
      'code_sha', '0123456789abcdef0123456789abcdef01234567'),
    pg_temp.prev_hash(p_run, p_seq), pg_temp.chain_hash(p_run, p_seq));
end $$;

create or replace function pg_temp.put_terminal(p_run uuid, p_seq bigint, p_attempt text, p_outcome text)
returns void language plpgsql as $$
begin
  insert into ledger_entry (
    run_id, seq, org_id, agent, state_hash, toolchain, restarts,
    tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
  values (p_run, p_seq, '11111111-1111-4111-8111-111111111111', 'evolve', repeat('d', 64),
    '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'promotion_attempt',
    jsonb_build_object(
      'attempt_id', p_attempt,
      'candidate_prompt_version_id', '7a1a9e00-0000-4000-8000-000000000002',
      'incumbent_prompt_version_id', '7a1a9e00-0000-4000-8000-000000000002',
      'conjuncts', jsonb_build_object(
        'paired_significant_at_alpha', jsonb_build_object('verdict', 'UNEVALUABLE', 'reason', 'no scored run'),
        'delta_positive',             jsonb_build_object('verdict', 'UNEVALUABLE', 'reason', 'no candidate'),
        'battery_in_force_green',     jsonb_build_object('verdict', 'UNEVALUABLE', 'reason', 'no battery'),
        'query_index_within_cmax',    jsonb_build_object('verdict', 'UNEVALUABLE', 'reason', 'no report slice')),
      'failing_conjunct', 'precondition_underpowered',
      'power', jsonb_build_object('delta', null, 'ci_low', null, 'ci_high', null,
                                  'ci_unit', 'clan', 'mde_n', null, 'mdi', null),
      'outcome', p_outcome,
      'interpretation', 'UNDERPOWERED'),
    pg_temp.prev_hash(p_run, p_seq), pg_temp.chain_hash(p_run, p_seq));
end $$;

-- The reconciliation itself: set equality by attempt, anti-joined both ways, over one run.
create or replace function pg_temp.reconcile(p_run uuid)
returns table (verdict text, starts int, terminals int, dangling text, orphan text, invalid text)
language sql stable as $$
  with s as (
    select output ->> 'attempt_id' as attempt_id
      from ledger_entry where run_id = p_run and class = 'start'
  ), t as (
    select output ->> 'attempt_id' as attempt_id
      from ledger_entry where run_id = p_run and class = 'promotion_attempt'
       and coalesce(output ->> 'outcome', '') in ('PROMOTED', 'REJECTED', 'ABORTED')
  ), bad as (
    select output ->> 'attempt_id' as attempt_id
      from ledger_entry where run_id = p_run and class = 'promotion_attempt'
       and coalesce(output ->> 'outcome', '') not in ('PROMOTED', 'REJECTED', 'ABORTED')
  ), d as (
    select attempt_id from s except select attempt_id from t
  ), o as (
    select attempt_id from t except select attempt_id from s
  )
  select
    case
      when (select count(*) from s) = 0 and (select count(*) from t) = 0
           and (select count(*) from bad) = 0 then 'nothing filed'
      when (select count(*) from d) = 0 and (select count(*) from o) = 0
           and (select count(*) from bad) = 0 then 'reconciled'
      else 'not reconciled'
    end,
    (select count(*)::int from s),
    (select count(*)::int from t),
    (select coalesce(string_agg(attempt_id, ',' order by attempt_id), '') from d),
    (select coalesce(string_agg(attempt_id, ',' order by attempt_id), '') from o),
    (select coalesce(string_agg(attempt_id, ',' order by attempt_id), '') from bad)
$$;

do $$
declare
  run_ok    uuid := 'bb000000-0000-4000-8000-000000000001';
  run_hang  uuid := 'bb000000-0000-4000-8000-000000000002';
  run_bad   uuid := 'bb000000-0000-4000-8000-000000000003';
  run_cross uuid := 'bb000000-0000-4000-8000-000000000004';
  a text := 'ba000000-0000-4000-8000-00000000000a';
  b text := 'ba000000-0000-4000-8000-00000000000b';
  c text := 'ba000000-0000-4000-8000-00000000000c';
  d text := 'ba000000-0000-4000-8000-00000000000d';
  e text := 'ba000000-0000-4000-8000-00000000000e';
  r record;
begin
  -- 1 · a matched pair reconciles, and the two counts agree as well
  perform pg_temp.put_start(run_ok, 1, a);
  perform pg_temp.put_terminal(run_ok, 2, a, 'REJECTED');
  select * into r from pg_temp.reconcile(run_ok);
  if r.verdict <> 'reconciled' then
    raise exception 'test_LEDGER_no_dangling_starts/matched pair: verdict is %', r.verdict;
  end if;
  if r.starts <> r.terminals or r.starts <> 1 then
    raise exception 'test_LEDGER_no_dangling_starts/matched pair: % starts against % terminals', r.starts, r.terminals;
  end if;

  -- 2 · a start with no terminal is REPORTED, and it is reported by its attempt_id
  perform pg_temp.put_start(run_hang, 1, b);
  select * into r from pg_temp.reconcile(run_hang);
  if r.verdict <> 'not reconciled' then
    raise exception 'test_LEDGER_no_dangling_starts/dangling start: verdict is %', r.verdict;
  end if;
  if r.dangling <> b then
    raise exception 'test_LEDGER_no_dangling_starts/dangling start: named "%" instead of %', r.dangling, b;
  end if;
  if r.terminals <> 0 then
    raise exception 'test_LEDGER_no_dangling_starts/dangling start: % terminals counted', r.terminals;
  end if;

  -- 3 · a terminal carrying an outcome outside the three published ones is not a terminal
  perform pg_temp.put_start(run_bad, 1, c);
  perform pg_temp.put_terminal(run_bad, 2, c, 'MAYBE');
  select * into r from pg_temp.reconcile(run_bad);
  if r.verdict <> 'not reconciled' then
    raise exception 'test_LEDGER_no_dangling_starts/invalid outcome: verdict is %', r.verdict;
  end if;
  if r.terminals <> 0 then
    raise exception 'test_LEDGER_no_dangling_starts/invalid outcome: it was counted as a terminal';
  end if;
  if r.invalid <> c or r.dangling <> c then
    raise exception 'test_LEDGER_no_dangling_starts/invalid outcome: invalid="%" dangling="%"', r.invalid, r.dangling;
  end if;

  -- 4 · the case two counts cannot see: a start of D beside a terminal of E
  perform pg_temp.put_start(run_cross, 1, d);
  perform pg_temp.put_terminal(run_cross, 2, e, 'REJECTED');
  select * into r from pg_temp.reconcile(run_cross);
  if r.starts <> 1 or r.terminals <> 1 then
    raise exception 'test_LEDGER_no_dangling_starts/crossed pair: the counts are % and %', r.starts, r.terminals;
  end if;
  if r.verdict <> 'not reconciled' then
    raise exception 'test_LEDGER_no_dangling_starts/crossed pair: the counts balanced and the verdict is %', r.verdict;
  end if;
  if r.dangling <> d then
    raise exception 'test_LEDGER_no_dangling_starts/crossed pair: dangling is "%" and should be %', r.dangling, d;
  end if;
  if r.orphan <> e then
    raise exception 'test_LEDGER_no_dangling_starts/crossed pair: orphan is "%" and should be %', r.orphan, e;
  end if;

  -- 5 · a run with nothing in it has a state of its own, and it is not "reconciled"
  select * into r from pg_temp.reconcile('bb000000-0000-4000-8000-0000000000ff');
  if r.verdict <> 'nothing filed' then
    raise exception 'test_LEDGER_no_dangling_starts/empty run: verdict is %', r.verdict;
  end if;
end $$;

rollback;
