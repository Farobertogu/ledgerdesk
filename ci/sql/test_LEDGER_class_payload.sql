-- test_LEDGER_class_payload
--
-- The ledger admits rows that are not model calls, and it admits them without loosening the
-- contract: the eight columns that describe a call that did not happen are nullable, the trigger
-- reinstates all of them for agent_call with the typed error code, the identity of the writer is
-- checked per class, and every class must carry the payload keys it owns — present AND not null,
-- because a key holding JSON null names nothing.
--
-- The per-class coverage is data-driven: one valid row per class, then one rejection per required
-- key of that class. Each negative uses a FRESH run_id, so it is the payload check that answers
-- and never the chain check.

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

insert into eval_split (id, run_id, kind, n, manifest_sha256, content_sha256, sealed_at) values
  ('5e100000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001',
   'report', 24, repeat('1', 64), repeat('2', 64), now());

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

-- 2 · an agent_call row missing ANY of the columns that describe the call it made is refused with
--     the typed code — not only the three the first version of the trigger looked at.
do $$
declare
  col text;
  ok  boolean;
begin
  foreach col in array array['prompt_version_id','model_requested','model_returned','sampling',
                             'input_hash','input_path','prompt_hash','response_hash'] loop
    ok := false;
    begin
      execute $q$
        insert into ledger_entry (
          run_id, seq, org_id, agent, prompt_version_id, model_requested, model_returned,
          sampling, input_hash, input_path, prompt_hash, response_hash, state_hash, toolchain,
          restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output,
          prev_hash, row_hash)
        values (gen_random_uuid(), 1, $1, 'triage',
          case when $2 = 'prompt_version_id' then null else '9d000000-0000-4000-8000-000000000001'::uuid end,
          case when $2 = 'model_requested'   then null else 'triage-model' end,
          case when $2 = 'model_returned'    then null else 'triage-model' end,
          case when $2 = 'sampling'          then null else '{"temperature":0}'::jsonb end,
          case when $2 = 'input_hash'        then null else repeat('a', 64) end,
          case when $2 = 'input_path'        then null else 'seed/orgs.sql' end,
          case when $2 = 'prompt_hash'       then null else repeat('b', 64) end,
          case when $2 = 'response_hash'     then null else repeat('c', 64) end,
          repeat('d', 64), '{"app":"0.1.0"}'::jsonb, 0, 120, 48, 0.002100, 840, 168,
          'agent_call', '{}'::jsonb, 'GENESIS', repeat('e', 64))
      $q$ using '11111111-1111-4111-8111-111111111111'::uuid, col;
    exception when others then
      ok := true;
      if position('E_LEDGER_ROW_INCOMPLETE' in sqlerrm) = 0 then
        raise exception 'test_LEDGER_class_payload/agent_call without %: rejected with "%" instead of E_LEDGER_ROW_INCOMPLETE', col, sqlerrm;
      end if;
    end;
    if not ok then
      raise exception 'test_LEDGER_class_payload/agent_call without %: the row was accepted', col;
    end if;
  end loop;
end $$;

-- 3 · the harness may not sign a promotion attempt: the payload here is VALID (an outcome of
--     PROMOTED is the one state where failing_conjunct may be null), so what answers is identity
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a4000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'promotion_attempt',
           '{"attempt_id":"c4000000-0000-4000-8000-000000000001",
             "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
             "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
             "conjuncts":{"paired_significant_at_alpha":"PASS","delta_positive":"PASS",
                          "battery_in_force_green":"PASS","query_index_within_cmax":"PASS"},
             "failing_conjunct":null,
             "power":{"delta":0.04,"ci_low":0.01,"ci_high":0.07,"ci_unit":"clan","mde_n":0.03,"mdi":0.05},
             "outcome":"PROMOTED", "interpretation":"POWERED-CONCLUSIVE"}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'ledger_agent_identity',
  'test_LEDGER_class_payload/promotion_attempt signed by the harness');

