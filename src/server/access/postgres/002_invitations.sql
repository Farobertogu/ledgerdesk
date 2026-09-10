-- Additive migration of the isolated identity trial. Existing accounts and receipts survive.
BEGIN;
SET LOCAL ROLE inc02_owner;
ALTER TABLE access_trial.account ALTER COLUMN office DROP NOT NULL;
ALTER TABLE access_trial.account ALTER COLUMN verifier DROP NOT NULL;
ALTER TABLE access_trial.intent ADD COLUMN canonical_profile text NOT NULL DEFAULT 'legacy_t02';
ALTER TABLE access_trial.proof ADD COLUMN account_revision integer;
CREATE TABLE access_trial.permission_definition (
  id text PRIMARY KEY, label text NOT NULL, family text NOT NULL CHECK(family IN ('application','material_governance')),
  revision integer NOT NULL CHECK(revision>0), active boolean NOT NULL, requires_investiture boolean NOT NULL
);
CREATE TABLE access_trial.scope_definition (
  id text PRIMARY KEY, parent_id text REFERENCES access_trial.scope_definition(id), label text NOT NULL,
  purpose_ref text NOT NULL, revision integer NOT NULL CHECK(revision>0), active boolean NOT NULL
);
CREATE TABLE access_trial.support_definition (
  id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('domain','delegated')), authority_id uuid,
  label text NOT NULL, source_act text NOT NULL, expires_at bigint NOT NULL, active boolean NOT NULL,
  revision integer NOT NULL CHECK(revision>0), CHECK((kind='delegated')=(authority_id IS NOT NULL))
);
CREATE TABLE access_trial.investiture (
  id text PRIMARY KEY, person_ref text NOT NULL, permission_id text NOT NULL REFERENCES access_trial.permission_definition(id),
  scope_ref text NOT NULL REFERENCES access_trial.scope_definition(id), declaration jsonb NOT NULL,
  expires_at bigint NOT NULL, active boolean NOT NULL, revision integer NOT NULL CHECK(revision>0)
);
CREATE TABLE access_trial.person_determination (
  email text COLLATE "C" PRIMARY KEY, person_ref text NOT NULL, source_act text NOT NULL
);
CREATE TABLE access_trial.incompatibility (
  id text PRIMARY KEY, first_permission text NOT NULL REFERENCES access_trial.permission_definition(id),
  second_permission text NOT NULL REFERENCES access_trial.permission_definition(id),
  scope_ref text NOT NULL REFERENCES access_trial.scope_definition(id), active boolean NOT NULL,
  revision integer NOT NULL CHECK(revision>0), source_act text NOT NULL
);
CREATE TABLE access_trial.invitation (
  id uuid PRIMARY KEY, issuer_id uuid NOT NULL REFERENCES access_trial.account(id), email text COLLATE "C" NOT NULL,
  family text NOT NULL CHECK(family IN ('application','material_governance')), issued_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK(expires_at>issued_at), revision integer NOT NULL CHECK(revision>0),
  state text NOT NULL CHECK(state IN ('pending','accepted','withdrawn')), accepted_at bigint, withdrawn_at bigint,
  CHECK((state='accepted')=(accepted_at IS NOT NULL)), CHECK((state='withdrawn')=(withdrawn_at IS NOT NULL))
);
CREATE TABLE access_trial.invitation_revision (
  invitation_id uuid NOT NULL REFERENCES access_trial.invitation(id), revision integer NOT NULL CHECK(revision>0),
  grants jsonb NOT NULL, terms jsonb NOT NULL, changed_by uuid NOT NULL REFERENCES access_trial.account(id),
  recorded_at bigint NOT NULL, PRIMARY KEY(invitation_id,revision)
);
CREATE TABLE access_trial.email_proof (
  id uuid PRIMARY KEY, invitation_id uuid REFERENCES access_trial.invitation(id), flow_digest text NOT NULL REFERENCES access_trial.flow(digest),
  verifier text NOT NULL, expires_at bigint NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  verified boolean NOT NULL DEFAULT false, used boolean NOT NULL DEFAULT false, superseded boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL
);
CREATE TABLE access_trial.acceptance (
  id uuid PRIMARY KEY, invitation_id uuid NOT NULL UNIQUE REFERENCES access_trial.invitation(id),
  revision integer NOT NULL, account_id uuid NOT NULL REFERENCES access_trial.account(id),
  proof_id uuid NOT NULL UNIQUE REFERENCES access_trial.email_proof(id), recorded_at bigint NOT NULL,
  FOREIGN KEY(invitation_id,revision) REFERENCES access_trial.invitation_revision(invitation_id,revision)
);
ALTER TABLE access_trial.account ADD COLUMN origin_invitation_id uuid REFERENCES access_trial.invitation(id);
CREATE TABLE access_trial.person_account (
  account_id uuid PRIMARY KEY REFERENCES access_trial.account(id), person_ref text NOT NULL,
  source_act text NOT NULL, recorded_at bigint NOT NULL
);
INSERT INTO access_trial.person_account SELECT id,person_ref,'retained-master-declaration',floor(extract(epoch FROM clock_timestamp())*1000)::bigint FROM access_trial.account;
CREATE TABLE access_trial.grant_record (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES access_trial.account(id),
  permission_id text NOT NULL REFERENCES access_trial.permission_definition(id), faculty text NOT NULL CHECK(faculty IN ('exercise','grant')),
  scope_ref text NOT NULL REFERENCES access_trial.scope_definition(id), support_ref text NOT NULL REFERENCES access_trial.support_definition(id),
  acceptance_id uuid REFERENCES access_trial.acceptance(id), source_act text NOT NULL,
  expires_at bigint NOT NULL, withdrawn boolean NOT NULL DEFAULT false, revision integer NOT NULL CHECK(revision>0)
);
ALTER TABLE access_trial.support_definition ADD FOREIGN KEY(authority_id) REFERENCES access_trial.grant_record(id);
CREATE TABLE access_trial.invitation_intent (
  principal text NOT NULL, route text NOT NULL, intention text NOT NULL, payload_digest text NOT NULL,
  canonical_profile text NOT NULL CHECK(canonical_profile='canon_m09_1'), operation_id uuid NOT NULL UNIQUE,
  invitation_id uuid REFERENCES access_trial.invitation(id), receipt jsonb NOT NULL, recorded_at bigint NOT NULL, object_ref text,
  PRIMARY KEY(principal,route,intention)
);
CREATE TABLE access_trial.initial_credential_flow (
  flow_digest text PRIMARY KEY REFERENCES access_trial.flow(digest), account_id uuid NOT NULL REFERENCES access_trial.account(id),
  acceptance_id uuid NOT NULL REFERENCES access_trial.acceptance(id), expires_at bigint NOT NULL, consumed boolean NOT NULL DEFAULT false
);
CREATE TABLE access_trial.invitation_event (
  id uuid PRIMARY KEY, operation text NOT NULL, invitation_id uuid REFERENCES access_trial.invitation(id),
  actor_ref text NOT NULL, object_ref text NOT NULL, revision integer NOT NULL, details jsonb NOT NULL, recorded_at bigint NOT NULL
);
CREATE TRIGGER immutable_invitation_revision BEFORE UPDATE OR DELETE ON access_trial.invitation_revision FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE TRIGGER immutable_acceptance BEFORE UPDATE OR DELETE ON access_trial.acceptance FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE TRIGGER immutable_invitation_event BEFORE UPDATE OR DELETE ON access_trial.invitation_event FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE TRIGGER immutable_invitation_intent BEFORE UPDATE OR DELETE ON access_trial.invitation_intent FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE TRIGGER immutable_person_link BEFORE UPDATE OR DELETE ON access_trial.person_account FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE OR REPLACE FUNCTION access_trial.check_master_creation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.office='master' THEN
    IF NEW.verifier IS NULL OR NEW.origin_invitation_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access_trial.deployment d WHERE d.singleton AND d.active AND d.master_email=NEW.email AND d.root->>'holderPersonRef'=NEW.person_ref) THEN
      RAISE EXCEPTION 'Account outside admitted bootstrap' USING ERRCODE='42501'; END IF;
  ELSIF NEW.office IS NOT NULL OR NOT EXISTS(SELECT 1 FROM access_trial.invitation i WHERE i.id=NEW.origin_invitation_id AND i.email=NEW.email AND i.state='pending')
    OR EXISTS(SELECT 1 FROM access_trial.deployment d WHERE d.master_email=NEW.email) THEN
    RAISE EXCEPTION 'Account outside accepted invitation' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
