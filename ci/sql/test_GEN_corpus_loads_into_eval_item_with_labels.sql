-- test_GEN_corpus_loads_into_eval_item_with_labels
--
-- The corpus generator is the only writer of eval_item, and it writes through the one grant that
-- declares that exception. What lands must be ALL of what the signed manifest declares, and it
-- must carry its ground truth: a clan, a family, a label that obeys the invariants the generator
-- imposes on itself, and a body whose hash the database recomputes rather than trusts.
--
-- The corpus and manifest arrive as the temp tables ledgerdesk_corpus_src / ledgerdesk_manifest_src,
-- created by the prelude ci/db_check.sh generates and runs in this same session - no shell in the
-- path, so the mechanism is identical on every platform. Everything is asserted inside a
-- transaction that is rolled back, so the suite stays independent of the order its tests run in
-- and can be re-run on the same database.

begin;

create temp table manifest_json as select m from ledgerdesk_manifest_src;

set local role quality_gen;

insert into eval_item (id, item_id, template_id, family, body, body_sha256, label, label_source)
select (doc->>'id')::uuid, doc->>'item_id', doc->>'template_id', doc->>'family', doc->>'body',
       doc->>'body_sha256', doc->'label', doc->>'label_source'
from jsonb_array_elements((select doc from ledgerdesk_corpus_src)) as t(doc);

reset role;

-- No other role may write this table: the exception is the generator's and only the generator's.
do $$
declare
  r       text;
  denied  int := 0;
begin
  foreach r in array array['app_rw','quality_ro'] loop
    perform set_config('role', r, true);
    begin
      execute $q$insert into eval_item (id, item_id, template_id, family, body, body_sha256,
                                        label, label_source)
                 values (gen_random_uuid(), 'I-intruder', 'T-BILL-001', 'billing', 'body',
                         repeat('0', 64), '{}'::jsonb, 'generator')$q$;
      perform set_config('role', 'none', true);
      raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: role % could write eval_item', r;
    exception when insufficient_privilege then
      denied := denied + 1;
    end;
    perform set_config('role', 'none', true);
  end loop;
  if denied <> 2 then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % of 2 roles were denied the write', denied;
  end if;
end $$;

do $$
declare
  loaded   int;
  declared int;
  clans    int;
  families int;
  bad      int;
begin
  select count(*) into loaded from eval_item;
  select (m->'corpus'->>'n_items')::int into declared from manifest_json;
  if loaded <> declared then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % rows loaded, the signed manifest declares %',
      loaded, declared;
  end if;

  select count(distinct template_id), count(distinct family) into clans, families from eval_item;
  if clans < 4 or families < 4 then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % items span % clans and % families, expected at least 4 of each',
      loaded, clans, families;
  end if;

  select count(*) into bad from eval_item
   where not (label ?& array['category','severity','sentiment','escalate','reason'])
      or label_source <> 'generator'
      or jsonb_typeof(label->'severity') <> 'number'
      or jsonb_typeof(label->'sentiment') <> 'number'
      or jsonb_typeof(label->'escalate') <> 'boolean'
      or ((label->>'escalate')::boolean = false and jsonb_typeof(label->'reason') <> 'null')
      or ((label->>'escalate')::boolean = true
          and label->>'reason' not in ('CONF','SENT','TIER','RETRY','SLA','GROUND','POLICY','LANG'))
      or (label->>'severity')::int not between 1 and 4
      or (label->>'sentiment')::numeric not between -1 and 1;
  if bad > 0 then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % of % items carry a label that is incomplete, mistyped or outside its declared range',
      bad, loaded;
  end if;

  select count(*) into bad from eval_item
   where body_sha256 <> encode(sha256(convert_to(body, 'UTF8')), 'hex');
  if bad > 0 then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % of % bodies do not match their recorded hash',
      bad, loaded;
  end if;

  raise notice 'eval_item populated: % items, % clans, % families', loaded, clans, families;
end $$;

-- Every id the manifest partitions must be an id that landed, and the four sets must stay disjoint
-- against the table and not only against the file the generator wrote.
do $$
declare
  kind      text;
  ids       text[];
  declared  int;
  missing   int;
  seen      text[] := array[]::text[];
begin
  foreach kind in array array['selection','report','ood','blind_label'] loop
    select array(select jsonb_array_elements_text(m->'kinds'->kind->'item_ids')),
           (m->'kinds'->kind->>'n')::int
      into ids, declared
      from manifest_json;
    if array_length(ids, 1) is distinct from declared then
      raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: kind % lists % ids for n=%',
        kind, coalesce(array_length(ids, 1), 0), declared;
    end if;
    select count(*) into missing from unnest(ids) as u(id)
     where not exists (select 1 from eval_item e where e.item_id = u.id);
    if missing > 0 then
      raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % ids of kind % never landed in eval_item',
        missing, kind;
    end if;
    if exists (select 1 from unnest(ids) as u(id) where u.id = any(seen)) then
      raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: kind % shares an id with an earlier kind', kind;
    end if;
    seen := seen || ids;
  end loop;
end $$;

rollback;
