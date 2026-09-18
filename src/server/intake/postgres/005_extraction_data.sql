-- Additive data migration. Only this namespace token is substituted on restore.
-- Historical work/original generations and intention payloads remain unchanged.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;
CREATE TABLE intake_trial.extraction_job (
  id uuid PRIMARY KEY REFERENCES intake_trial.work(id),
  declaration_id text NOT NULL, declaration_revision integer NOT NULL,
  declaration_sha256 text NOT NULL, format text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('eligible','claimed','running','result_staged','accepted','stopping','stopped','uncertain')),
  attempt_generation integer NOT NULL DEFAULT 0 CHECK(attempt_generation BETWEEN 0 AND 2),
  effect_slot uuid UNIQUE NOT NULL,
  accepted_result uuid UNIQUE,
  created_at bigint NOT NULL,
  CHECK((state='accepted')=(accepted_result IS NOT NULL)),
  CHECK(state NOT IN ('claimed','running','result_staged','accepted') OR attempt_generation>0),
  FOREIGN KEY(declaration_id,declaration_revision,declaration_sha256,format)
    REFERENCES intake_control.processing_declaration(id,revision,sha256,format)
);
CREATE UNIQUE INDEX extraction_one_live_job ON intake_trial.extraction_job((true))
  WHERE state IN ('claimed','running','result_staged','stopping','uncertain');
CREATE TABLE intake_trial.extraction_attempt (
  job_id uuid NOT NULL REFERENCES intake_trial.extraction_job(id),
  attempt_generation integer NOT NULL CHECK(attempt_generation BETWEEN 1 AND 2),
  claim_id uuid UNIQUE NOT NULL, channel_id uuid UNIQUE NOT NULL, dispatch_effect uuid UNIQUE NOT NULL,
  binding jsonb NOT NULL, input_evidence uuid NOT NULL REFERENCES intake_trial.evidence(id),
  deadline_ms bigint NOT NULL, created_at bigint NOT NULL,
  normalized_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY(job_id,attempt_generation), UNIQUE(job_id,attempt_generation,channel_id)
);
CREATE TABLE intake_trial.extraction_event (
  id uuid PRIMARY KEY, job_id uuid NOT NULL, attempt_generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('launch','termination','uncertain','stop_requested','rejected','staged','accepted','reconciled')),
  observation jsonb NOT NULL, evidence_id uuid REFERENCES intake_trial.evidence(id), recorded_at bigint NOT NULL,
  FOREIGN KEY(job_id,attempt_generation) REFERENCES intake_trial.extraction_attempt(job_id,attempt_generation)
);
CREATE UNIQUE INDEX extraction_launch_once ON intake_trial.extraction_event(job_id,attempt_generation) WHERE kind='launch';
CREATE UNIQUE INDEX extraction_termination_once ON intake_trial.extraction_event(job_id,attempt_generation) WHERE kind='termination';
CREATE TABLE intake_trial.extraction_output (
  id uuid PRIMARY KEY, job_id uuid NOT NULL, attempt_generation integer NOT NULL, channel_id uuid NOT NULL,
  raw_id uuid UNIQUE NOT NULL, raw_bytes integer NOT NULL CHECK(raw_bytes BETWEEN 0 AND 41943040),
  raw_sha256 text NOT NULL CHECK(raw_sha256~'^[a-f0-9]{64}$'),
  normalized_id uuid UNIQUE NOT NULL, normalized_bytes integer NOT NULL CHECK(normalized_bytes BETWEEN 0 AND 16777216),
  normalized_sha256 text NOT NULL CHECK(normalized_sha256~'^[a-f0-9]{64}$'),
  bytes integer GENERATED ALWAYS AS(raw_bytes+normalized_bytes) STORED CHECK(bytes<=58720256),
  sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  location_binding text UNIQUE NOT NULL, seal_evidence uuid NOT NULL REFERENCES intake_trial.evidence(id),
  seal_phase uuid NOT NULL REFERENCES intake_control.private_phase(id),created_at bigint NOT NULL,
  CHECK(raw_id<>normalized_id), CHECK(raw_id=channel_id),
  FOREIGN KEY(job_id,attempt_generation,channel_id) REFERENCES intake_trial.extraction_attempt(job_id,attempt_generation,channel_id),
  UNIQUE(job_id,attempt_generation), UNIQUE(id,job_id,attempt_generation)
);
CREATE TABLE intake_trial.extraction_result (
  id uuid PRIMARY KEY, job_id uuid UNIQUE NOT NULL, attempt_generation integer NOT NULL,
  effect_id uuid UNIQUE NOT NULL, output_id uuid UNIQUE NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('completed','partial','failed')),
  evidence_id uuid NOT NULL REFERENCES intake_trial.evidence(id), accepted_at bigint NOT NULL,
  FOREIGN KEY(output_id,job_id,attempt_generation) REFERENCES intake_trial.extraction_output(id,job_id,attempt_generation),
  UNIQUE(id,job_id)
);
ALTER TABLE intake_trial.extraction_job ADD CONSTRAINT extraction_accepted_result
  FOREIGN KEY(accepted_result,id) REFERENCES intake_trial.extraction_result(id,job_id) DEFERRABLE INITIALLY DEFERRED;

