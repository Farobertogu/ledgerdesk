-- test_LEDGER_append_only
--
-- Append-only by mechanism and not by convention: UPDATE, DELETE and TRUNCATE on the ledger, on
-- the anchor table that witnesses its head, and on the quality-side child chain are refused by
-- the database itself — and refused earlier still, by privilege, for a role that is not the owner.
-- The chain is also checked where it can be broken without forging a hash: by choosing the seq.

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
  ('9d000000-0000-4000-8000-000000000001', 'triage', 0, 'seed prompt', repeat('0', 64));

insert into ledger_entry (
  run_id, seq, org_id, agent, prompt_version_id,
  model_requested, model_returned, sampling,
  input_hash, input_path, prompt_hash, response_hash, state_hash,
  toolchain, restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens,
  class, output, prev_hash, row_hash)
values (
  '9f000000-0000-4000-8000-000000000001', 1,
  '11111111-1111-4111-8111-111111111111', 'triage', '9d000000-0000-4000-8000-000000000001',
  'triage-model', 'triage-model', '{"temperature":0,"top_p":1,"max_tokens":512}'::jsonb,
  repeat('a', 64), 'seed/orgs.sql', repeat('b', 64), repeat('c', 64), repeat('d', 64),
  '{"app":"0.1.0","node":"22","model_sdk":"0.0.0","ruleset":"0.0.0"}'::jsonb,
  0, 120, 48, 0.002100, 840, 168,
  'agent_call', '{"category":"billing","severity":2}'::jsonb, 'GENESIS', repeat('e', 64));