-- Controlled support invalidation is coordinated with requests; configuration is never browser-writable.
CREATE FUNCTION access_trial.set_support(support_id text, enabled boolean, reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE changed_revision integer;
BEGIN
  IF reason IS NULL OR length(reason)<1 OR length(reason)>200 THEN RAISE EXCEPTION 'Invalid support change'; END IF;
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE access_trial.support_definition SET active=enabled,revision=revision+1 WHERE id=support_id RETURNING revision INTO changed_revision;
  IF changed_revision IS NULL THEN RAISE EXCEPTION 'Unknown support'; END IF;
  INSERT INTO access_trial.invitation_event VALUES(gen_random_uuid(),'support_change',NULL,session_user,support_id,changed_revision,
    jsonb_build_object('enabled',enabled,'reason',reason),floor(extract(epoch FROM clock_timestamp())*1000)::bigint);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA access_trial FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA access_trial FROM PUBLIC;
GRANT SELECT ON access_trial.permission_definition,access_trial.scope_definition,access_trial.support_definition,access_trial.investiture,
  access_trial.person_determination,access_trial.incompatibility TO inc02_runtime;
GRANT SELECT,INSERT ON access_trial.invitation,access_trial.invitation_revision,access_trial.email_proof,access_trial.acceptance,
  access_trial.person_account,access_trial.grant_record,access_trial.invitation_intent,access_trial.initial_credential_flow TO inc02_runtime;
GRANT UPDATE(revision,state,accepted_at,withdrawn_at) ON access_trial.invitation TO inc02_runtime;
GRANT UPDATE(attempts,verified,used,superseded) ON access_trial.email_proof TO inc02_runtime;
GRANT UPDATE(withdrawn,revision) ON access_trial.grant_record TO inc02_runtime;
GRANT UPDATE(consumed) ON access_trial.initial_credential_flow TO inc02_runtime;
GRANT INSERT ON access_trial.invitation_event TO inc02_runtime;
GRANT EXECUTE ON FUNCTION access_trial.set_support(text,boolean,text) TO inc02_control;
COMMIT;