-- These structural gates preserve predecessors; current authority is resolved
-- independently by the service. Neither an event nor its hash authenticates IPC.
CREATE FUNCTION intake_trial.claim_extraction(target uuid,expected_revision integer,claim uuid,channel uuid,dispatch uuid,
  expected_binding jsonb,admission_evidence uuid,expiration bigint)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j intake_trial.extraction_job%ROWTYPE; w intake_trial.work%ROWTYPE; e intake_trial.evidence%ROWTYPE;
  at_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  SELECT * INTO j FROM intake_trial.extraction_job WHERE id=target FOR UPDATE;
  IF NOT FOUND OR j.revision<>expected_revision OR j.state<>'eligible' OR j.attempt_generation>=2 OR j.accepted_result IS NOT NULL
    THEN RAISE EXCEPTION 'Extraction claim predecessor' USING ERRCODE='40001'; END IF;
  SELECT * INTO w FROM intake_trial.work WHERE id=target;
  SELECT * INTO e FROM intake_trial.evidence WHERE id=admission_evidence;
  IF w.state='stopped' OR EXISTS(SELECT 1 FROM intake_trial.reception r JOIN intake_trial.receipt rcp ON rcp.reception_id=r.id
      WHERE rcp.id=w.receipt_id AND r.stopped) OR expiration<=at_ms
    OR e.id IS NULL OR e.phase<>'read_admission' OR e.route<>'dispatch_extraction' OR e.status<>200 OR e.backend_pid<>pg_backend_pid()
    OR e.artifact_id IS DISTINCT FROM w.original_id OR e.generation IS DISTINCT FROM w.generation
    OR expected_binding->'job'->>'id' IS DISTINCT FROM target::text
    OR expected_binding->'receipt'->>'id' IS DISTINCT FROM w.receipt_id::text
    OR expected_binding->'original'->>'id' IS DISTINCT FROM w.original_id::text
    OR (expected_binding->'original'->>'generation')::integer IS DISTINCT FROM w.generation
    OR (expected_binding->>'attempt_generation')::integer IS DISTINCT FROM j.attempt_generation+1
    OR expected_binding->>'claim_id' IS DISTINCT FROM claim::text OR expected_binding->>'channel_id' IS DISTINCT FROM channel::text
    OR expected_binding->'dispatch_effect'->>'id' IS DISTINCT FROM dispatch::text
    THEN RAISE EXCEPTION 'Extraction claim association' USING ERRCODE='42501'; END IF;
  IF j.attempt_generation>0 AND NOT EXISTS(SELECT 1 FROM intake_trial.extraction_event x
    WHERE x.job_id=target AND x.attempt_generation=j.attempt_generation AND x.kind='termination'
      AND x.observation->>'observed'='closed') THEN
    RAISE EXCEPTION 'Extraction predecessor closure unknown' USING ERRCODE='55000'; END IF;
  -- A shared phase controller also limits actual executions. This lock precedes
  -- the snapshot in the service; the index/predecessor remains independent.
  IF EXISTS(SELECT 1 FROM intake_trial.extraction_job WHERE id<>target AND state IN ('claimed','running','result_staged','stopping','uncertain'))
    THEN RAISE EXCEPTION 'Extraction capacity occupied' USING ERRCODE='55P03'; END IF;
  UPDATE intake_trial.extraction_job SET state='claimed',revision=revision+1,attempt_generation=attempt_generation+1
    WHERE id=target RETURNING * INTO j;
  INSERT INTO intake_trial.extraction_attempt(job_id,attempt_generation,claim_id,channel_id,dispatch_effect,binding,input_evidence,deadline_ms,created_at)
    VALUES(target,j.attempt_generation,claim,channel,dispatch,expected_binding,admission_evidence,expiration,at_ms);
  RETURN j.attempt_generation;
