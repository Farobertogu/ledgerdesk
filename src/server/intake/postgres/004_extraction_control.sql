-- Controlled processing declarations are not part of the restored data set.
-- Installing this migration enables no profile and manufactures no grant.
BEGIN;
SET LOCAL ROLE inc03_intake_owner;
ALTER TABLE intake_control.catalog_entry DROP CONSTRAINT catalog_entry_partition_check;
ALTER TABLE intake_control.catalog_entry ADD CONSTRAINT catalog_entry_partition_check
  CHECK(partition IN ('personal_load','own_record','whole_original','visible_surfaces','extraction_record','extraction_content'));

CREATE TABLE intake_control.processing_declaration (
  id text NOT NULL, revision integer NOT NULL CHECK(revision>0),
  sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),
  format text NOT NULL CHECK(format IN ('text-utf8/1','markdown-inert/1','csv-utf8/1','xlsx-cells/1')),
  configuration jsonb NOT NULL, limits jsonb NOT NULL,
  request jsonb NOT NULL, plan jsonb NOT NULL, assignment jsonb NOT NULL, worker jsonb NOT NULL,
  executor_account uuid NOT NULL, executor_reference jsonb NOT NULL,
  scope_ref text NOT NULL, purpose_ref text NOT NULL,
  session_dependency text NOT NULL CHECK(session_dependency IN ('origin_session','independent_of_origin_session')),
  image text NOT NULL CHECK(image~'^sha256:[a-f0-9]{64}$'),
  expires_at bigint NOT NULL CHECK(expires_at>0),
  PRIMARY KEY(id,revision), UNIQUE(id,revision,sha256,format)
);
CREATE TABLE intake_control.processing_current (
  format text PRIMARY KEY, id text NOT NULL, revision integer NOT NULL,
  sha256 text NOT NULL, enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY(id,revision,sha256,format) REFERENCES intake_control.processing_declaration(id,revision,sha256,format)
);
-- Restore admission is retained outside the data archive. These exact rows
-- originate in the controlled backup cut, not in an arriving manifest.
CREATE TABLE intake_control.extraction_restore_cut (
  anchor_id uuid PRIMARY KEY REFERENCES intake_control.backup_anchor(id),
  target_namespace text NOT NULL CHECK(target_namespace='intake_restore'),
  source_namespace text NOT NULL CHECK(source_namespace='intake_trial'),
  original_manifest_sha256 text NOT NULL CHECK(original_manifest_sha256~'^[a-f0-9]{64}$'),
  output_manifest_sha256 text NOT NULL CHECK(output_manifest_sha256~'^[a-f0-9]{64}$'),
  data_sha256 text NOT NULL CHECK(data_sha256~'^[a-f0-9]{64}$'),
  creator_role name NOT NULL DEFAULT session_user
);
CREATE TABLE intake_control.extraction_restore_output (
  anchor_id uuid NOT NULL REFERENCES intake_control.extraction_restore_cut(anchor_id),
  output_id uuid NOT NULL, original_row jsonb NOT NULL,
  PRIMARY KEY(anchor_id,output_id), CHECK(original_row->>'id'=output_id::text)
);
CREATE TRIGGER immutable_extraction_restore_cut BEFORE UPDATE OR DELETE ON intake_control.extraction_restore_cut
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_extraction_restore_output BEFORE UPDATE OR DELETE ON intake_control.extraction_restore_output
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER immutable_processing_declaration BEFORE UPDATE OR DELETE ON intake_control.processing_declaration
  FOR EACH ROW EXECUTE FUNCTION intake_control.immutable();
CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON intake_control.processing_current
  FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard();
CREATE TRIGGER intake_private_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON intake_control.processing_declaration
  FOR EACH STATEMENT EXECUTE FUNCTION intake_control.source_mutation_guard();
CREATE FUNCTION intake_control.set_processing(target_format text,target_id text,target_revision integer,target_sha256 text,admitted boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET lock_timeout='250ms' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(20202,1);
  INSERT INTO intake_control.processing_current VALUES(target_format,target_id,target_revision,target_sha256,admitted)
    ON CONFLICT(format) DO UPDATE SET id=excluded.id,revision=excluded.revision,sha256=excluded.sha256,enabled=excluded.enabled;
  UPDATE intake_control.live SET revision=revision+1;
  INSERT INTO intake_control.observation SELECT gen_random_uuid(),'processing',source_id,revision,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint,target_id FROM intake_control.live;
END $$;
REVOKE ALL ON intake_control.processing_declaration,intake_control.processing_current FROM PUBLIC;
REVOKE ALL ON intake_control.extraction_restore_cut,intake_control.extraction_restore_output FROM PUBLIC;
GRANT SELECT ON intake_control.extraction_restore_cut,intake_control.extraction_restore_output TO inc03_intake_runtime,inc03_intake_reader;
REVOKE ALL ON FUNCTION intake_control.set_processing(text,text,integer,text,boolean) FROM PUBLIC;
GRANT SELECT ON intake_control.processing_declaration,intake_control.processing_current TO inc03_intake_runtime,inc03_intake_reader;
GRANT EXECUTE ON FUNCTION intake_control.set_processing(text,text,integer,text,boolean) TO inc03_intake_control;
COMMIT;
