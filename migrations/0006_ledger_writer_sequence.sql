-- 0006_ledger_writer_sequence.sql — the ledger writer can actually write (ADR-020).
--
-- 0002 granted app_rw insert and select on ledger_entry, but the table's id is a bigserial:
-- evaluating its default calls nextval on ledger_entry_id_seq, and sequence usage is a grant of
-- its own that no migration gave. The role the schema names as the ledger writer received
-- "permission denied for sequence" on its first real row. Surfaced by the gateway build — the
-- first code that ever wrote a ledger row as app_rw; every application table takes caller-supplied
-- UUIDs, which is why nothing hit it earlier.

grant usage on sequence ledger_entry_id_seq to app_rw;
