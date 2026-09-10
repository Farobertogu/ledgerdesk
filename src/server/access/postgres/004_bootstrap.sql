-- Additive, isolated PG16 bootstrap. No historical account gains new permissions.
BEGIN;
SET LOCAL ROLE inc02_owner;
CREATE TABLE access_trial.bootstrap_declaration (
  singleton boolean PRIMARY KEY CHECK(singleton),
  id text UNIQUE NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  master_email text COLLATE "C" NOT NULL,
  holder_person_ref text NOT NULL,
  root jsonb NOT NULL,
  faculties jsonb NOT NULL CHECK(jsonb_typeof(faculties)='array' AND jsonb_array_length(faculties)<=16)
);
CREATE FUNCTION access_trial.check_bootstrap_declaration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  IF EXISTS(SELECT 1 FROM access_trial.account WHERE office='master') OR
    NOT EXISTS(SELECT 1 FROM access_trial.deployment d WHERE d.singleton
      AND d.master_email=NEW.master_email AND d.root=NEW.root
      AND d.root->>'holderPersonRef'=NEW.holder_person_ref)
    THEN RAISE EXCEPTION 'Declaration outside preactivation bootstrap' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admitted_bootstrap BEFORE INSERT ON access_trial.bootstrap_declaration
FOR EACH ROW EXECUTE FUNCTION access_trial.check_bootstrap_declaration();
CREATE TRIGGER immutable_bootstrap BEFORE UPDATE OR DELETE ON access_trial.bootstrap_declaration
FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
CREATE TABLE access_trial.bootstrap_activation (
  account_id uuid PRIMARY KEY REFERENCES access_trial.account(id),
  declaration_id text UNIQUE NOT NULL REFERENCES access_trial.bootstrap_declaration(id),
  evidence_id uuid UNIQUE NOT NULL REFERENCES access_trial.evidence(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER immutable_bootstrap_activation BEFORE UPDATE OR DELETE ON access_trial.bootstrap_activation
FOR EACH ROW EXECUTE FUNCTION access_trial.immutable();
REVOKE ALL ON FUNCTION access_trial.check_bootstrap_declaration() FROM PUBLIC;
GRANT SELECT ON access_trial.bootstrap_declaration,access_trial.bootstrap_activation TO inc02_runtime;
GRANT INSERT ON access_trial.bootstrap_activation TO inc02_runtime;
COMMIT;
