-- Finite durable-output accounting, separate from transient worker scratch.
-- A pending or failed unsealed attempt retains its full claim. No history is
-- deleted, and uncertain physical state never releases a reservation.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;
CREATE TABLE intake_trial.extraction_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  capacity_bytes bigint NOT NULL CHECK(capacity_bytes>0 AND capacity_bytes<=1073741824),
  charged_bytes bigint NOT NULL CHECK(charged_bytes>=0 AND charged_bytes<=capacity_bytes)
);
CREATE TABLE intake_trial.extraction_reservation (
  job_id uuid NOT NULL, attempt_generation integer NOT NULL,
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes=58720256),
  charged_bytes bigint NOT NULL CHECK(charged_bytes BETWEEN 0 AND reserved_bytes),
  state text NOT NULL CHECK(state IN ('reserved','durable')),
  PRIMARY KEY(job_id,attempt_generation),
  FOREIGN KEY(job_id,attempt_generation) REFERENCES intake_trial.extraction_attempt(job_id,attempt_generation),
  CHECK(state='durable' OR charged_bytes=reserved_bytes)
);
-- The prior 64 MiB setting cannot hold the measured 126,355,484-byte corpus
-- plus a 56 MiB in-flight claim. 256 MiB holds those and one retained unresolved
-- claim (243,795,996 bytes at that cut); it remains a finite synthetic quota.
INSERT INTO intake_trial.extraction_reservation
  SELECT a.job_id,a.attempt_generation,58720256,coalesce(o.bytes,58720256),
    CASE WHEN o.id IS NULL THEN 'reserved' ELSE 'durable' END
  FROM intake_trial.extraction_attempt a LEFT JOIN intake_trial.extraction_output o
    ON o.job_id=a.job_id AND o.attempt_generation=a.attempt_generation;
INSERT INTO intake_trial.extraction_capacity
  SELECT true,268435456,coalesce(sum(charged_bytes),0) FROM intake_trial.extraction_reservation;

CREATE FUNCTION intake_trial.reserve_extraction_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- This row update serializes competing claims; a count or snapshot sum alone
  -- would let two independently admissible transactions promise the same space.
  UPDATE intake_trial.extraction_capacity SET charged_bytes=charged_bytes+58720256
    WHERE singleton AND charged_bytes<=capacity_bytes-58720256;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extraction durable capacity unavailable' USING ERRCODE='53400'; END IF;
  INSERT INTO intake_trial.extraction_reservation VALUES(NEW.job_id,NEW.attempt_generation,58720256,58720256,'reserved');
  RETURN NEW;
END $$;
CREATE TRIGGER extraction_reserve_capacity AFTER INSERT ON intake_trial.extraction_attempt
  FOR EACH ROW EXECUTE FUNCTION intake_trial.reserve_extraction_capacity();

CREATE FUNCTION intake_trial.settle_extraction_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE held intake_trial.extraction_reservation%ROWTYPE;
BEGIN
  SELECT * INTO held FROM intake_trial.extraction_reservation
    WHERE job_id=NEW.job_id AND attempt_generation=NEW.attempt_generation FOR UPDATE;
  IF NOT FOUND OR held.state<>'reserved' OR NEW.bytes>held.reserved_bytes THEN
    RAISE EXCEPTION 'Extraction reservation association' USING ERRCODE='23514'; END IF;
  UPDATE intake_trial.extraction_capacity SET charged_bytes=charged_bytes-held.charged_bytes+NEW.bytes WHERE singleton;
  UPDATE intake_trial.extraction_reservation SET state='durable',charged_bytes=NEW.bytes
    WHERE job_id=NEW.job_id AND attempt_generation=NEW.attempt_generation;
  RETURN NEW;
END $$;
CREATE TRIGGER extraction_settle_capacity AFTER INSERT ON intake_trial.extraction_output
  FOR EACH ROW EXECUTE FUNCTION intake_trial.settle_extraction_capacity();
REVOKE ALL ON intake_trial.extraction_capacity,intake_trial.extraction_reservation FROM PUBLIC;
REVOKE ALL ON FUNCTION intake_trial.reserve_extraction_capacity(),intake_trial.settle_extraction_capacity() FROM PUBLIC;
GRANT SELECT ON intake_trial.extraction_capacity,intake_trial.extraction_reservation TO inc03_intake_runtime,inc03_intake_reader;
COMMIT;
