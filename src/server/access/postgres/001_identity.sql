-- Exclusive synthetic PG16 database only. Not a legacy migration.
BEGIN;
CREATE ROLE inc02_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc02_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE inc02_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE inc02_synthetic FROM PUBLIC;
GRANT CONNECT ON DATABASE inc02_synthetic TO inc02_runtime, inc02_control;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA access_trial AUTHORIZATION inc02_owner;
SET LOCAL ROLE inc02_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA access_trial REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
CREATE TABLE access_trial.deployment (
  singleton boolean PRIMARY KEY CHECK(singleton), deployment_id text NOT NULL CHECK(deployment_id='inc02-synthetic'),
  master_email text COLLATE "C" NOT NULL, root jsonb NOT NULL, reception jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  recovery_until bigint NOT NULL DEFAULT 0
);
CREATE TABLE access_trial.account (
  id uuid PRIMARY KEY, email text COLLATE "C" UNIQUE NOT NULL,
  person_ref text NOT NULL, office text UNIQUE NOT NULL CHECK(office='master'),
  verifier text NOT NULL, restricted boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE TABLE access_trial.flow (
  digest text PRIMARY KEY, csrf text NOT NULL, expires_at bigint NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE access_trial.session (
  digest text PRIMARY KEY, account_id uuid NOT NULL REFERENCES access_trial.account(id), csrf text NOT NULL,
  expires_at bigint NOT NULL, revoked boolean NOT NULL DEFAULT false, revision integer NOT NULL CHECK(revision>0)
);
CREATE TABLE access_trial.proof (
  id uuid PRIMARY KEY, email text COLLATE "C" NOT NULL, purpose text NOT NULL CHECK(purpose IN ('activation','recovery')),
  verifier text NOT NULL, expires_at bigint NOT NULL, used boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0, deployment_revision integer NOT NULL, created_at bigint NOT NULL
);
CREATE TABLE access_trial.intent (
  binding text NOT NULL, intention text NOT NULL, payload_digest text NOT NULL,
  receipt jsonb NOT NULL, PRIMARY KEY(binding,intention)
);
CREATE TABLE access_trial.throttle (
  key text PRIMARY KEY, count integer NOT NULL CHECK(count>=0), window_start bigint NOT NULL,
  last_at bigint NOT NULL
);
CREATE TABLE access_trial.evidence (
  id uuid PRIMARY KEY, operation text NOT NULL, actor_ref text NOT NULL, subject_ref text,
  result integer NOT NULL, revision integer NOT NULL, recorded_at bigint NOT NULL,
  purpose_ref text NOT NULL, treatment_ref text NOT NULL
);
CREATE TABLE access_trial.transport_observation (
  evidence_id uuid NOT NULL REFERENCES access_trial.evidence(id), outcome text NOT NULL CHECK(outcome IN ('handed_off','interrupted')),
  recorded_at bigint NOT NULL
);
CREATE FUNCTION access_trial.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON access_trial.evidence FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE TRIGGER immutable_transport BEFORE UPDATE OR DELETE ON access_trial.transport_observation FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE FUNCTION access_trial.check_master_creation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM access_trial.deployment d WHERE d.singleton AND d.active AND d.master_email=NEW.email
    AND d.root->>'holderPersonRef'=NEW.person_ref) THEN RAISE EXCEPTION 'Account outside admitted bootstrap' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admitted_master BEFORE INSERT ON access_trial.account FOR EACH ROW EXECUTE FUNCTION access_trial.check_master_creation();
-- Infrastructure authority is a separate credential, never supplied by a browser or runtime.
CREATE FUNCTION access_trial.set_control(enabled boolean, recovery_until bigint, reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n bigint := floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
BEGIN
  IF reason IS NULL OR length(reason)<1 OR length(reason)>200 OR recovery_until<0 OR recovery_until>n+300000 THEN RAISE EXCEPTION 'Invalid control'; END IF;
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE access_trial.deployment SET active=enabled, recovery_until=set_control.recovery_until, revision=revision+1;
  INSERT INTO access_trial.evidence SELECT gen_random_uuid(),'deployment_control',session_user,NULL,200,revision,n,'technical-recovery','synthetic-local' FROM access_trial.deployment;
END $$;
CREATE FUNCTION access_trial.restrict_account(account_id uuid, restricted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE access_trial.account SET restricted=restrict_account.restricted, revision=revision+1 WHERE id=account_id;
  UPDATE access_trial.session SET revoked=true,revision=revision+1 WHERE session.account_id=restrict_account.account_id;
  INSERT INTO access_trial.evidence VALUES(gen_random_uuid(),'account_restriction',session_user,account_id::text,200,1,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'technical-containment','synthetic-local');
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA access_trial FROM PUBLIC;
GRANT USAGE ON SCHEMA access_trial TO inc02_runtime,inc02_control;
GRANT SELECT ON access_trial.deployment TO inc02_runtime;
GRANT SELECT,INSERT,UPDATE ON access_trial.account,access_trial.flow,access_trial.session,access_trial.proof,access_trial.intent,access_trial.throttle TO inc02_runtime;
-- Runtime cannot change the office identity or account restrictions through column updates.
REVOKE UPDATE ON access_trial.account FROM inc02_runtime;
GRANT UPDATE(verifier,revision) ON access_trial.account TO inc02_runtime;
GRANT INSERT ON access_trial.evidence,access_trial.transport_observation TO inc02_runtime;
GRANT EXECUTE ON FUNCTION access_trial.set_control(boolean,bigint,text),access_trial.restrict_account(uuid,boolean) TO inc02_control;
COMMIT;
