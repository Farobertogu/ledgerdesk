-- Current control is deliberately outside the intake data restore set.
BEGIN;
CREATE ROLE inc03_intake_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc03_intake_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc03_intake_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc03_intake_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE inc02_synthetic TO inc03_intake_runtime,inc03_intake_reader,inc03_intake_control;
CREATE SCHEMA intake_control AUTHORIZATION inc03_intake_owner;
SET LOCAL ROLE inc03_intake_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA intake_control REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
CREATE TABLE intake_control.live (
  singleton boolean PRIMARY KEY CHECK(singleton), source_id text UNIQUE NOT NULL,
  enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL CHECK(revision>0),
  generation integer NOT NULL CHECK(generation>0), incarnation text NOT NULL,
  catalog jsonb NOT NULL, configuration jsonb NOT NULL, limits jsonb NOT NULL,
  expires_at bigint NOT NULL CHECK(expires_at>0)
);
CREATE TABLE intake_control.catalog_entry (
  operation text PRIMARY KEY, catalog jsonb NOT NULL, entry_revision integer NOT NULL CHECK(entry_revision>0),
  definition jsonb NOT NULL, signature jsonb NOT NULL, source_comparison jsonb NOT NULL,
  permission_id text NOT NULL, scope_ref text NOT NULL, purpose_ref text NOT NULL,
  partition text NOT NULL CHECK(partition IN ('personal_load','own_record','whole_original','visible_surfaces')),
  route_reference jsonb NOT NULL, active boolean NOT NULL DEFAULT false
);
CREATE TABLE intake_control.treatment (
  id text NOT NULL, revision integer NOT NULL CHECK(revision>0), sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  scope_ref text NOT NULL, purpose_ref text NOT NULL, fields text[] NOT NULL,
  actions text[] NOT NULL, receiver jsonb NOT NULL, storage jsonb NOT NULL, processor jsonb NOT NULL,
  response_destination jsonb NOT NULL, disposition_ref text NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>0),
  PRIMARY KEY(id,revision)
);
CREATE TABLE intake_control.treatment_current (
  singleton boolean PRIMARY KEY CHECK(singleton), id text NOT NULL, revision integer NOT NULL,
  enabled boolean NOT NULL DEFAULT false, FOREIGN KEY(id,revision) REFERENCES intake_control.treatment(id,revision)
);
CREATE TABLE intake_control.profile (
  format text PRIMARY KEY CHECK(format IN ('text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1')),
  configuration jsonb NOT NULL, revealable boolean NOT NULL DEFAULT false,
  reception_enabled boolean NOT NULL DEFAULT false,
  processing_request jsonb NOT NULL, processing_plan jsonb NOT NULL
);
CREATE TABLE intake_control.backup_anchor (
  id uuid PRIMARY KEY, source_id text NOT NULL, manifest_sha256 text NOT NULL CHECK(manifest_sha256~'^[a-f0-9]{64}$'),
  members jsonb NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE intake_control.namespace_admission (
  namespace text PRIMARY KEY CHECK(namespace IN ('intake_trial','intake_restore')),
  source_id text NOT NULL REFERENCES intake_control.live(source_id),
  generation integer NOT NULL CHECK(generation>0), backup_anchor uuid REFERENCES intake_control.backup_anchor(id),
  enabled boolean NOT NULL DEFAULT false,
  CHECK(namespace<>'intake_restore' OR backup_anchor IS NOT NULL)
);
CREATE TABLE intake_control.observation (
  id uuid PRIMARY KEY, action text NOT NULL, source_id text NOT NULL, revision integer NOT NULL,
  recorded_at bigint NOT NULL, subject_ref text
);
CREATE FUNCTION intake_control.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable intake record' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_anchor BEFORE UPDATE OR DELETE ON intake_control.backup_anchor FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_treatment BEFORE UPDATE OR DELETE ON intake_control.treatment FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_entry BEFORE UPDATE OR DELETE ON intake_control.catalog_entry FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_control_observation BEFORE UPDATE OR DELETE ON intake_control.observation FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE FUNCTION intake_control.set_enabled(admitted boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE intake_control.live SET enabled=admitted,revision=revision+1;
  INSERT INTO intake_control.observation SELECT gen_random_uuid(),'control',source_id,revision,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,NULL FROM intake_control.live;
END $$;
CREATE FUNCTION intake_control.set_treatment(treatment_id text,treatment_revision integer,admitted boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE intake_control.treatment_current SET id=treatment_id,revision=treatment_revision,enabled=admitted;
  UPDATE intake_control.live SET revision=revision+1;
  INSERT INTO intake_control.observation SELECT gen_random_uuid(),'treatment',source_id,revision,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,treatment_id FROM intake_control.live;
END $$;
CREATE FUNCTION intake_control.activate_namespace(target text,anchor_id uuid,expected_manifest text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  -- One-way admission of a fresh, verified target. It cannot replace a live namespace.
  -- A controller can retain an existing shared current-authority admission through this insert.
  PERFORM pg_advisory_xact_lock_shared(20202,1);
  IF target<>'intake_restore' OR NOT EXISTS(SELECT 1 FROM intake_control.backup_anchor a
    JOIN intake_control.live l USING(source_id) WHERE a.id=anchor_id AND a.manifest_sha256=expected_manifest AND l.enabled)
    THEN RAISE EXCEPTION 'Restore anchor unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO intake_control.namespace_admission SELECT target,source_id,generation,anchor_id,true FROM intake_control.live
    ON CONFLICT(namespace) DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'Restore target already admitted' USING ERRCODE='23505'; END IF;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA intake_control FROM PUBLIC;
GRANT USAGE ON SCHEMA intake_control TO inc03_intake_runtime,inc03_intake_reader,inc03_intake_control;
GRANT SELECT ON intake_control.live,intake_control.catalog_entry,intake_control.treatment,intake_control.treatment_current,
  intake_control.profile,intake_control.namespace_admission TO inc03_intake_runtime,inc03_intake_reader;
GRANT EXECUTE ON FUNCTION intake_control.set_enabled(boolean),intake_control.set_treatment(text,integer,boolean),
  intake_control.activate_namespace(text,uuid,text) TO inc03_intake_control;
RESET ROLE;
GRANT USAGE ON SCHEMA access_trial TO inc03_intake_runtime,inc03_intake_reader;
GRANT SELECT ON access_trial.deployment,access_trial.session,access_trial.permission_definition,
  access_trial.scope_definition,access_trial.support_definition,access_trial.grant_record,access_trial.investiture,
  access_trial.incompatibility,access_trial.revalidation_event,access_trial.investiture_resolution TO inc03_intake_runtime,inc03_intake_reader;
GRANT SELECT(id,person_ref,restricted,revision,office) ON access_trial.account TO inc03_intake_runtime,inc03_intake_reader;
COMMIT;
