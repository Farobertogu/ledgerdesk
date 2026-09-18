-- Separate entry for bounded extraction participants. The original reception
-- phase function and its fixed method set are not widened.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;
CREATE TABLE intake_control.extraction_phase_subject (
  phase_id uuid PRIMARY KEY REFERENCES intake_control.private_phase(id),
  job_id uuid NOT NULL, attempt_generation integer NOT NULL CHECK(attempt_generation BETWEEN 1 AND 2),
  channel_id uuid NOT NULL
);
CREATE TRIGGER immutable_extraction_phase_subject BEFORE UPDATE OR DELETE ON intake_control.extraction_phase_subject
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE FUNCTION intake_control.begin_extraction_phase(p_id uuid,p_namespace text,p_evidence uuid,p_source text,p_incarnation text,
  p_job uuid,p_generation integer,p_plan jsonb,p_deadline bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
DECLARE e record; subject record; l intake_control.live%ROWTYPE; phase_epoch bigint;
  at_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF session_user NOT IN ('inc03_intake_runtime','inc03_intake_reader') OR p_namespace NOT IN ('intake_trial','intake_restore')
    THEN RAISE EXCEPTION 'Extraction phase identity' USING ERRCODE='42501'; END IF;
  phase_epoch:=intake_control.no_private_phase();
  SELECT * INTO l FROM intake_control.live WHERE singleton;
  IF NOT FOUND OR NOT l.enabled OR l.source_id<>p_source OR l.incarnation<>p_incarnation OR l.expires_at<=at_ms
    OR p_deadline<=at_ms OR p_deadline>l.expires_at OR NOT EXISTS(SELECT 1 FROM intake_control.namespace_admission n
      WHERE n.namespace=p_namespace AND n.source_id=p_source AND n.generation=l.generation AND n.enabled)
    THEN RAISE EXCEPTION 'Extraction phase current control' USING ERRCODE='55000'; END IF;
  EXECUTE format('SELECT * FROM %I.evidence WHERE id=$1',p_namespace) INTO e USING p_evidence;
  IF e.id IS NULL OR e.phase NOT IN ('read_admission','capture_admission') OR e.backend_pid<>pg_backend_pid()
    OR e.control_revision<>l.revision OR e.status<>200 OR e.recorded_at>at_ms OR e.recorded_at<at_ms-10000
    OR e.reception_id IS NULL OR e.artifact_id IS NULL OR e.generation IS NULL
    THEN RAISE EXCEPTION 'Extraction phase evidence' USING ERRCODE='42501'; END IF;
  EXECUTE format('SELECT j.state,j.attempt_generation,a.channel_id,a.binding,w.original_id,w.generation,w.receipt_id,
    rcp.reception_id,r.principal,r.stopped FROM %I.extraction_job j JOIN %I.extraction_attempt a ON a.job_id=j.id
    AND a.attempt_generation=j.attempt_generation JOIN %I.work w ON w.id=j.id JOIN %I.receipt rcp ON rcp.id=w.receipt_id
    JOIN %I.reception r ON r.id=rcp.reception_id WHERE j.id=$1',p_namespace,p_namespace,p_namespace,p_namespace,p_namespace)
    INTO subject USING p_job;
  IF subject.channel_id IS NULL OR subject.attempt_generation<>p_generation OR subject.original_id IS DISTINCT FROM e.artifact_id
    OR subject.generation IS DISTINCT FROM e.generation OR subject.reception_id IS DISTINCT FROM e.reception_id
    OR subject.stopped
    OR (e.route<>'extraction' AND (subject.principal::text<>e.principal
      OR e.binding->'work'->'id'->>'id' IS DISTINCT FROM p_job::text
      OR (e.binding->'work'->>'generation')::integer IS DISTINCT FROM p_generation))
    THEN RAISE EXCEPTION 'Extraction phase subject' USING ERRCODE='42501'; END IF;
  IF NOT (
    (session_user='inc03_intake_runtime' AND e.route='dispatch_extraction' AND subject.state='claimed'
      AND p_plan='{"objects":["read"],"extraction":["run"]}'::jsonb) OR
    (session_user='inc03_intake_runtime' AND e.route='accept_extraction_result' AND subject.state IN ('running','result_staged','uncertain')
      AND p_plan IN ('{"extraction":["read"],"outputs":["seal"]}'::jsonb,'{"outputs":["read"]}'::jsonb)) OR
    (e.route='extraction' AND subject.state='accepted' AND p_plan='{"outputs":["read"]}'::jsonb))
    THEN RAISE EXCEPTION 'Extraction phase route and methods' USING ERRCODE='42501'; END IF;
  INSERT INTO intake_control.private_phase VALUES(p_id,p_source,p_incarnation,p_namespace,e.reception_id,e.artifact_id,e.generation,
    p_evidence,e.principal,p_plan,session_user,pg_backend_pid(),p_deadline,at_ms);
  INSERT INTO intake_control.extraction_phase_subject VALUES(p_id,p_job,p_generation,subject.channel_id);
  UPDATE intake_control.fence_head SET active_phase=p_id WHERE singleton AND active_phase IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Extraction phase registration changed' USING ERRCODE='40001'; END IF;
  RETURN phase_epoch;
END $$;
REVOKE ALL ON intake_control.extraction_phase_subject FROM PUBLIC;
REVOKE ALL ON FUNCTION intake_control.begin_extraction_phase(uuid,text,uuid,text,text,uuid,integer,jsonb,bigint) FROM PUBLIC;
GRANT SELECT ON intake_control.extraction_phase_subject TO inc03_intake_runtime,inc03_intake_reader,inc03_intake_control;
GRANT EXECUTE ON FUNCTION intake_control.begin_extraction_phase(uuid,text,uuid,text,text,uuid,integer,jsonb,bigint)
  TO inc03_intake_runtime,inc03_intake_reader;
COMMIT;
