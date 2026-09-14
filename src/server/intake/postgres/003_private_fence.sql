-- Current private-work control. Never include these tables in an intake restore.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;
CREATE TABLE intake_control.private_phase (
  id uuid PRIMARY KEY, source_id text NOT NULL, incarnation text NOT NULL,
  namespace text NOT NULL CHECK(namespace IN ('intake_trial','intake_restore')),
  reception_id uuid NOT NULL, artifact_id uuid NOT NULL, generation integer NOT NULL,
  evidence_id uuid NOT NULL, principal text NOT NULL, participant_plan jsonb NOT NULL,
  connection_role text NOT NULL CHECK(connection_role IN ('inc03_intake_runtime','inc03_intake_reader')),
  backend_pid integer NOT NULL, deadline_ms bigint NOT NULL, started_at bigint NOT NULL
);
CREATE TABLE intake_control.fence_head (
  singleton boolean PRIMARY KEY CHECK(singleton), epoch bigint NOT NULL CHECK(epoch>0),
  active_phase uuid REFERENCES intake_control.private_phase(id)
);
INSERT INTO intake_control.fence_head VALUES(true,1,NULL);
CREATE TABLE intake_control.phase_completion (
  phase_id uuid PRIMARY KEY REFERENCES intake_control.private_phase(id),
  kind text NOT NULL CHECK(kind IN ('participants_closed','controller_reconciled')),
  connection_role text NOT NULL, backend_pid integer NOT NULL, observation jsonb NOT NULL,
  completed_at bigint NOT NULL
);
CREATE TRIGGER immutable_private_phase BEFORE UPDATE OR DELETE ON intake_control.private_phase
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_phase_completion BEFORE UPDATE OR DELETE ON intake_control.phase_completion
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();

-- NOWAIT bounds the shared head even for a caller with no configured lock timeout.
-- Updating (not merely reading) it rejects an obsolete REPEATABLE READ snapshot.
CREATE FUNCTION intake_control.no_private_phase() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
DECLARE h intake_control.fence_head%ROWTYPE;
BEGIN
  SELECT * INTO h FROM intake_control.fence_head WHERE singleton FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current fence head unavailable' USING ERRCODE='55000'; END IF;
  IF h.active_phase IS NOT NULL THEN RAISE EXCEPTION 'Private phase unresolved' USING ERRCODE='55P03'; END IF;
  UPDATE intake_control.fence_head SET epoch=epoch+1 WHERE singleton RETURNING epoch INTO h.epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current fence head changed' USING ERRCODE='40001'; END IF;
  RETURN h.epoch;
