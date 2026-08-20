-- 0004_eval_outcome.sql · quality-side child chain: the item x round matrix.
-- Written after the grants of 0001; the loop never reads it.
-- Authority: adr/ADR-018-complete-schema.md.
--
-- IRREVERSIBLE. If this table does not exist before the first sealed run, the data it holds
-- will never exist: it cannot be reconstructed afterwards from anything the ledger keeps.
--
-- It lives in the quality_report schema, which the application role has no usage on, under the
-- same append-only mechanism as ledger_entry, and it is never visible to the loop: the
-- evolution agent still receives its single bit, never the aggregate score and never the
-- per-item detail. The champion is re-evaluated fresh inside the same attempt, which is what
-- turns the carry-versus-fresh ablation into offline recomputation over a single run — and why
-- the query budget must be derived counting two evaluations per attempt.

create table quality_report.eval_outcome (
  id           bigserial   primary key,
  attempt_id   uuid        not null,                       -- the promotion attempt it belongs to
  arm          text        not null,                       -- the arm being evaluated
  role         text        not null check (role in ('candidate','champion_fresh')),
  item_id      text        not null,
  template_id  text        not null,                       -- the clan
  dag_node_id  uuid        not null references prompt_version(id),   -- node of the prompt DAG
  kb_snapshot  text        not null,
  verdict      text        not null,
  prev_hash    text        not null,
  row_hash     text        not null,
  unique (attempt_id, role, item_id)
);
revoke update, delete, truncate on quality_report.eval_outcome
  from public, authenticated, anon, service_role;
create trigger trg_eval_outcome_no_update before update or delete on quality_report.eval_outcome
  for each row execute function ledger_immutable();        -- same E_LEDGER_APPEND_ONLY
