-- test_LEDGER_class_payload
--
-- The ledger admits rows that are not model calls, and it admits them without loosening the
-- contract: the eight columns that describe a call that did not happen are nullable, a check
-- reinstates all eight for agent_call, the identity of the writer is checked per class, and the
-- trigger demands the payload keys each class owns.

begin;

create or replace function pg_temp.expect_reject(stmt text, needle text, label text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if position(needle in sqlerrm) > 0 then return; end if;
    raise exception '%: rejected with "%" instead of "%"', label, sqlerrm, needle;
  end;
  raise exception '%: the statement was accepted and should have been rejected', label;
end $$;

insert into prompt_version (id, agent, generation, text, schema_hash) values
  ('9d000000-0000-4000-8000-000000000001', 'triage', 0, 'incumbent prompt', repeat('0', 64)),
  ('9d000000-0000-4000-8000-000000000002', 'triage', 1, 'candidate prompt', repeat('0', 64));

-- 1 · a complete agent_call row is accepted
insert into ledger_entry (
  run_id, seq, org_id, agent, prompt_version_id, model_requested, model_returned, sampling,
  input_hash, input_path, prompt_hash, response_hash, state_hash, toolchain, restarts,
  tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
values ('a1000000-0000-4000-8000-000000000001', 1,
  '11111111-1111-4111-8111-111111111111', 'triage', '9d000000-0000-4000-8000-000000000001',
  'triage-model', 'triage-model', '{"temperature":0}'::jsonb,
  repeat('a', 64), 'seed/orgs.sql', repeat('b', 64), repeat('c', 64), repeat('d', 64),
  '{"app":"0.1.0"}'::jsonb, 0, 120, 48, 0.002100, 840, 168,
  'agent_call', '{"category":"billing"}'::jsonb, 'GENESIS', repeat('e', 64));

-- 2 · an agent_call row without the model it actually called is refused
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, prompt_version_id, model_requested, sampling,
           input_hash, input_path, prompt_hash, response_hash, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a2000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'triage', '9d000000-0000-4000-8000-000000000001',
           'triage-model', '{"temperature":0}'::jsonb,
           repeat('a', 64), 'seed/orgs.sql', repeat('b', 64), repeat('c', 64), repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 120, 48, 0.002100, 840, 168,
           'agent_call', '{}'::jsonb, 'GENESIS', repeat('e', 64))$stmt$,
  'E_LEDGER_FILA_INCOMPLETA',
  'test_LEDGER_class_payload/agent_call without model_returned');

-- 3 · a promotion attempt is written by the evolution agent, with no model call and its full verdict
insert into ledger_entry (
  run_id, seq, org_id, agent, state_hash, toolchain, restarts,
  tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
values ('a3000000-0000-4000-8000-000000000001', 1,
  '11111111-1111-4111-8111-111111111111', 'evolve', repeat('d', 64),
  '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0.000000, 0, 168, 'promotion_attempt',
  '{"attempt_id":"c1000000-0000-4000-8000-000000000001",
    "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
    "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
    "conjuncts":{"paired_significant_at_alpha":"FAIL","delta_positive":"PASS",
                 "battery_in_force_green":"PASS","query_index_within_cmax":"PASS"},
    "failing_conjunct":"paired_significant_at_alpha",
    "power":{"delta":0.012,"ci_low":-0.021,"ci_high":0.045,"ci_unit":"clan","mde_n":0.061,"mdi":0.050},
    "outcome":"REJECTED",
    "interpretation":"INFORMATIVE-NULL"}'::jsonb,
  'GENESIS', repeat('e', 64));

-- 4 · the harness may not sign a promotion attempt: that row keeps the identity of its author
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a4000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0.000000, 0, 168, 'promotion_attempt',
           '{"attempt_id":"c4000000-0000-4000-8000-000000000001",
             "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
             "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
             "conjuncts":{}, "failing_conjunct":null,
             "power":{}, "outcome":"REJECTED", "interpretation":"UNDERPOWERED"}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'ledger_agent_identity',
  'test_LEDGER_class_payload/promotion_attempt signed by the harness');

-- 5 · a verdict without its named failing conjunct is as incomplete as a call without its model
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a5000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'evolve', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0.000000, 0, 168, 'promotion_attempt',
           '{"attempt_id":"c5000000-0000-4000-8000-000000000001",
             "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
             "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
             "conjuncts":{}, "power":{}, "outcome":"REJECTED",
             "interpretation":"INFORMATIVE-NULL"}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'E_LEDGER_FILA_INCOMPLETA',
  'test_LEDGER_class_payload/promotion_attempt without failing_conjunct');

-- 6 · a commitment row costs nothing, is written by the harness, and carries its hash
insert into ledger_entry (
  run_id, seq, org_id, agent, state_hash, toolchain, restarts,
  tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
values ('a6000000-0000-4000-8000-000000000001', 1,
  '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
  '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0.000000, 0, 0, 'commitment',
  '{"commitment_kind":"labels_vector",
    "sha256":"1111111111111111111111111111111111111111111111111111111111111111",
    "covers":["blind_label"],
    "committed_before":"first_scored_run"}'::jsonb,
  'GENESIS', repeat('e', 64));

-- 7 · a per-item agreement row must name the sealed set it was measured over
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a7000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0.000000, 0, 0, 'agreement_r3',
           '{"item_id":"T-BILL-001-0000","template_id":"T-BILL-001","agreement":"2/3","r":3,
             "rollout_seeds":[1,2,3],"temperature":0.7}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'ledger_agreement_r3_has_split',
  'test_LEDGER_class_payload/agreement_r3 without split_id');

rollback;
