-- Additive synthetic migration. Render with ci/access_material_schema.mjs.
BEGIN;
CREATE ROLE inc02_material_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc02_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE inc02_synthetic TO inc02_reader;
CREATE SCHEMA material_trial AUTHORIZATION inc02_material_owner;
SET LOCAL ROLE inc02_material_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA material_trial REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
-- MATERIAL_DEFINITION_FROM_INC01
CREATE TABLE material_trial.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
  active boolean NOT NULL DEFAULT false, capture_ready boolean NOT NULL DEFAULT false,
  processing_ready boolean NOT NULL DEFAULT false, conservation_ready boolean NOT NULL DEFAULT false,
  trace_ready boolean NOT NULL DEFAULT false, destination_ready boolean NOT NULL DEFAULT false
);
CREATE TABLE material_trial.surface (
  id text PRIMARY KEY CHECK(id IN ('material-list','material-exact','people')),
  permission_id text NOT NULL, scope_ref text NOT NULL, purpose_ref text NOT NULL,
  enabled boolean NOT NULL, revealable boolean NOT NULL, policy_ready boolean NOT NULL,
  revision bigint NOT NULL CHECK(revision>0)
);
CREATE TABLE material_trial.census_entry (
  account_id uuid PRIMARY KEY, scope_ref text NOT NULL, display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 200),
  source_act text NOT NULL, revision bigint NOT NULL CHECK(revision>0)
);
CREATE TABLE material_trial.census_cursor (
  digest text PRIMARY KEY, account_id uuid NOT NULL, session_digest text NOT NULL,
  population_digest text NOT NULL, position integer NOT NULL CHECK(position>=0),
  expires_at bigint NOT NULL, created_at bigint NOT NULL, CHECK(expires_at>created_at)
);
CREATE TABLE material_trial.evidence (
  id uuid PRIMARY KEY, actor_ref text NOT NULL, session_ref text NOT NULL, surface_ref text NOT NULL,
  purpose_ref text NOT NULL, object_ref json, generation text NOT NULL,
  authority_facts json NOT NULL, result integer NOT NULL CHECK(result IN (200,403,404,503)),
  recorded_at bigint NOT NULL
);
CREATE TABLE material_trial.observation (
  evidence_id uuid PRIMARY KEY REFERENCES material_trial.evidence(id),
  outcome text NOT NULL CHECK(outcome IN ('handed_off','interrupted')), recorded_at bigint NOT NULL
);
CREATE FUNCTION material_trial.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable material record' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_material BEFORE UPDATE OR DELETE ON material_trial.material FOR EACH ROW EXECUTE FUNCTION material_trial.immutable();
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON material_trial.evidence FOR EACH ROW EXECUTE FUNCTION material_trial.immutable();
CREATE TRIGGER immutable_observation BEFORE UPDATE OR DELETE ON material_trial.observation FOR EACH ROW EXECUTE FUNCTION material_trial.immutable();
-- Every admitted invalidator uses the same domain as access effects and reading handoff.
CREATE FUNCTION material_trial.set_control(p_generation text,p_active boolean,p_flags jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_generation IS NULL OR length(p_generation)<16 OR length(p_generation)>128 OR
     jsonb_typeof(p_flags)<>'object' OR NOT p_flags ?& ARRAY['capture','processing','conservation','trace','destination'] THEN
    RAISE EXCEPTION 'Invalid material control'; END IF;
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE material_trial.control SET generation=p_generation,active=p_active,revision=revision+1,
    capture_ready=(p_flags->>'capture')::boolean,processing_ready=(p_flags->>'processing')::boolean,
    conservation_ready=(p_flags->>'conservation')::boolean,trace_ready=(p_flags->>'trace')::boolean,
    destination_ready=(p_flags->>'destination')::boolean;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing material control'; END IF;
  INSERT INTO material_trial.evidence SELECT gen_random_uuid(),session_user,'control','control','synthetic-control',NULL,generation,
    json_build_object('revision',revision),200,floor(extract(epoch FROM clock_timestamp())*1000)::bigint FROM material_trial.control;
END $$;
CREATE FUNCTION material_trial.replace_policy(p_unit text,p_version text,p_hierarchy json) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE material_trial.policy SET hierarchy=p_hierarchy WHERE unit_key=p_unit AND version_key=p_version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown material'; END IF;
  UPDATE material_trial.control SET revision=revision+1;
  INSERT INTO material_trial.evidence SELECT gen_random_uuid(),session_user,'control','policy','synthetic-control',
    json_build_array(p_unit::json,p_version::json),generation,json_build_object('revision',revision),200,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint FROM material_trial.control;
END $$;
CREATE FUNCTION material_trial.set_surface(p_id text,p_enabled boolean,p_policy boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE material_trial.surface SET enabled=p_enabled,policy_ready=p_policy,revision=revision+1 WHERE id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown surface'; END IF;
  UPDATE material_trial.control SET revision=revision+1;
  INSERT INTO material_trial.evidence SELECT gen_random_uuid(),session_user,'control',p_id,'synthetic-control',NULL,generation,
    json_build_object('revision',revision),200,floor(extract(epoch FROM clock_timestamp())*1000)::bigint FROM material_trial.control;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA material_trial FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA material_trial FROM PUBLIC;
GRANT USAGE ON SCHEMA material_trial TO inc02_reader,inc02_runtime,inc02_control;
GRANT SELECT ON material_trial.control,material_trial.surface TO inc02_runtime;
GRANT SELECT ON material_trial.control,material_trial.surface,material_trial.material,material_trial.policy,
  material_trial.census_entry,material_trial.census_cursor TO inc02_reader;
GRANT INSERT,DELETE ON material_trial.census_cursor TO inc02_reader;
GRANT INSERT ON material_trial.evidence,material_trial.observation TO inc02_reader;
GRANT EXECUTE ON FUNCTION material_trial.set_control(text,boolean,jsonb),material_trial.replace_policy(text,text,json),
  material_trial.set_surface(text,boolean,boolean) TO inc02_control;
SET LOCAL ROLE inc02_owner;
CREATE TABLE access_trial.revalidation_event (
  id text PRIMARY KEY, current_until bigint NOT NULL, satisfied boolean NOT NULL, revision integer NOT NULL CHECK(revision>0)
);
CREATE TABLE access_trial.investiture_resolution (
  id text PRIMARY KEY, scope_ref text NOT NULL, permission_id text NOT NULL, selected_id text NOT NULL REFERENCES access_trial.investiture(id),
  source_act text NOT NULL, active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0)
);
-- The technical controller is not an admitted public authority-management route.
CREATE FUNCTION access_trial.end_investiture(p_id text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE updated_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE access_trial.investiture SET active=false,revision=revision+1 WHERE id=p_id RETURNING revision INTO updated_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown declaration'; END IF;
  INSERT INTO access_trial.invitation_event VALUES(gen_random_uuid(),'investiture_end',NULL,session_user,p_id,updated_revision,
    '{"synthetic_control":true}',floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
END $$;
CREATE FUNCTION access_trial.set_revalidation(p_id text,p_until bigint,p_satisfied boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE updated_revision integer;
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE access_trial.revalidation_event SET current_until=p_until,satisfied=p_satisfied,revision=revision+1
    WHERE id=p_id RETURNING revision INTO updated_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown revalidation event'; END IF;
  INSERT INTO access_trial.invitation_event VALUES(gen_random_uuid(),'revalidation',NULL,session_user,p_id,updated_revision,
    '{"synthetic_control":true}',floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
END $$;
REVOKE ALL ON access_trial.revalidation_event,access_trial.investiture_resolution FROM PUBLIC;
REVOKE ALL ON FUNCTION access_trial.end_investiture(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION access_trial.set_revalidation(text,bigint,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION access_trial.end_investiture(text) TO inc02_control;
GRANT EXECUTE ON FUNCTION access_trial.set_revalidation(text,bigint,boolean) TO inc02_control;
GRANT SELECT ON access_trial.revalidation_event,access_trial.investiture_resolution TO inc02_runtime,inc02_reader;
GRANT USAGE ON SCHEMA access_trial TO inc02_reader;
GRANT SELECT ON access_trial.deployment,access_trial.permission_definition,access_trial.scope_definition,access_trial.support_definition,
  access_trial.grant_record,access_trial.investiture,access_trial.incompatibility,access_trial.person_account TO inc02_reader;
GRANT SELECT(id,person_ref,restricted,revision,office) ON access_trial.account TO inc02_reader;
GRANT SELECT(digest,account_id,expires_at,revoked,revision) ON access_trial.session TO inc02_reader;
COMMIT;