END $$;
CREATE FUNCTION intake_control.source_mutation_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
BEGIN PERFORM intake_control.no_private_phase(); RETURN NULL; END $$;
CREATE FUNCTION intake_control.guard_reception_mutation(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
BEGIN
  -- Direct function calls must participate too; neither try-lock waits nor upgrades.
  IF NOT pg_try_advisory_xact_lock_shared(20202,1) OR
     NOT pg_try_advisory_xact_lock(20203,hashtext('intake:reception:'||target::text))
    THEN RAISE EXCEPTION 'Reception admission unavailable' USING ERRCODE='55P03'; END IF;
  PERFORM intake_control.no_private_phase();
END $$;
CREATE FUNCTION intake_control.begin_phase(p_id uuid,p_namespace text,p_evidence uuid,p_source text,p_incarnation text,p_plan jsonb,p_deadline bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
DECLARE e record; a record; l intake_control.live%ROWTYPE; phase_epoch bigint; participant text; methods jsonb;
  at_ms bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF session_user NOT IN ('inc03_intake_runtime','inc03_intake_reader') OR p_namespace NOT IN ('intake_trial','intake_restore')
    THEN RAISE EXCEPTION 'Private phase identity' USING ERRCODE='42501'; END IF;
  phase_epoch:=intake_control.no_private_phase();
  SELECT * INTO l FROM intake_control.live WHERE singleton;
  IF NOT FOUND OR NOT l.enabled OR l.source_id<>p_source OR l.incarnation<>p_incarnation OR l.expires_at<=at_ms
    OR p_deadline<=at_ms OR p_deadline>l.expires_at OR NOT EXISTS(SELECT 1 FROM intake_control.namespace_admission n
      WHERE n.namespace=p_namespace AND n.source_id=p_source AND n.generation=l.generation AND n.enabled)
    THEN RAISE EXCEPTION 'Private phase current control' USING ERRCODE='55000'; END IF;
  EXECUTE format('SELECT * FROM %I.evidence WHERE id=$1',p_namespace) INTO e USING p_evidence;
  IF e.id IS NULL OR (e.phase NOT IN ('capture_admission','read_admission') AND NOT(e.phase='effect' AND e.route IN ('cancel_reception','resume_reception'))) OR e.backend_pid<>pg_backend_pid()
    OR e.control_revision<>l.revision OR e.status<>200 OR e.recorded_at>at_ms OR e.recorded_at<at_ms-10000
    OR e.reception_id IS NULL OR e.artifact_id IS NULL OR e.generation IS NULL
    THEN RAISE EXCEPTION 'Private phase evidence' USING ERRCODE='42501'; END IF;
  EXECUTE format('SELECT a.*,r.principal,r.stopped,r.generation AS current_generation FROM %I.attempt a JOIN %I.reception r ON r.id=a.reception_id WHERE a.reception_id=$1 AND a.generation=$2',p_namespace,p_namespace)
    INTO a USING e.reception_id,e.generation;
  IF a.artifact_id IS DISTINCT FROM e.artifact_id OR a.current_generation<>e.generation OR a.principal::text<>e.principal
    OR (a.incarnation<>p_incarnation AND NOT(e.route IN ('cancel_reception','resume_reception') OR
      (e.route IN ('original','finalize_reception') AND a.state='sealed')))
    OR a.stopped OR (e.route='upload_original' AND a.expires_at<=at_ms)
    THEN RAISE EXCEPTION 'Private phase subject' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_plan)<>'object' OR p_plan='{}' OR NOT p_plan?'objects' OR
    EXISTS(SELECT 1 FROM jsonb_object_keys(p_plan) key WHERE key NOT IN ('objects','verifier'))
    THEN RAISE EXCEPTION 'Private phase participants' USING ERRCODE='22023'; END IF;
  FOR participant,methods IN SELECT * FROM jsonb_each(p_plan) LOOP
    IF jsonb_typeof(methods)<>'array' OR jsonb_array_length(methods)=0 OR jsonb_array_length(methods)>6 OR
      EXISTS(SELECT 1 FROM jsonb_array_elements_text(methods) method WHERE
        (participant='objects' AND method NOT IN ('create','append','read_stage','read','seal','fence')) OR
        (participant='verifier' AND method<>'verify')) OR
      (SELECT count(*) FROM jsonb_array_elements_text(methods))<>(SELECT count(DISTINCT m) FROM jsonb_array_elements_text(methods) m)
      THEN RAISE EXCEPTION 'Private phase methods' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (e.route='original' AND p_plan<>'{"objects":["read"]}'::jsonb) OR
    (e.route='finalize_reception' AND p_plan<>'{"objects":["read"]}'::jsonb) OR
    (e.route IN ('cancel_reception','resume_reception') AND p_plan<>'{"objects":["fence"]}'::jsonb) OR
    (e.route='upload_original' AND p_plan NOT IN ('{"objects":["create","append"]}'::jsonb,'{"objects":["create","read_stage","seal"],"verifier":["verify"]}'::jsonb)) OR
    e.route NOT IN ('original','finalize_reception','cancel_reception','resume_reception','upload_original') OR
    (session_user='inc03_intake_reader' AND e.route<>'original')
    THEN RAISE EXCEPTION 'Private phase route' USING ERRCODE='42501'; END IF;
  INSERT INTO intake_control.private_phase VALUES(p_id,p_source,p_incarnation,p_namespace,e.reception_id,e.artifact_id,e.generation,
    p_evidence,e.principal,p_plan,session_user,pg_backend_pid(),CASE WHEN e.route='upload_original' THEN least(p_deadline,a.expires_at) ELSE p_deadline END,at_ms);
  UPDATE intake_control.fence_head SET active_phase=p_id WHERE singleton AND active_phase IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private phase registration changed' USING ERRCODE='40001'; END IF;
  RETURN phase_epoch;
END $$;
CREATE FUNCTION intake_control.finish_phase(p_id uuid,p_source text,p_incarnation text,p_evidence uuid,p_ack jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
DECLARE h intake_control.fence_head%ROWTYPE; p intake_control.private_phase%ROWTYPE; participant text;
BEGIN
  SELECT * INTO h FROM intake_control.fence_head WHERE singleton FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current fence head unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM intake_control.private_phase WHERE id=p_id;
  IF NOT FOUND OR p.source_id<>p_source OR p.incarnation<>p_incarnation OR p.evidence_id<>p_evidence
    OR p.connection_role<>session_user OR p.backend_pid<>pg_backend_pid()
    THEN RAISE EXCEPTION 'Private phase owner' USING ERRCODE='42501'; END IF;
  IF h.active_phase IS DISTINCT FROM p_id THEN
    IF h.active_phase IS NULL AND EXISTS(SELECT 1 FROM intake_control.phase_completion WHERE phase_id=p_id) THEN RETURN h.epoch; END IF;
    RAISE EXCEPTION 'Private phase no longer current' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(p_ack)<>'object' OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_ack) k)
    IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p.participant_plan) k)
    THEN RAISE EXCEPTION 'Private phase acknowledgment set' USING ERRCODE='42501'; END IF;
  FOR participant IN SELECT jsonb_object_keys(p.participant_plan) LOOP
    IF p_ack->participant IS DISTINCT FROM jsonb_build_object('profile','intake-phase-closed/1','id',p_id::text,'participant',participant)
      THEN RAISE EXCEPTION 'Private phase acknowledgment' USING ERRCODE='42501'; END IF;
  END LOOP;
  -- The controlled caller supplies actual selected-channel acknowledgments. SQL
  -- validates their association, not the physical death of a process from JSON.
  INSERT INTO intake_control.phase_completion VALUES(p_id,'participants_closed',session_user,pg_backend_pid(),p_ack,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  UPDATE intake_control.fence_head SET active_phase=NULL,epoch=epoch+1 WHERE singleton AND active_phase=p_id RETURNING epoch INTO h.epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private phase retirement changed' USING ERRCODE='40001'; END IF;
  RETURN h.epoch;
END $$;
CREATE FUNCTION intake_control.assert_fence_epoch(expected bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
DECLARE h intake_control.fence_head%ROWTYPE;
BEGIN
  SELECT * INTO h FROM intake_control.fence_head WHERE singleton FOR UPDATE NOWAIT;
  IF NOT FOUND OR h.active_phase IS NOT NULL OR h.epoch<>expected THEN
    RAISE EXCEPTION 'Admission source changed' USING ERRCODE='40001'; END IF;
  UPDATE intake_control.fence_head SET epoch=epoch+1 WHERE singleton;
END $$;
CREATE FUNCTION intake_control.reconcile_phase(p_id uuid,p_source text,p_incarnation text,p_observation jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
DECLARE h intake_control.fence_head%ROWTYPE; p intake_control.private_phase%ROWTYPE; participant text;
BEGIN
  IF session_user<>'inc03_intake_control' THEN RAISE EXCEPTION 'Private recovery actor' USING ERRCODE='42501'; END IF;
  SELECT * INTO h FROM intake_control.fence_head WHERE singleton FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current fence head unavailable' USING ERRCODE='55000'; END IF;
  SELECT * INTO p FROM intake_control.private_phase WHERE id=p_id;
  IF NOT FOUND OR h.active_phase IS DISTINCT FROM p_id OR p.source_id<>p_source OR p.incarnation<>p_incarnation
    OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=p.backend_pid)
    THEN RAISE EXCEPTION 'Private recovery predecessor' USING ERRCODE='42501'; END IF;
  IF p_observation->>'profile' IS DISTINCT FROM 'intake-controller-closure/1' OR
    p_observation->>'phaseId' IS DISTINCT FROM p.id::text OR
    (p_observation->>'backendPid')::integer IS DISTINCT FROM p.backend_pid OR
    p_observation->>'mode' IS DISTINCT FROM 'runtime-ended-participants-closed' OR
    jsonb_typeof(p_observation->'runtimeProcess') IS DISTINCT FROM 'object' OR
    p_observation->'runtimeProcess'->>'observed' IS DISTINCT FROM 'closed' OR
    (p_observation->'runtimeProcess'->>'pid')::integer IS NULL OR
    p_observation->'runtimeProcess'->>'startTicks' IS NULL OR p_observation->'runtimeProcess'->>'bootId' IS NULL OR
    (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_observation->'participants') k)
      IS DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p.participant_plan) k)
    THEN RAISE EXCEPTION 'Private recovery observation' USING ERRCODE='42501'; END IF;
  FOR participant IN SELECT jsonb_object_keys(p.participant_plan) LOOP
    IF p_observation->'participants'->participant IS DISTINCT FROM
      jsonb_build_object('profile','intake-phase-closed/1','id',p_id::text,'participant',participant)
      THEN RAISE EXCEPTION 'Private recovery participants' USING ERRCODE='42501'; END IF;
  END LOOP;
  -- This record is accepted only through the controlled recovery identity.
  -- Its process fact must originate at the external owned-process observer;
  -- a caller-supplied boolean is not independently verified by this function.
  INSERT INTO intake_control.phase_completion VALUES(p_id,'controller_reconciled',session_user,pg_backend_pid(),p_observation,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
  UPDATE intake_control.fence_head SET active_phase=NULL,epoch=epoch+1 WHERE singleton AND active_phase=p_id RETURNING epoch INTO h.epoch;
  IF NOT FOUND THEN RAISE EXCEPTION 'Private recovery changed' USING ERRCODE='40001'; END IF;
  RETURN h.epoch;
END $$;
REVOKE ALL ON intake_control.private_phase,intake_control.fence_head,intake_control.phase_completion FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA intake_control FROM PUBLIC;
GRANT SELECT ON intake_control.private_phase,intake_control.fence_head,intake_control.phase_completion TO inc03_intake_runtime,inc03_intake_reader,inc03_intake_control;
GRANT EXECUTE ON FUNCTION intake_control.begin_phase(uuid,text,uuid,text,text,jsonb,bigint),
  intake_control.finish_phase(uuid,text,text,uuid,jsonb),intake_control.assert_fence_epoch(bigint)
  TO inc03_intake_runtime,inc03_intake_reader;
GRANT EXECUTE ON FUNCTION intake_control.reconcile_phase(uuid,text,text,jsonb) TO inc03_intake_control;
RESET ROLE;

-- Installation owner creates triggers; no source mutation right is granted to intake.
-- Entire statement coverage is conservative for source-list/snapshot changes.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['deployment','account','session','permission_definition','scope_definition',
    'support_definition','grant_record','investiture','revalidation_event','investiture_resolution','incompatibility'] LOOP
    EXECUTE format('CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON access_trial.%I FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard()',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['live','treatment_current','catalog_entry','profile','namespace_admission'] LOOP
    EXECUTE format('CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON intake_control.%I FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard()',table_name);
  END LOOP;
END $$;
-- These SQL control entries have internal advisory waits before their row trigger.
ALTER FUNCTION access_trial.set_control(boolean,bigint,text) SET lock_timeout='250ms';
ALTER FUNCTION access_trial.restrict_account(uuid,boolean) SET lock_timeout='250ms';
ALTER FUNCTION access_trial.set_support(text,boolean,text) SET lock_timeout='250ms';
ALTER FUNCTION access_trial.end_investiture(text) SET lock_timeout='250ms';
ALTER FUNCTION access_trial.set_revalidation(text,bigint,boolean) SET lock_timeout='250ms';
ALTER FUNCTION intake_control.set_enabled(boolean) SET lock_timeout='250ms';
ALTER FUNCTION intake_control.set_treatment(text,integer,boolean) SET lock_timeout='250ms';
ALTER FUNCTION intake_control.activate_namespace(text,uuid,text) SET lock_timeout='250ms';
COMMIT;
