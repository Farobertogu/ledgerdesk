-- Fresh exclusive synthetic cluster only. Not part of the historical migration sequence.
-- Bootstrap creates login credentials separately; no credential belongs in this file.
BEGIN;
CREATE ROLE inc01_schema_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc01_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc01_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE inc01_synthetic FROM PUBLIC;
GRANT CONNECT ON DATABASE inc01_synthetic TO inc01_reader, inc01_writer;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA reading_trial AUTHORIZATION inc01_schema_owner;
SET LOCAL ROLE inc01_schema_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA reading_trial REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA reading_trial REVOKE ALL ON FUNCTIONS FROM PUBLIC;
CREATE TABLE reading_trial.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  deployment_id text NOT NULL CHECK (deployment_id = 'inc01-synthetic'),
  scope_id text NOT NULL CHECK (scope_id = 'inc01-material'),
  generation text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  active boolean NOT NULL DEFAULT false,
  capture_ready boolean NOT NULL DEFAULT false,
  processing_ready boolean NOT NULL DEFAULT false,
  conservation_ready boolean NOT NULL DEFAULT false,
  trace_ready boolean NOT NULL DEFAULT false,
  destination_ready boolean NOT NULL DEFAULT false
);
CREATE TABLE reading_trial.material (
  deployment_id text NOT NULL CHECK (deployment_id = 'inc01-synthetic'),
  scope_id text NOT NULL CHECK (scope_id = 'inc01-material'),
  -- Canonical JSON string keys preserve opaque IDs, including escaped control characters.
  unit_key text NOT NULL CHECK (json_typeof(unit_key::json) = 'string'),
  version_key text NOT NULL CHECK (json_typeof(version_key::json) = 'string'),
  -- No JSONB cast or SQL string extraction: both would narrow the public string domain.
  original_value json NOT NULL CHECK (json_typeof(original_value) = 'string'),
  original_language text NOT NULL CHECK (original_language IN ('es', 'en')),
  metadata json NOT NULL CHECK (json_typeof(metadata) = 'object'),
  fragments json NOT NULL CHECK (json_typeof(fragments) = 'array'),
  requirements json NOT NULL CHECK (json_typeof(requirements) = 'object'),
  PRIMARY KEY (deployment_id, scope_id, unit_key, version_key)
);
CREATE TABLE reading_trial.policy (
  deployment_id text NOT NULL,
  scope_id text NOT NULL,
  unit_key text NOT NULL,
  version_key text NOT NULL,
  hierarchy json NOT NULL CHECK (json_typeof(hierarchy) = 'object'),
  PRIMARY KEY (deployment_id, scope_id, unit_key, version_key),
  FOREIGN KEY (deployment_id, scope_id, unit_key, version_key)
    REFERENCES reading_trial.material (deployment_id, scope_id, unit_key, version_key)
);
CREATE TABLE reading_trial.access_evidence (
  receipt_id uuid PRIMARY KEY,
  decision_id uuid UNIQUE NOT NULL,
  subject_id text NOT NULL,
  generation text NOT NULL,
  restriction_revision bigint NOT NULL,
  action text NOT NULL CHECK (action IN ('list', 'exact')),
  requested_pair json,
  result_status integer NOT NULL CHECK (result_status IN (200, 404, 503)),
  decisions json NOT NULL CHECK (json_typeof(decisions) = 'array'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE reading_trial.transport_observation (
  observation_id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES reading_trial.access_evidence (receipt_id),
  outcome text NOT NULL CHECK (outcome IN ('finished', 'interrupted', 'uncertain')),
  observed_bytes bigint CHECK (observed_bytes >= 0),
  response_status integer CHECK (response_status IN (200, 400, 403, 404, 503)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION reading_trial.prevent_rewrite() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable trial record' USING ERRCODE = '55000'; END $$;
CREATE TRIGGER immutable_material BEFORE UPDATE OR DELETE ON reading_trial.material
FOR EACH ROW EXECUTE FUNCTION reading_trial.prevent_rewrite();
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON reading_trial.access_evidence
FOR EACH ROW EXECUTE FUNCTION reading_trial.prevent_rewrite();
CREATE TRIGGER immutable_observation BEFORE UPDATE OR DELETE ON reading_trial.transport_observation
FOR EACH ROW EXECUTE FUNCTION reading_trial.prevent_rewrite();

-- All operational mutations take the same admission lock as controlled deliveries.
-- A remote writer cannot bypass this lock using table grants: it has none.
CREATE FUNCTION reading_trial.replace_policy(p_unit_key text, p_version_key text, p_hierarchy json)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE next_revision bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(10404, 1);
  UPDATE reading_trial.policy SET hierarchy = p_hierarchy
    WHERE deployment_id = 'inc01-synthetic' AND scope_id = 'inc01-material'
      AND unit_key = p_unit_key AND version_key = p_version_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown synthetic pair'; END IF;
  UPDATE reading_trial.control SET revision = revision + 1 RETURNING revision INTO next_revision;
  RETURN next_revision;
END $$;
CREATE FUNCTION reading_trial.set_control(p_generation text, p_active boolean, p_treatment jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE next_revision bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(10404, 1);
  UPDATE reading_trial.control SET generation = p_generation, active = p_active,
    capture_ready = (p_treatment->>'capture')::boolean,
    processing_ready = (p_treatment->>'processing')::boolean,
    conservation_ready = (p_treatment->>'conservation')::boolean,
    trace_ready = (p_treatment->>'trace')::boolean,
    destination_ready = (p_treatment->>'destination')::boolean,
    revision = revision + 1 RETURNING revision INTO next_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing synthetic control'; END IF;
  RETURN next_revision;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reading_trial FROM PUBLIC;
GRANT USAGE ON SCHEMA reading_trial TO inc01_reader, inc01_writer;
GRANT SELECT ON reading_trial.control, reading_trial.material, reading_trial.policy TO inc01_reader;
GRANT INSERT ON reading_trial.access_evidence, reading_trial.transport_observation TO inc01_reader;
GRANT EXECUTE ON FUNCTION reading_trial.replace_policy(text, text, json),
  reading_trial.set_control(text, boolean, jsonb) TO inc01_writer;
COMMIT;
