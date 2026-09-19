-- Additive preparation storage. No receipt is manufactured for an editorial intention.
-- This data-only installation can be restored without restoring live authority.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;

CREATE TABLE intake_trial.editorial_effect (
  id uuid PRIMARY KEY,
  principal uuid NOT NULL,
  context jsonb NOT NULL,
  operation text NOT NULL CHECK(operation IN ('reserve_preparation','upload_preparation','finalize_preparation','propose','constitute')),
  reference jsonb NOT NULL,
  result jsonb NOT NULL,
  recorded_at bigint NOT NULL CHECK(recorded_at>0)
);
CREATE TABLE intake_trial.editorial_intention (
  id uuid PRIMARY KEY,
  deployment text NOT NULL CHECK(deployment='inc02-synthetic'),
  principal uuid NOT NULL,
  act text NOT NULL,
  variant text NOT NULL CHECK(variant IN ('reserve_preparation','finalize_preparation','propose','constitute')),
  client_key text NOT NULL,
  canonical_profile text NOT NULL CHECK(canonical_profile='canon_m09_1'),
  digest_key_version integer NOT NULL CHECK(digest_key_version=1),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  effect_id uuid NOT NULL REFERENCES intake_trial.editorial_effect(id) DEFERRABLE INITIALLY DEFERRED,
  recorded_at bigint NOT NULL,
  UNIQUE(deployment,principal,act,variant,client_key)
);
CREATE TABLE intake_trial.preparation_attempt (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES intake_trial.editorial_effect(id) DEFERRABLE INITIALLY DEFERRED,
  principal uuid NOT NULL,
  origin_session text NOT NULL,
  context jsonb NOT NULL,
  reservation jsonb NOT NULL CHECK(octet_length(reservation::text)<=131072),
  preparation_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  staged_id uuid NOT NULL UNIQUE,
  artifact_id uuid NOT NULL UNIQUE,
  declared_bytes integer NOT NULL CHECK(declared_bytes BETWEEN 0 AND 8388608),
  declared_sha256 text NOT NULL CHECK(declared_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('reserved','staged','finalized')),
  recorded_at bigint NOT NULL,
  UNIQUE(preparation_id,revision),
  UNIQUE(id,staged_id,declared_bytes,declared_sha256),
  UNIQUE(id,preparation_id,revision,artifact_id)
);
CREATE TABLE intake_trial.preparation_stage (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES intake_trial.preparation_attempt(id),
  generation integer NOT NULL CHECK(generation=1),
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 8388608),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  body bytea NOT NULL CHECK(octet_length(body)=bytes),
  recorded_at bigint NOT NULL,
  UNIQUE(id,generation,bytes,sha256),
  FOREIGN KEY(attempt_id,id,bytes,sha256)
    REFERENCES intake_trial.preparation_attempt(id,staged_id,declared_bytes,declared_sha256)
);
CREATE TABLE intake_trial.preparation (
  id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  attempt_id uuid NOT NULL UNIQUE REFERENCES intake_trial.preparation_attempt(id),
  principal uuid NOT NULL,
  context jsonb NOT NULL,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  descriptor jsonb NOT NULL CHECK(octet_length(descriptor::text)<=65536),
  artifact_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL CHECK(generation=revision),
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 8388608),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload bytea NOT NULL CHECK(octet_length(payload)=bytes),
  recorded_at bigint NOT NULL,
  PRIMARY KEY(id,revision),
  UNIQUE(id,revision,sha256),
  FOREIGN KEY(id,revision) REFERENCES intake_trial.preparation_attempt(preparation_id,revision),
  FOREIGN KEY(attempt_id,id,revision,artifact_id)
    REFERENCES intake_trial.preparation_attempt(id,preparation_id,revision,artifact_id),
  UNIQUE(artifact_id,generation,bytes,payload_sha256)
);
CREATE TABLE intake_trial.preparation_resource (
  id text NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 8388608),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  body bytea NOT NULL CHECK(octet_length(body)=bytes),
  PRIMARY KEY(id,generation),
  UNIQUE(id,generation,bytes,sha256)
);
CREATE TABLE intake_trial.preparation_resource_association (
  preparation_id uuid NOT NULL,
  preparation_revision integer NOT NULL,
  local_id text NOT NULL,
  element_id text NOT NULL,
  resource_id text NOT NULL,
  resource_generation integer NOT NULL,
  resource_bytes integer NOT NULL,
  resource_sha256 text NOT NULL,
  PRIMARY KEY(preparation_id,preparation_revision,local_id),
  UNIQUE(preparation_id,preparation_revision,element_id),
  FOREIGN KEY(preparation_id,preparation_revision) REFERENCES intake_trial.preparation(id,revision),
  FOREIGN KEY(resource_id,resource_generation,resource_bytes,resource_sha256)
    REFERENCES intake_trial.preparation_resource(id,generation,bytes,sha256)
);
CREATE TABLE intake_trial.preparation_difference (
  id text NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  preparation_id uuid NOT NULL,
  preparation_revision integer NOT NULL,
  body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
  PRIMARY KEY(id,revision),
  FOREIGN KEY(preparation_id,preparation_revision) REFERENCES intake_trial.preparation(id,revision)
);
-- Resource identifiers are opaque text, unlike historical receipt artifacts.
-- A read receipt binds the immutable selected association rather than coercing
-- its resource identifier into the receipt artifact UUID namespace.
CREATE TABLE intake_trial.preparation_resource_read (
  evidence_id uuid PRIMARY KEY REFERENCES intake_trial.evidence(id),
  preparation_id uuid NOT NULL,
  preparation_revision integer NOT NULL,
  local_id text NOT NULL,
  FOREIGN KEY(preparation_id,preparation_revision,local_id)
    REFERENCES intake_trial.preparation_resource_association(preparation_id,preparation_revision,local_id)
);
CREATE TABLE intake_trial.constitution_slot (
  id uuid PRIMARY KEY,
  preparation_id uuid NOT NULL,
  preparation_revision integer NOT NULL,
  unit_key text NOT NULL,
  target_key text NOT NULL,
  allocated_unit_id uuid NOT NULL,
  UNIQUE(preparation_id,preparation_revision,unit_key),
  FOREIGN KEY(preparation_id,preparation_revision) REFERENCES intake_trial.preparation(id,revision)
);
CREATE TABLE intake_trial.preparation_proposal (
  id uuid PRIMARY KEY,
  revision integer NOT NULL CHECK(revision=1),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  slot_id uuid NOT NULL REFERENCES intake_trial.constitution_slot(id),
  principal uuid NOT NULL,
  context jsonb NOT NULL,
  comparison_unit_id uuid,
  body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),
  recorded_at bigint NOT NULL
);
CREATE TABLE intake_trial.constitution_outcome (
  id uuid PRIMARY KEY,
  slot_id uuid NOT NULL UNIQUE REFERENCES intake_trial.constitution_slot(id),
  proposal_id uuid NOT NULL REFERENCES intake_trial.preparation_proposal(id),
  outcome text NOT NULL CHECK(outcome IN ('constituted','relationship_recorded','blocked')),
  block_kind text CHECK(block_kind IN ('identity_collision','possible_duplicate')),
  reference jsonb NOT NULL,
  result jsonb NOT NULL,
  principal uuid NOT NULL,
  context jsonb NOT NULL,
  recorded_at bigint NOT NULL,
  CHECK((outcome='blocked')=(block_kind IS NOT NULL))
);
CREATE TABLE intake_trial.candidate (
  unit_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  outcome_id uuid NOT NULL UNIQUE REFERENCES intake_trial.constitution_outcome(id),
  preparation_id uuid NOT NULL,
  preparation_revision integer NOT NULL,
  unit_key text NOT NULL,
  reference jsonb NOT NULL,
  content_identity text NOT NULL CHECK(content_identity ~ '^[a-f0-9]{64}$'),
  conditions jsonb NOT NULL,
  provenance jsonb NOT NULL,
  editorial_state text NOT NULL CHECK(editorial_state='candidate'),
  PRIMARY KEY(unit_id,version),
  FOREIGN KEY(preparation_id,preparation_revision) REFERENCES intake_trial.preparation(id,revision)
);
CREATE TABLE intake_trial.candidate_relationship (
  outcome_id uuid PRIMARY KEY REFERENCES intake_trial.constitution_outcome(id),
  unit_id uuid NOT NULL,
  version integer NOT NULL,
  provenance jsonb NOT NULL,
  FOREIGN KEY(unit_id,version) REFERENCES intake_trial.candidate(unit_id,version)
);

