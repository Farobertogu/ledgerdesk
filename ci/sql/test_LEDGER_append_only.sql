-- test_LEDGER_append_only
--
-- Append-only by mechanism and not by convention: an UPDATE or a DELETE on the ledger, and on
-- the anchor table that witnesses its head, is refused by the database itself.

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

rollback;