END $$;

CREATE FUNCTION intake_trial.advance_extraction(target uuid,expected_revision integer,expected_generation integer,expected_state text,next_state text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE next_revision integer;
BEGIN
  IF NOT ((expected_state='claimed' AND next_state IN ('running','stopping','uncertain')) OR
    (expected_state='running' AND next_state IN ('result_staged','stopping','uncertain','eligible')) OR
    (expected_state='result_staged' AND next_state IN ('stopping','uncertain')) OR
    (expected_state='eligible' AND next_state='stopping') OR
    (expected_state='stopping' AND next_state IN ('stopped','uncertain')) OR
    (expected_state='uncertain' AND next_state IN ('eligible','running','result_staged','stopping')))
    THEN RAISE EXCEPTION 'Extraction transition' USING ERRCODE='22023'; END IF;
  IF (next_state='running' AND NOT EXISTS(SELECT 1 FROM intake_trial.extraction_event WHERE job_id=target
      AND attempt_generation=expected_generation AND kind='launch')) OR
    (next_state IN ('result_staged','eligible','stopped') AND expected_generation>0 AND NOT EXISTS(
      SELECT 1 FROM intake_trial.extraction_event WHERE job_id=target AND attempt_generation=expected_generation
      AND kind='termination' AND observation->>'observed'='closed')) OR
    (next_state='result_staged' AND NOT EXISTS(SELECT 1 FROM intake_trial.extraction_output WHERE job_id=target AND attempt_generation=expected_generation))
    THEN RAISE EXCEPTION 'Extraction transition observation' USING ERRCODE='55000'; END IF;
  IF next_state='eligible' AND (expected_generation>=2 OR EXISTS(
      SELECT 1 FROM intake_trial.extraction_output WHERE job_id=target) OR EXISTS(
      SELECT 1 FROM intake_control.fence_head WHERE active_phase IS NOT NULL) OR NOT EXISTS(
      SELECT 1 FROM intake_trial.extraction_event e JOIN intake_trial.extraction_attempt a
        ON a.job_id=e.job_id AND a.attempt_generation=e.attempt_generation
      WHERE e.job_id=target AND e.attempt_generation=expected_generation AND e.kind='termination'
        AND e.observation->>'observed'='closed' AND e.observation->>'reason'='input_failure'
        AND e.observation->>'channelId'=a.channel_id::text)) THEN
    RAISE EXCEPTION 'Extraction retry predecessor' USING ERRCODE='55000'; END IF;
  UPDATE intake_trial.extraction_job SET state=next_state,revision=revision+1 WHERE id=target AND revision=expected_revision
    AND attempt_generation=expected_generation AND state=expected_state AND accepted_result IS NULL RETURNING revision INTO next_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extraction predecessor changed' USING ERRCODE='40001'; END IF;
  RETURN next_revision;
END $$;
CREATE FUNCTION intake_trial.accept_extraction(target uuid,expected_revision integer,result_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  UPDATE intake_trial.extraction_job j SET state='accepted',accepted_result=r.id,revision=j.revision+1
    FROM intake_trial.extraction_result r,intake_trial.evidence e
    WHERE j.id=target AND j.revision=expected_revision AND j.state IN ('result_staged','uncertain') AND j.accepted_result IS NULL
      AND r.id=result_id AND r.job_id=j.id AND r.attempt_generation=j.attempt_generation AND r.effect_id=j.effect_slot
      AND e.id=r.evidence_id AND e.phase='effect' AND e.route='accept_extraction_result' AND e.status=200
      AND e.backend_pid=pg_backend_pid();
  IF NOT FOUND THEN RAISE EXCEPTION 'Extraction acceptance predecessor' USING ERRCODE='40001'; END IF;
END $$;
CREATE FUNCTION intake_trial.consistent_extraction() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM intake_trial.extraction_result r JOIN intake_trial.extraction_job j ON j.id=r.job_id
    JOIN intake_trial.extraction_attempt a ON a.job_id=r.job_id AND a.attempt_generation=r.attempt_generation
    JOIN intake_trial.extraction_output o ON o.id=r.output_id JOIN intake_trial.evidence e ON e.id=r.evidence_id
    JOIN intake_trial.work w ON w.id=j.id
    WHERE j.accepted_result IS DISTINCT FROM r.id OR j.state<>'accepted' OR r.effect_id<>j.effect_slot
      OR j.attempt_generation<>r.attempt_generation OR o.channel_id<>a.channel_id
      OR e.artifact_id IS DISTINCT FROM w.original_id OR e.generation IS DISTINCT FROM w.generation
      OR e.phase<>'effect' OR e.route<>'accept_extraction_result' OR e.status<>200)
    THEN RAISE EXCEPTION 'Incomplete extraction association' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE FUNCTION intake_trial.extraction_output_phase() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- Restoring a historical row is not sealing it again under a fabricated PID.
  -- Only the retained cut's administration identity may insert the exact row.
  -- Runtime cannot create or replace this cut, and all foreign keys still apply.
  IF TG_TABLE_SCHEMA='intake_restore' AND EXISTS(
    SELECT 1 FROM intake_control.extraction_restore_output o
    JOIN intake_control.extraction_restore_cut c USING(anchor_id)
    JOIN intake_control.backup_anchor a ON a.id=c.anchor_id
    JOIN intake_control.live l ON l.source_id=a.source_id
    WHERE c.target_namespace=TG_TABLE_SCHEMA AND c.creator_role=session_user
      AND o.output_id=NEW.id AND (o.original_row-'bytes')=(to_jsonb(NEW)-'bytes')
      AND l.enabled AND l.expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
    THEN RETURN NEW; END IF;
  IF NOT EXISTS(SELECT 1 FROM intake_control.private_phase p
    JOIN intake_control.phase_completion c ON c.phase_id=p.id
    JOIN intake_control.extraction_phase_subject s ON s.phase_id=p.id
    JOIN intake_trial.evidence e ON e.id=p.evidence_id
    WHERE p.id=NEW.seal_phase AND p.namespace='intake_trial' AND p.connection_role=session_user AND p.backend_pid=pg_backend_pid()
      AND c.kind='participants_closed' AND p.participant_plan='{"extraction":["read"],"outputs":["seal"]}'::jsonb
      AND s.job_id=NEW.job_id AND s.attempt_generation=NEW.attempt_generation AND s.channel_id=NEW.channel_id
      AND e.id=NEW.seal_evidence AND e.route='accept_extraction_result' AND e.phase='read_admission' AND e.status=200)
    THEN RAISE EXCEPTION 'Extraction output phase association' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extraction_output_phase BEFORE INSERT ON intake_trial.extraction_output
  FOR EACH ROW EXECUTE FUNCTION intake_trial.extraction_output_phase();
CREATE CONSTRAINT TRIGGER extraction_association AFTER INSERT ON intake_trial.extraction_result
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION intake_trial.consistent_extraction();
CREATE CONSTRAINT TRIGGER extraction_job_association AFTER INSERT OR UPDATE ON intake_trial.extraction_job
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION intake_trial.consistent_extraction();

DO $$ DECLARE relation_name text; BEGIN
  FOREACH relation_name IN ARRAY ARRAY['extraction_attempt','extraction_event','extraction_output','extraction_result'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON intake_trial.%I FOR EACH ROW EXECUTE FUNCTION intake_control.immutable()',relation_name);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION intake_trial.claim_extraction(uuid,integer,uuid,uuid,uuid,jsonb,uuid,bigint),
  intake_trial.advance_extraction(uuid,integer,integer,text,text),intake_trial.accept_extraction(uuid,integer,uuid),
  intake_trial.consistent_extraction(),intake_trial.extraction_output_phase() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_trial.claim_extraction(uuid,integer,uuid,uuid,uuid,jsonb,uuid,bigint),
  intake_trial.advance_extraction(uuid,integer,integer,text,text),intake_trial.accept_extraction(uuid,integer,uuid) TO inc03_intake_runtime;
GRANT SELECT ON intake_trial.extraction_job,intake_trial.extraction_attempt,intake_trial.extraction_event,
  intake_trial.extraction_output,intake_trial.extraction_result TO inc03_intake_runtime,inc03_intake_reader;
GRANT INSERT(id,declaration_id,declaration_revision,declaration_sha256,format,state,effect_slot,created_at)
  ON intake_trial.extraction_job TO inc03_intake_runtime;
GRANT INSERT ON intake_trial.extraction_event,intake_trial.extraction_output,intake_trial.extraction_result TO inc03_intake_runtime;
COMMIT;
