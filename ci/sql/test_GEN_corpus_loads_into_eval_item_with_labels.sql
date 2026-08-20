-- test_GEN_corpus_loads_into_eval_item_with_labels
--
-- The corpus generator is the only writer of eval_item, and it writes through the one grant that
-- declares that exception. What lands must carry its ground truth: every row has a clan, a
-- family, a label with its five fields, and a body whose hash the database recomputes rather
-- than trusts.
--
-- The generator's output path is read from LEDGERDESK_CORPUS_JSON, exported by ci/db_check.sh.

\set corpus `cat "$LEDGERDESK_CORPUS_JSON"`

begin;

set local role quality_gen;

insert into eval_item (id, item_id, template_id, family, body, body_sha256, label, label_source)
select (doc->>'id')::uuid, doc->>'item_id', doc->>'template_id', doc->>'family', doc->>'body',
       doc->>'body_sha256', doc->'label', doc->>'label_source'
from jsonb_array_elements(:'corpus'::jsonb) as t(doc);

reset role;

do $$
declare
  loaded   int;
  clans    int;
  families int;
  bad      int;
begin
  select count(*) into loaded from eval_item;
  if loaded = 0 then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: no item was loaded';
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
      or jsonb_typeof(label->'escalate') <> 'boolean';
  if bad > 0 then
    raise exception 'test_GEN_corpus_loads_into_eval_item_with_labels: % of % items carry an incomplete or mistyped label',
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

commit;
