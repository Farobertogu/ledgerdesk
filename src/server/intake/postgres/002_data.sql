-- Data-only schema. The restore installer substitutes this exact namespace token,
-- never a control, session, authority, catalog or treatment table.
BEGIN;
CREATE SCHEMA intake_trial AUTHORIZATION inc03_intake_owner;
SET LOCAL ROLE inc03_intake_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA intake_trial REVOKE ALL ON TABLES FROM PUBLIC;
CREATE TABLE intake_trial.reception (
  id uuid PRIMARY KEY, deployment text NOT NULL CHECK(deployment='inc02-synthetic'), principal uuid NOT NULL,
  person_ref text NOT NULL, origin_session text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  generation integer NOT NULL DEFAULT 1 CHECK(generation BETWEEN 1 AND 3), state text NOT NULL
    CHECK(state IN ('reserved','receiving','staged','received','interrupted','stopped','uncertain')),
  declaration jsonb NOT NULL, format text NOT NULL, context jsonb NOT NULL, load_reference jsonb NOT NULL,
  configuration jsonb NOT NULL, effect_slot uuid UNIQUE NOT NULL, stopped boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL, UNIQUE(deployment,id)
);
CREATE TABLE intake_trial.intention (
  id uuid PRIMARY KEY, deployment text NOT NULL CHECK(deployment='inc02-synthetic'), principal uuid NOT NULL,
  act text NOT NULL, variant text NOT NULL, client_key text NOT NULL, canonical_profile text NOT NULL CHECK(canonical_profile='canon_m09_1'),
  key_version integer NOT NULL CHECK(key_version=1), payload_digest text NOT NULL CHECK(payload_digest~'^[a-f0-9]{64}$'),
  reception_id uuid NOT NULL REFERENCES intake_trial.reception(id), effect_id uuid,
  created_at bigint NOT NULL, UNIQUE(deployment,principal,act,variant,client_key)
);
CREATE TABLE intake_trial.attempt (
  reception_id uuid NOT NULL REFERENCES intake_trial.reception(id), generation integer NOT NULL CHECK(generation BETWEEN 1 AND 3),
  artifact_id uuid UNIQUE NOT NULL, incarnation text NOT NULL, state text NOT NULL CHECK(state IN ('reserved','receiving','sealed','interrupted','fenced')),
  expires_at bigint NOT NULL, reserved_bytes integer NOT NULL CHECK(reserved_bytes BETWEEN 0 AND 1048576),
  actual_bytes integer NOT NULL DEFAULT 0 CHECK(actual_bytes BETWEEN 0 AND 1048576), actual_sha256 text,
  PRIMARY KEY(reception_id,generation), UNIQUE(reception_id,generation,artifact_id)
);
CREATE TABLE intake_trial.artifact (
  id uuid PRIMARY KEY, reception_id uuid NOT NULL, generation integer NOT NULL,
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 1048576), sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  format text NOT NULL, location_binding text NOT NULL UNIQUE, verification jsonb NOT NULL,
  created_at bigint NOT NULL, FOREIGN KEY(reception_id,generation,id) REFERENCES intake_trial.attempt(reception_id,generation,artifact_id),
  UNIQUE(reception_id,generation,id,bytes,sha256)
);
CREATE TABLE intake_trial.evidence (
  id uuid PRIMARY KEY, phase text NOT NULL CHECK(phase IN ('capture_admission','read_admission','effect','delivery','query')),
  operation_id uuid, reception_id uuid, artifact_id uuid, generation integer,
  principal text NOT NULL, route text NOT NULL, control_revision integer NOT NULL,
  binding jsonb NOT NULL, status integer NOT NULL, recorded_at bigint NOT NULL, backend_pid integer NOT NULL
);
CREATE TABLE intake_trial.receipt (
  id uuid PRIMARY KEY, reception_id uuid UNIQUE NOT NULL REFERENCES intake_trial.reception(id),
  operation_id uuid UNIQUE NOT NULL REFERENCES intake_trial.intention(id), effect_id uuid UNIQUE NOT NULL,
  artifact_id uuid NOT NULL, generation integer NOT NULL, bytes integer NOT NULL, sha256 text NOT NULL,
  person_ref text NOT NULL, executor_ref text NOT NULL CHECK(executor_ref<>person_ref), load_reference jsonb NOT NULL,
  evidence_id uuid NOT NULL REFERENCES intake_trial.evidence(id), created_at bigint NOT NULL,
  FOREIGN KEY(reception_id,generation,artifact_id,bytes,sha256) REFERENCES intake_trial.artifact(reception_id,generation,id,bytes,sha256),
  UNIQUE(id,artifact_id,generation)
);
CREATE TABLE intake_trial.work (
  id uuid PRIMARY KEY, receipt_id uuid UNIQUE NOT NULL, original_id uuid NOT NULL, generation integer NOT NULL,
  request jsonb NOT NULL, plan jsonb NOT NULL, originating_act jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('not_started','stopped')), dispatchable boolean NOT NULL DEFAULT false CHECK(NOT dispatchable),
  FOREIGN KEY(receipt_id,original_id,generation) REFERENCES intake_trial.receipt(id,artifact_id,generation)
);
CREATE TABLE intake_trial.availability (
  id uuid PRIMARY KEY, artifact_id uuid NOT NULL REFERENCES intake_trial.artifact(id),
  outcome text NOT NULL CHECK(outcome IN ('available','missing','corrupt')), recorded_at bigint NOT NULL
);
CREATE TABLE intake_trial.transport (
  id uuid PRIMARY KEY, evidence_id uuid NOT NULL REFERENCES intake_trial.evidence(id),
  outcome text NOT NULL CHECK(outcome IN ('handed_off','interrupted','observation_failed')), bytes integer NOT NULL CHECK(bytes>=0), recorded_at bigint NOT NULL
);
CREATE TRIGGER immutable_artifact BEFORE UPDATE OR DELETE ON intake_trial.artifact FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON intake_trial.receipt FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON intake_trial.evidence FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_availability BEFORE UPDATE OR DELETE ON intake_trial.availability FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_transport BEFORE UPDATE OR DELETE ON intake_trial.transport FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_intention BEFORE UPDATE OR DELETE ON intake_trial.intention FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
-- These functions preserve conditional predecessors. They do not authorize the caller's act.
CREATE FUNCTION intake_trial.record_chunk(target uuid,attempt_generation integer,previous_bytes integer,next_bytes integer,completed_phase uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM intake_control.private_phase p JOIN intake_control.phase_completion c ON c.phase_id=p.id
    JOIN intake_trial.attempt a ON a.reception_id=p.reception_id AND a.generation=p.generation AND a.artifact_id=p.artifact_id
    WHERE p.id=completed_phase AND p.namespace='intake_trial' AND p.reception_id=target AND p.generation=attempt_generation
    AND p.connection_role=session_user AND p.backend_pid=pg_backend_pid() AND c.kind='participants_closed'
    AND p.participant_plan='{"objects":["create","append"]}'::jsonb)
    THEN RAISE EXCEPTION 'Chunk phase association' USING ERRCODE='42501'; END IF;
  IF next_bytes<=previous_bytes OR next_bytes-previous_bytes>65536 THEN RAISE EXCEPTION 'Invalid chunk' USING ERRCODE='22023'; END IF;
  UPDATE intake_trial.attempt a SET state='receiving',actual_bytes=next_bytes FROM intake_trial.reception r
    WHERE a.reception_id=target AND a.generation=attempt_generation AND a.actual_bytes=previous_bytes
    AND a.state IN ('reserved','receiving') AND next_bytes<=a.reserved_bytes
    AND r.id=a.reception_id AND r.generation=a.generation AND NOT r.stopped AND r.state IN ('reserved','receiving');
  IF NOT FOUND THEN RAISE EXCEPTION 'Chunk predecessor changed' USING ERRCODE='40001'; END IF;
  UPDATE intake_trial.reception SET state='receiving' WHERE id=target;
