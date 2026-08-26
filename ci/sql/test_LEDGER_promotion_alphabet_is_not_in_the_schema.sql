-- test_LEDGER_promotion_alphabet_is_not_in_the_schema
--
-- The residual, MEASURED rather than assumed.
--
-- `migrations/` is a frozen, forward-only path, and `0002` assigns the typing of a payload to the
-- writer on purpose: "the database guarantees that nothing is missing; the writer validates the full
-- typing against quality/schemas/ledger_class/<class>.schema.json". That is a deliberate division of
-- labour and this card does not move it.
--
-- But a residual assumed in silence is how a guarantee turns into a belief. What the trigger checks
-- is PRESENCE and one nullity rule; it checks nothing about a value. So every statement below is
-- expected to be ACCEPTED by the database — and each one carries the rule in
-- `agents/ledger/promotion_row.ts` that closes it and the `check`-job test that measures that rule.
-- That is the whole point of the file: it is what separates "fail-closed" from "fail-closed as long
-- as everybody goes through this module".
--
-- **The day somebody closes one of these in the schema, this test goes RED and forces the
-- declaration to be updated.** That is the intended behaviour, not a fragility: the file exists to
-- keep the statement about the residual true.
--
-- Seeded as the owner inside a transaction that is rolled back, like its two siblings. Each case
-- takes a run of its own so that the chain check never answers in the payload's place.

begin;

create or replace function pg_temp.expect_accept(stmt text, label text)
returns void language plpgsql as $$
begin
  execute stmt;
exception when others then
  raise exception '%: the database REFUSED it with "%". The residual this file declares has been closed in the schema; update the declaration.', label, sqlerrm;
end $$;

