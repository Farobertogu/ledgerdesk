-- Live realization of the four individually compared preparation effects.
-- No catalog entry, permission, comparison or route is enabled by this migration.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;
-- Preserve the existing partitions while adding explicit editorial partitions.
ALTER TABLE intake_control.catalog_entry DROP CONSTRAINT catalog_entry_partition_check;
ALTER TABLE intake_control.catalog_entry ADD CONSTRAINT catalog_entry_partition_check CHECK(partition IN (
  'personal_load','own_record','whole_original','visible_surfaces','extraction_record','extraction_content',
  'preparation_work','prepared_content','prepared_resource','preparation_difference','constitution_work'));
CREATE TABLE intake_control.preparation_comparison (
  operation text PRIMARY KEY CHECK(operation IN ('reserve_preparation','upload_preparation','finalize_preparation','propose')),
  reference jsonb NOT NULL,
  catalog jsonb NOT NULL,
  entry_revision integer NOT NULL CHECK(entry_revision>0),
  scope_ref text NOT NULL,
  purpose_ref text NOT NULL,
  body jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false
);
REVOKE ALL ON intake_control.preparation_comparison FROM PUBLIC;
GRANT SELECT ON intake_control.preparation_comparison TO inc03_intake_runtime,inc03_intake_reader;
CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON intake_control.preparation_comparison
  FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard();
CREATE FUNCTION intake_control.set_preparation_comparison(target text,admitted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE intake_control.preparation_comparison SET enabled=admitted WHERE operation=target;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preparation comparison unavailable' USING ERRCODE='42501'; END IF;
  UPDATE intake_control.live SET revision=revision+1;
  INSERT INTO intake_control.observation SELECT gen_random_uuid(),'preparation-comparison',source_id,revision,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,target FROM intake_control.live;
END $$;
REVOKE ALL ON FUNCTION intake_control.set_preparation_comparison(text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_control.set_preparation_comparison(text,boolean) TO inc03_intake_control;

-- Independently governed upstream input, not an authoring API or restored data.
-- The application may read an admitted act but cannot insert, widen or revoke it.
CREATE TABLE intake_control.constitution_prior_act (
  id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), sha256 text NOT NULL,
  source_id text NOT NULL, namespace text NOT NULL CHECK(namespace IN ('intake_trial','intake_restore')),
  principal text NOT NULL, context jsonb NOT NULL, executor jsonb NOT NULL,
  issuer jsonb NOT NULL, authorization_binding jsonb NOT NULL,
  issued_at bigint NOT NULL, expires_at bigint NOT NULL CHECK(expires_at>issued_at),
  body jsonb NOT NULL CHECK(octet_length(body::text)<=65536), PRIMARY KEY(id,revision)
);
CREATE TABLE intake_control.constitution_prior_current (
  id uuid NOT NULL, revision integer NOT NULL, enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY(id,revision), FOREIGN KEY(id,revision) REFERENCES intake_control.constitution_prior_act(id,revision)
);
REVOKE ALL ON intake_control.constitution_prior_act,intake_control.constitution_prior_current FROM PUBLIC;
GRANT SELECT ON intake_control.constitution_prior_act,intake_control.constitution_prior_current TO inc03_intake_runtime;
CREATE TRIGGER immutable_prior_act BEFORE UPDATE OR DELETE ON intake_control.constitution_prior_act
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON intake_control.constitution_prior_act
  FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard();
CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON intake_control.constitution_prior_current
  FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard();
CREATE FUNCTION intake_control.set_constitution_prior_act(target uuid,version integer,admitted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  UPDATE intake_control.constitution_prior_current SET enabled=admitted WHERE id=target AND revision=version;
  IF NOT FOUND THEN RAISE EXCEPTION 'Constitution authorization unavailable' USING ERRCODE='42501'; END IF;
  UPDATE intake_control.live SET revision=revision+1;
  INSERT INTO intake_control.observation SELECT gen_random_uuid(),'constitution-prior-act',source_id,revision,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,target::text FROM intake_control.live;
END $$;
REVOKE ALL ON FUNCTION intake_control.set_constitution_prior_act(uuid,integer,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_control.set_constitution_prior_act(uuid,integer,boolean) TO inc03_intake_control;
COMMIT;