-- 4 · a rejected attempt with no conjunct named is as incomplete as a call without its model
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a5000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'evolve', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'promotion_attempt',
           '{"attempt_id":"c5000000-0000-4000-8000-000000000001",
             "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
             "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
             "conjuncts":{"paired_significant_at_alpha":"FAIL","delta_positive":"PASS",
                          "battery_in_force_green":"PASS","query_index_within_cmax":"PASS"},
             "failing_conjunct":null,
             "power":{"delta":0.01,"ci_low":-0.02,"ci_high":0.04,"ci_unit":"clan","mde_n":0.06,"mdi":0.05},
             "outcome":"REJECTED", "interpretation":"INFORMATIVE-NULL"}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'E_LEDGER_ROW_INCOMPLETE',
  'test_LEDGER_class_payload/promotion_attempt REJECTED with failing_conjunct null');

-- 5 · an abort must carry its reason from the closed taxonomy, or it is not a row of the chain
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a8000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'evolve', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'promotion_attempt',
           '{"attempt_id":"c8000000-0000-4000-8000-000000000001",
             "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
             "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
             "conjuncts":{"paired_significant_at_alpha":"UNEVALUABLE","delta_positive":"UNEVALUABLE",
                          "battery_in_force_green":"UNEVALUABLE","query_index_within_cmax":"UNEVALUABLE"},
             "failing_conjunct":"aborted_before_evaluation",
             "power":{"delta":0,"ci_low":0,"ci_high":0,"ci_unit":"clan","mde_n":0,"mdi":0.05},
             "outcome":"ABORTED", "interpretation":"UNDERPOWERED"}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'E_LEDGER_ROW_INCOMPLETE',
  'test_LEDGER_class_payload/ABORTED without abort_reason');

-- 6 · a per-item agreement row must name the sealed set it was measured over
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a7000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, 'agreement_r3',
           '{"item_id":"I-0000000000000000","template_id":"T-BILL-001","agreement":"2/3","r":3,
             "rollout_seeds":[1,2,3],"temperature":0.7}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'ledger_agreement_r3_has_split',
  'test_LEDGER_class_payload/agreement_r3 without split_id');

-- 7 · a row that did not call the model may not report a cost
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts,
           tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('a9000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 900000, 0, 5.000000, 0, 0, 'commitment',
           '{"commitment_kind":"labels_vector",
             "sha256":"1111111111111111111111111111111111111111111111111111111111111111",
             "covers":["blind_label"],"committed_before":"first_scored_run"}'::jsonb,
           'GENESIS', repeat('e', 64))$stmt$,
  'ledger_nonmodel_costs_zero',
  'test_LEDGER_class_payload/commitment reporting a cost');

-- 8 · every non-model class: one valid row, then one rejection per key it owns
create temp table class_case (class text, agent text, split_id uuid, required text[], payload jsonb)
  on commit drop;