-- All retained staging, prepared bodies and selected resource bytes count. A
-- failed or abandoned attempt is not silently reclaimed; this is a finite trial.
CREATE TABLE intake_trial.preparation_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  charged_bytes bigint NOT NULL CHECK(charged_bytes BETWEEN 0 AND 67108864)
);
INSERT INTO intake_trial.preparation_capacity VALUES(true,0);
CREATE FUNCTION intake_trial.charge_preparation_bytes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE intake_trial.preparation_capacity SET charged_bytes=charged_bytes+NEW.bytes
    WHERE singleton AND charged_bytes<=67108864-NEW.bytes;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preparation capacity unavailable' USING ERRCODE='53400'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preparation_stage_charge BEFORE INSERT ON intake_trial.preparation_stage
  FOR EACH ROW EXECUTE FUNCTION intake_trial.charge_preparation_bytes();
CREATE TRIGGER preparation_payload_charge BEFORE INSERT ON intake_trial.preparation
  FOR EACH ROW EXECUTE FUNCTION intake_trial.charge_preparation_bytes();
CREATE TRIGGER preparation_resource_charge BEFORE INSERT ON intake_trial.preparation_resource
  FOR EACH ROW EXECUTE FUNCTION intake_trial.charge_preparation_bytes();

CREATE FUNCTION intake_trial.advance_preparation_attempt(target uuid, expected text, next_state text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT ((expected='reserved' AND next_state='staged' AND EXISTS(SELECT 1 FROM intake_trial.preparation_stage WHERE attempt_id=target))
    OR (expected='staged' AND next_state='finalized' AND EXISTS(SELECT 1 FROM intake_trial.preparation WHERE attempt_id=target)))
    THEN RAISE EXCEPTION 'Preparation transition association' USING ERRCODE='23514'; END IF;
  UPDATE intake_trial.preparation_attempt SET state=next_state WHERE id=target AND state=expected;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preparation transition conflict' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION intake_trial.charge_preparation_bytes(),intake_trial.advance_preparation_attempt(uuid,text,text) FROM PUBLIC;
DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['editorial_effect','editorial_intention','preparation_stage','preparation',
    'preparation_resource','preparation_resource_association','preparation_resource_read','preparation_difference',
    'constitution_slot','preparation_proposal','constitution_outcome','candidate','candidate_relationship'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON intake_trial.%I FOR EACH ROW EXECUTE FUNCTION intake_control.immutable()',relation_name);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION intake_trial.advance_preparation_attempt(uuid,text,text) TO inc03_intake_runtime;
REVOKE ALL ON intake_trial.editorial_effect,intake_trial.editorial_intention,intake_trial.preparation_attempt,
  intake_trial.preparation_stage,intake_trial.preparation,intake_trial.preparation_resource,
  intake_trial.preparation_resource_association,intake_trial.preparation_difference,intake_trial.constitution_slot,
  intake_trial.preparation_proposal,intake_trial.constitution_outcome,intake_trial.candidate,
  intake_trial.candidate_relationship,intake_trial.preparation_resource_read,intake_trial.preparation_capacity FROM PUBLIC;
GRANT SELECT,INSERT ON intake_trial.editorial_effect,intake_trial.editorial_intention,intake_trial.preparation_attempt,
  intake_trial.preparation_stage,intake_trial.preparation,intake_trial.preparation_resource,
  intake_trial.preparation_resource_association,intake_trial.preparation_difference,intake_trial.constitution_slot,
  intake_trial.preparation_proposal,intake_trial.constitution_outcome,intake_trial.candidate,
  intake_trial.candidate_relationship,intake_trial.preparation_resource_read TO inc03_intake_runtime;
GRANT SELECT ON intake_trial.editorial_effect,intake_trial.editorial_intention,intake_trial.preparation_attempt,
  intake_trial.preparation_stage,intake_trial.preparation,intake_trial.preparation_resource,
  intake_trial.preparation_resource_association,intake_trial.preparation_difference,intake_trial.constitution_slot,
  intake_trial.preparation_proposal,intake_trial.constitution_outcome,intake_trial.candidate,
  intake_trial.candidate_relationship,intake_trial.preparation_resource_read,intake_trial.preparation_capacity TO inc03_intake_reader;
GRANT SELECT ON intake_trial.preparation_capacity TO inc03_intake_runtime;
COMMIT;