END $$;
CREATE FUNCTION intake_trial.stage_attempt(target uuid,attempt_generation integer,expected_revision integer,observed_digest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE intake_trial.attempt a SET state='sealed',actual_sha256=observed_digest FROM intake_trial.reception r,intake_trial.artifact o
    WHERE a.reception_id=target AND a.generation=attempt_generation AND r.id=target AND r.generation=a.generation
    AND r.revision=expected_revision AND NOT r.stopped AND r.state IN ('reserved','receiving')
    AND a.state IN ('reserved','receiving') AND a.actual_bytes=a.reserved_bytes
    AND o.id=a.artifact_id AND o.reception_id=target AND o.generation=a.generation
    AND o.bytes=a.reserved_bytes AND o.sha256=observed_digest AND observed_digest=r.declaration->>'sha256';
  IF NOT FOUND THEN RAISE EXCEPTION 'Stage predecessor changed' USING ERRCODE='40001'; END IF;
  UPDATE intake_trial.reception SET state='staged',revision=revision+1 WHERE id=target;
END $$;
CREATE FUNCTION intake_trial.complete_reception(target uuid,attempt_generation integer,expected_revision integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE intake_trial.reception r SET state='received',revision=revision+1
    WHERE r.id=target AND r.generation=attempt_generation AND r.revision=expected_revision AND r.state='staged' AND NOT r.stopped
    AND EXISTS(SELECT 1 FROM intake_trial.receipt e JOIN intake_trial.work j ON j.receipt_id=e.id
      WHERE e.reception_id=r.id AND e.generation=r.generation AND e.effect_id=r.effect_slot);
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt predecessor changed' USING ERRCODE='40001'; END IF;
END $$;
CREATE FUNCTION intake_trial.stop_reception(target uuid,attempt_generation integer,expected_revision integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM intake_control.guard_reception_mutation(target);
  UPDATE intake_trial.reception SET stopped=true,state='stopped',revision=revision+1
    WHERE id=target AND generation=attempt_generation AND revision=expected_revision AND NOT stopped;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stop predecessor changed' USING ERRCODE='40001'; END IF;
  UPDATE intake_trial.attempt SET state='fenced' WHERE reception_id=target AND generation=attempt_generation AND state<>'sealed';
  UPDATE intake_trial.work SET state='stopped' WHERE receipt_id IN(SELECT id FROM intake_trial.receipt WHERE reception_id=target);
END $$;
CREATE FUNCTION intake_trial.resume_attempt(target uuid,previous_generation integer,expected_revision integer,next_artifact uuid,next_incarnation text,expiration bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected_bytes integer;
BEGIN
  PERFORM intake_control.guard_reception_mutation(target);
  UPDATE intake_trial.reception SET state='reserved',revision=revision+1,generation=generation+1
    WHERE id=target AND generation=previous_generation AND revision=expected_revision AND generation<3 AND NOT stopped
    AND state IN ('reserved','receiving','interrupted') AND NOT EXISTS(SELECT 1 FROM intake_trial.receipt WHERE reception_id=target)
    RETURNING (declaration->>'bytes')::integer INTO expected_bytes;
  IF NOT FOUND THEN RAISE EXCEPTION 'Resume predecessor changed' USING ERRCODE='40001'; END IF;
  UPDATE intake_trial.attempt SET state='fenced' WHERE reception_id=target AND generation=previous_generation;
  INSERT INTO intake_trial.attempt VALUES(target,previous_generation+1,next_artifact,next_incarnation,'reserved',expiration,expected_bytes,0,NULL);
END $$;
-- Bookkeeping for an actually owned transfer that ended without staging. This
-- does not authorize another read, resume, promotion or effect.
CREATE FUNCTION intake_trial.record_incomplete(target uuid,attempt_generation integer,owner_incarnation text,origin_digest text,unresolved boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE intake_trial.reception r SET state=CASE WHEN unresolved THEN 'uncertain' ELSE 'interrupted' END,revision=revision+1
    WHERE r.id=target AND r.generation=attempt_generation AND r.origin_session=origin_digest AND NOT r.stopped
    AND r.state IN ('reserved','receiving')
    AND EXISTS(SELECT 1 FROM intake_trial.attempt a WHERE a.reception_id=r.id AND a.generation=r.generation
      AND a.incarnation=owner_incarnation AND a.state IN ('reserved','receiving'))
    AND NOT EXISTS(SELECT 1 FROM intake_trial.receipt e WHERE e.reception_id=r.id);
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE intake_trial.attempt SET state='interrupted' WHERE reception_id=target AND generation=attempt_generation;
  RETURN true;
END $$;
CREATE FUNCTION intake_trial.consistent_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM intake_trial.receipt e JOIN intake_trial.reception r ON r.id=e.reception_id
    JOIN intake_trial.intention i ON i.id=e.operation_id JOIN intake_trial.evidence v ON v.id=e.evidence_id
    WHERE e.effect_id<>r.effect_slot OR i.effect_id IS DISTINCT FROM e.effect_id OR i.reception_id<>r.id
    OR i.principal<>r.principal OR i.variant<>'finalize_reception' OR e.person_ref<>r.person_ref
    OR e.load_reference->'original'->>'id'<>e.artifact_id::text
    OR (e.load_reference->'original'->>'generation')::integer<>e.generation
    OR v.phase<>'effect' OR v.operation_id IS DISTINCT FROM i.id OR v.artifact_id IS DISTINCT FROM e.artifact_id
    OR v.generation IS DISTINCT FROM e.generation OR v.principal<>r.principal::text OR v.status<>200
    OR r.state NOT IN ('received','stopped')
    OR NOT EXISTS(SELECT 1 FROM intake_trial.work j WHERE j.receipt_id=e.id AND j.id<>e.operation_id))
    OR EXISTS(SELECT 1 FROM intake_trial.reception r WHERE r.state='received'
      AND NOT EXISTS(SELECT 1 FROM intake_trial.receipt e WHERE e.reception_id=r.id))
    THEN RAISE EXCEPTION 'Incomplete receipt association' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_association AFTER INSERT ON intake_trial.receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION intake_trial.consistent_receipt();
CREATE CONSTRAINT TRIGGER reception_association AFTER INSERT OR UPDATE ON intake_trial.reception DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION intake_trial.consistent_receipt();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA intake_trial FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_trial.record_chunk(uuid,integer,integer,integer,uuid),intake_trial.stage_attempt(uuid,integer,integer,text),
  intake_trial.complete_reception(uuid,integer,integer),intake_trial.stop_reception(uuid,integer,integer),
  intake_trial.resume_attempt(uuid,integer,integer,uuid,text,bigint),
  intake_trial.record_incomplete(uuid,integer,text,text,boolean) TO inc03_intake_runtime;
GRANT USAGE ON SCHEMA intake_trial TO inc03_intake_runtime,inc03_intake_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA intake_trial TO inc03_intake_runtime,inc03_intake_reader;
GRANT INSERT ON intake_trial.reception,intake_trial.intention,intake_trial.attempt,intake_trial.artifact,
  intake_trial.receipt,intake_trial.work,intake_trial.evidence,intake_trial.availability,intake_trial.transport TO inc03_intake_runtime;
GRANT INSERT ON intake_trial.evidence,intake_trial.availability,intake_trial.transport TO inc03_intake_reader;
-- No direct UPDATE, DELETE, ownership, authority mutation, original rewrite or session write.
COMMIT;