insert into class_case (class, agent, split_id, required, payload) values
  ('start', 'system', null,
   array['attempt_id','started_at','budget_reserved','code_sha'],
   '{"attempt_id":"cc000000-0000-4000-8000-000000000001","started_at":"2026-08-21T00:00:00Z",
     "budget_reserved":120000,"code_sha":"0123456789abcdef0123456789abcdef01234567"}'::jsonb),
  ('promotion_attempt', 'evolve', null,
   array['attempt_id','candidate_prompt_version_id','incumbent_prompt_version_id','conjuncts',
         'failing_conjunct','power','outcome','interpretation'],
   '{"attempt_id":"cc000000-0000-4000-8000-000000000002",
     "candidate_prompt_version_id":"9d000000-0000-4000-8000-000000000002",
     "incumbent_prompt_version_id":"9d000000-0000-4000-8000-000000000001",
     "conjuncts":{"paired_significant_at_alpha":"FAIL","delta_positive":"PASS",
                  "battery_in_force_green":"PASS","query_index_within_cmax":"PASS"},
     "failing_conjunct":"paired_significant_at_alpha",
     "power":{"delta":0.012,"ci_low":-0.021,"ci_high":0.045,"ci_unit":"clan","mde_n":0.061,"mdi":0.050},
     "outcome":"REJECTED","interpretation":"INFORMATIVE-NULL"}'::jsonb),
  ('modification_event', 'evolve', null,
   array['modification_id','gating_arm','verdict','would_have_been_rejected','reason','dag_node_id'],
   '{"modification_id":"cc000000-0000-4000-8000-000000000003","gating_arm":"shadow",
     "verdict":{"invariants":"FAIL"},"would_have_been_rejected":true,
     "reason":"unverified_tool","dag_node_id":"9d000000-0000-4000-8000-000000000002"}'::jsonb),
  ('commitment', 'system', null,
   array['commitment_kind','sha256','covers','committed_before'],
   '{"commitment_kind":"labels_vector",
     "sha256":"1111111111111111111111111111111111111111111111111111111111111111",
     "covers":["blind_label"],"committed_before":"first_scored_run"}'::jsonb),
  ('prereg_anchor', 'system', null,
   array['document','sha256','field_count','blocks'],
   '{"document":"PREREGISTRATION.md",
     "sha256":"2222222222222222222222222222222222222222222222222222222222222222",
     "field_count":17,"blocks":["seeds","analysis","budget","model","alpha","exposure","headroom"]}'::jsonb),
  ('agreement_r3', 'system', '5e100000-0000-4000-8000-000000000001',
   array['item_id','template_id','agreement','r','rollout_seeds','temperature'],
   '{"item_id":"I-0000000000000000","template_id":"T-BILL-001","agreement":"2/3","r":3,
     "rollout_seeds":[11,22,33],"temperature":0.7}'::jsonb),
  ('kb_admission', 'system', null,
   array['admission_id','gap_id','approved_by','snapshot_from','snapshot_to','content_hash',
         'provenance_source'],
   '{"admission_id":"cc000000-0000-4000-8000-000000000004",
     "gap_id":"cc000000-0000-4000-8000-000000000005",
     "approved_by":"1a000000-0000-4000-8000-000000000003",
     "snapshot_from":"kb-2026-08-01","snapshot_to":"kb-2026-08-02",
     "content_hash":"3333333333333333333333333333333333333333333333333333333333333333",
     "provenance_source":"vendor-manual"}'::jsonb),
  ('checkpoint', 'system', null,
   array['seq_covered','head_row_hash','k'],
   '{"seq_covered":10,
     "head_row_hash":"4444444444444444444444444444444444444444444444444444444444444444",
     "k":10}'::jsonb);

do $$
declare
  c        record;
  k        text;
  ok       boolean;
  positives int := 0;
  negatives int := 0;
begin
  for c in select * from class_case order by class loop
    execute $q$
      insert into ledger_entry (run_id, seq, org_id, agent, split_id, state_hash, toolchain,
        restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output,
        prev_hash, row_hash)
      values (gen_random_uuid(), 1, $1, $2::agent_kind, $3, repeat('d', 64),
        '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, $4::ledger_class, $5,
        'GENESIS', repeat('e', 64))
    $q$ using '11111111-1111-4111-8111-111111111111'::uuid, c.agent, c.split_id, c.class, c.payload;
    positives := positives + 1;

    foreach k in array c.required loop
      ok := false;
      begin
        execute $q$
          insert into ledger_entry (run_id, seq, org_id, agent, split_id, state_hash, toolchain,
            restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output,
            prev_hash, row_hash)
          values (gen_random_uuid(), 1, $1, $2::agent_kind, $3, repeat('d', 64),
            '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 0, $4::ledger_class, $5,
            'GENESIS', repeat('e', 64))
        $q$ using '11111111-1111-4111-8111-111111111111'::uuid, c.agent, c.split_id, c.class,
                  c.payload - k;
      exception when others then
        ok := true;
        if position('E_LEDGER_ROW_INCOMPLETE' in sqlerrm) = 0 then
          raise exception 'test_LEDGER_class_payload/% without %: rejected with "%" instead of E_LEDGER_ROW_INCOMPLETE', c.class, k, sqlerrm;
        end if;
      end;
      if not ok then
        raise exception 'test_LEDGER_class_payload/% without %: the row was accepted', c.class, k;
      end if;
      negatives := negatives + 1;
    end loop;
  end loop;

  if positives <> 8 then
    raise exception 'test_LEDGER_class_payload: % of the 8 non-model classes were exercised', positives;
  end if;
  if negatives <> 42 then
    raise exception 'test_LEDGER_class_payload: % rejections instead of the 42 required keys of the eight classes', negatives;
  end if;
end $$;

rollback;