select pg_temp.expect_reject(
  $stmt$update ledger_entry set output = '{}'::jsonb
          where run_id = '9f000000-0000-4000-8000-000000000001'$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/update');

select pg_temp.expect_reject(
  $stmt$delete from ledger_entry where run_id = '9f000000-0000-4000-8000-000000000001'$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/delete');

-- TRUNCATE is a deletion route of its own: a row trigger never fires on it and the owner keeps
-- the privilege, so without a statement trigger the guarantee would be a convention here.
select pg_temp.expect_reject(
  $stmt$truncate ledger_entry$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/truncate');

-- a chain whose anchor can be edited anchors nothing
insert into ledger_checkpoint (run_id, seq_covered, head_row_hash, k, external_ref) values
  ('9f000000-0000-4000-8000-000000000001', 1, repeat('e', 64), 10, repeat('f', 40));

select pg_temp.expect_reject(
  $stmt$update ledger_checkpoint set head_row_hash = repeat('9', 64)
          where run_id = '9f000000-0000-4000-8000-000000000001'$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/checkpoint_update');

select pg_temp.expect_reject(
  $stmt$delete from ledger_checkpoint where run_id = '9f000000-0000-4000-8000-000000000001'$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/checkpoint_delete');

select pg_temp.expect_reject(
  $stmt$truncate ledger_checkpoint$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/checkpoint_truncate');

-- a row that does not chain against the head of its run is not a row of that chain
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, prompt_version_id, model_requested, model_returned,
           sampling, input_hash, input_path, prompt_hash, response_hash, state_hash, toolchain,
           restarts, tokens_in, tokens_out, cost_aud, latency_ms, cum_tokens, class, output,
           prev_hash, row_hash)
         values ('9f000000-0000-4000-8000-000000000001', 2,
           '11111111-1111-4111-8111-111111111111', 'triage', '9d000000-0000-4000-8000-000000000001',
           'triage-model', 'triage-model', '{"temperature":0}'::jsonb,
           repeat('a', 64), 'seed/orgs.sql', repeat('b', 64), repeat('c', 64), repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 10, 5, 0.000100, 90, 183,
           'agent_call', '{}'::jsonb, 'GENESIS', repeat('7', 64))$stmt$,
  'E_LEDGER_CHAIN_BROKEN',
  'test_LEDGER_append_only/chain');

-- The seq has to advance: the head is the LAST row, so a row that chains correctly against it
-- while reusing or rewinding the sequence forks the chain without forging a single hash.
select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts, tokens_in, tokens_out,
           cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('9f000000-0000-4000-8000-000000000001', 1,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 168, 'checkpoint',
           '{"seq_covered":1,"head_row_hash":"aaaa","k":10}'::jsonb,
           repeat('e', 64), repeat('8', 64))$stmt$,
  'E_LEDGER_CHAIN_BROKEN',
  'test_LEDGER_append_only/seq_does_not_advance');

-- and a parent that is no longer the head may not gain a second child
insert into ledger_entry (
  run_id, seq, org_id, agent, state_hash, toolchain, restarts, tokens_in, tokens_out,
  cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
values ('9f000000-0000-4000-8000-000000000001', 2,
  '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
  '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 168, 'checkpoint',
  '{"seq_covered":1,"head_row_hash":"aaaa","k":10}'::jsonb,
  repeat('e', 64), repeat('7', 64));

select pg_temp.expect_reject(
  $stmt$insert into ledger_entry (
           run_id, seq, org_id, agent, state_hash, toolchain, restarts, tokens_in, tokens_out,
           cost_aud, latency_ms, cum_tokens, class, output, prev_hash, row_hash)
         values ('9f000000-0000-4000-8000-000000000001', 3,
           '11111111-1111-4111-8111-111111111111', 'system', repeat('d', 64),
           '{"app":"0.1.0"}'::jsonb, 0, 0, 0, 0, 0, 168, 'checkpoint',
           '{"seq_covered":2,"head_row_hash":"bbbb","k":10}'::jsonb,
           repeat('e', 64), repeat('6', 64))$stmt$,
  'E_LEDGER_CHAIN_BROKEN',
  'test_LEDGER_append_only/second_child_of_one_head');

-- Defence in depth: for a role that is not the owner the privilege denies before the trigger
-- ever runs. The application role holds insert and select on the ledger and nothing else.
do $$
declare
  stmt text;
  denied int := 0;
begin
  perform set_config('role', 'app_rw', true);
  foreach stmt in array array[
    $s$update ledger_entry set output = '{}'::jsonb$s$,
    $s$delete from ledger_entry$s$,
    $s$truncate ledger_entry$s$
  ] loop
    begin
      execute stmt;
      raise exception 'test_LEDGER_append_only/privilege: the application role could run: %', stmt;
    exception when insufficient_privilege then
      denied := denied + 1;
    end;
  end loop;
  perform set_config('role', 'none', true);
  if denied <> 3 then
    raise exception 'test_LEDGER_append_only/privilege: % of 3 statements were denied by privilege', denied;
  end if;
end $$;

-- The two triggers that the schema test only knows by name, exercised by effect.
select pg_temp.expect_reject(
  $stmt$update prompt_version set text = 'edited after the run'
          where id = '9d000000-0000-4000-8000-000000000001'$stmt$,
  'E_PROMPT_VERSION_INMUTABLE',
  'test_LEDGER_append_only/prompt_version_text');

do $$
declare touched int;
begin
  update prompt_version set promoted_at = now()
   where id = '9d000000-0000-4000-8000-000000000001';
  get diagnostics touched = row_count;
  if touched <> 1 then
    raise exception 'test_LEDGER_append_only/prompt_version_promoted_at: the promotion gate could not write promoted_at (% rows), which is the one exception the migration grants', touched;
  end if;
end $$;

insert into quality_report.eval_outcome (
  attempt_id, arm, role, item_id, template_id, dag_node_id, kb_snapshot, verdict,
  prev_hash, row_hash)
values ('c1000000-0000-4000-8000-000000000001', 'on', 'candidate', 'I-0000000000000000',
        'T-BILL-001', '9d000000-0000-4000-8000-000000000001', 'kb-2026-08-01', 'correct',
        'GENESIS', repeat('3', 64));

select pg_temp.expect_reject(
  $stmt$update quality_report.eval_outcome set verdict = 'incorrect'
          where attempt_id = 'c1000000-0000-4000-8000-000000000001'$stmt$,
  'E_LEDGER_APPEND_ONLY',
  'test_LEDGER_append_only/eval_outcome_update');

rollback;