-- The shape every case below starts from: an otherwise well-formed terminal, with one value made
-- wrong. `evolve` is the identity `ledger_agent_identity` demands and the five cost sentinels are
-- what `ledger_nonmodel_costs_zero` demands; neither is what this file is about.
create or replace function pg_temp.terminal(p_run uuid, p_attempt text, p_output jsonb)
returns text language sql immutable as $$
  select format(
    $f$insert into ledger_entry (
         run_id, seq, org_id, agent, state_hash, toolchain, restarts,
         tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
       values (%L::uuid, 1, '11111111-1111-4111-8111-111111111111', 'evolve', repeat('d', 64),
         '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'promotion_attempt', %L::jsonb,
         'GENESIS', %L)$f$,
    p_run, p_output::text, md5(p_attempt) || md5(p_run::text))
$$;

create or replace function pg_temp.payload(p_attempt text, p_overrides jsonb)
returns jsonb language sql immutable as $$
  select jsonb_build_object(
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
      'outcome', 'REJECTED',
      'interpretation', 'UNDERPOWERED')
    || p_overrides
$$;

do $$
declare
  a text;
begin
  -- 1 · an outcome outside the three terminals.
  --     Closed by: the OUTCOMES alphabet of the writer.
  --     Measured by: test_PROMO_writer_refuses_out_of_alphabet, "a value outside each of the four
  --     closed alphabets", and by reconcileAttempts, which refuses to count it as a terminal.
  a := 'ca000000-0000-4000-8000-000000000001';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000001', a,
      pg_temp.payload(a, '{"outcome":"MAYBE"}'::jsonb)),
    'test_LEDGER_promotion_alphabet/outcome MAYBE');

  -- 2 · conjuncts as an empty object: the key is present, so the trigger is satisfied.
  --     Closed by: "conjuncts must carry exactly the four published names, in order".
  --     Measured by: test_PROMO_writer_refuses_out_of_alphabet, "conjuncts is an object of exactly
  --     the four published names", and by the view model, which throws rather than rendering.
  a := 'ca000000-0000-4000-8000-000000000002';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000002', a,
      pg_temp.payload(a, '{"conjuncts":{}}'::jsonb)),
    'test_LEDGER_promotion_alphabet/empty conjuncts');

  -- 3 · a failing conjunct that names nothing in the alphabet.
  --     Closed by: the FAILING_CONJUNCTS alphabet of the writer.
  a := 'ca000000-0000-4000-8000-000000000003';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000003', a,
      pg_temp.payload(a, '{"failing_conjunct":"banana"}'::jsonb)),
    'test_LEDGER_promotion_alphabet/failing_conjunct banana');

  -- 4 · an interpretation outside its closed alphabet.
  --     Closed by: the INTERPRETATIONS alphabet of the writer.
  a := 'ca000000-0000-4000-8000-000000000004';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000004', a,
      pg_temp.payload(a, '{"interpretation":"GOOD"}'::jsonb)),
    'test_LEDGER_promotion_alphabet/interpretation GOOD');

  -- 5 · **a promotion with a failed conjunct.** The trigger ties `failing_conjunct = null` to
  --     PROMOTED and stops there, so this row — promoted while `delta_positive` says FAIL — goes
  --     straight in. It is exactly what the fail-closed rule of ADR-012 exists to close.
  --     Closed by: clause (a) of the writer's coherence rules.
  --     Measured by: test_PROMO_row_is_internally_coherent, case (a).
  a := 'ca000000-0000-4000-8000-000000000005';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000005', a,
      pg_temp.payload(a, jsonb_build_object(
        'conjuncts', jsonb_build_object(
          'paired_significant_at_alpha', jsonb_build_object('verdict', 'PASS', 'reason', ''),
          'delta_positive',             jsonb_build_object('verdict', 'FAIL', 'reason', 'it lost'),
          'battery_in_force_green',     jsonb_build_object('verdict', 'PASS', 'reason', ''),
          'query_index_within_cmax',    jsonb_build_object('verdict', 'PASS', 'reason', '')),
        'failing_conjunct', null,
        'outcome', 'PROMOTED',
        'interpretation', 'POWERED-CONCLUSIVE'))),
    'test_LEDGER_promotion_alphabet/PROMOTED with a failed conjunct');

  -- 6 · **a rejection naming a conjunct that passed.** On screen this puts, as the conjunct that
  --     failed, one that approved.
  --     Closed by: clause (b) of the writer's coherence rules.
  --     Measured by: test_PROMO_row_is_internally_coherent, case (b).
  a := 'ca000000-0000-4000-8000-000000000006';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000006', a,
      pg_temp.payload(a, jsonb_build_object(
        'conjuncts', jsonb_build_object(
          'paired_significant_at_alpha', jsonb_build_object('verdict', 'PASS', 'reason', ''),
          'delta_positive',             jsonb_build_object('verdict', 'PASS', 'reason', ''),
          'battery_in_force_green',     jsonb_build_object('verdict', 'FAIL', 'reason', 'expired'),
          'query_index_within_cmax',    jsonb_build_object('verdict', 'PASS', 'reason', '')),
        'failing_conjunct', 'delta_positive',
        'interpretation', 'INFORMATIVE-NULL'))),
    'test_LEDGER_promotion_alphabet/REJECTED naming a conjunct that passed');

  -- 7 · a conjunct as a bare string rather than an object with its reason. The published block reads
  --     "each: PASS | FAIL | UNEVALUABLE, with its reason"; the only executable sample in the tree
  --     uses flat strings because it exercises presence alone, and that sample is not the contract.
  --     Closed by: "conjuncts.<name> must be a JSON object" plus the reason rule.
  a := 'ca000000-0000-4000-8000-000000000007';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000007', a,
      pg_temp.payload(a, '{"conjuncts":{"paired_significant_at_alpha":"UNEVALUABLE",
                                        "delta_positive":"UNEVALUABLE",
                                        "battery_in_force_green":"UNEVALUABLE",
                                        "query_index_within_cmax":"UNEVALUABLE"}}'::jsonb)),
    'test_LEDGER_promotion_alphabet/conjuncts as flat strings');

  -- 8 · `power` in the shape superseded on 2026-08-21: a scalar interval with neither endpoint nor
  --     unit. Nothing in the schema knows the supersession happened.
  --     Closed by: the six-key POWER_KEYS rule of the writer.
  a := 'ca000000-0000-4000-8000-000000000008';
  perform pg_temp.expect_accept(
    pg_temp.terminal('cb000000-0000-4000-8000-000000000008', a,
      pg_temp.payload(a, '{"power":{"delta":0,"ci":null,"mde_n":0,"mdi":0}}'::jsonb)),
    'test_LEDGER_promotion_alphabet/the superseded power shape');

  -- 9 · a code_sha that is the empty string, in the row that exists to pin a tree.
  --     Closed by: the forty-hexadecimal rule of the writer, and by the operator mandate, which
  --     refuses to run against a dirty tree at all.
  insert into ledger_entry (
    run_id, seq, org_id, agent, state_hash, toolchain, restarts,
    tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
  values ('cb000000-0000-4000-8000-000000000009', 1,
    '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
    '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'start',
    '{"attempt_id":"ca000000-0000-4000-8000-000000000009",
      "started_at":"2026-08-26T09:00:00.000Z","budget_reserved":0,"code_sha":""}'::jsonb,
    'GENESIS', repeat('9', 64));
end $$;

-- Nine rows the schema accepted and the writer would refuse. The count is asserted so that a case
-- silently ceasing to run is a failure rather than a smaller file.
do $$
declare n int;
begin
  select count(*)::int into n from ledger_entry
   where run_id::text like 'cb000000-0000-4000-8000-%';
  if n <> 9 then
    raise exception 'test_LEDGER_promotion_alphabet_is_not_in_the_schema: % of the 9 residual cases were exercised', n;
  end if;
end $$;

rollback;
