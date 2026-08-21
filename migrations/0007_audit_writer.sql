-- 0007_audit_writer.sql — the audit table can actually be written (ADR-021).
--
-- 0001 created audit_event with chain columns, append-only locks, tenant RLS and, as of the
-- data-spine review, its own chaining trigger — and granted not a single privilege on it to any
-- role. The product's audit surface was unwritable by the entire application. Surfaced while
-- wiring the gateway's security events (an unredacted canary is a first-order security event and
-- had nowhere durable to land); the same gap would have blocked the triage agent and the audit
-- log surface in turn.

grant insert, select on audit_event to app_rw;
grant usage on sequence audit_event_id_seq to app_rw;
