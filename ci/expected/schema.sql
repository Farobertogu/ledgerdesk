CREATE SCHEMA auth;
CREATE SCHEMA quality_report;
CREATE TYPE public.agent_kind AS ENUM (
    'triage',
    'draft',
    'validate',
    'evolve',
    'system'
);
CREATE TYPE public.kb_gap_state AS ENUM (
    'OPEN',
    'NOT_DOCUMENTABLE',
    'CLOSED'
);
CREATE TYPE public.ledger_class AS ENUM (
    'agent_call',
    'start',
    'promotion_attempt',
    'modification_event',
    'commitment',
    'prereg_anchor',
    'agreement_r3',
    'kb_admission',
    'checkpoint'
);
CREATE TYPE public.ticket_state AS ENUM (
    'NEW',
    'TRIAGED',
    'DRAFTED',
    'AWAITING_AGENT',
    'SENT',
    'ESCALATED',
    'RESOLVED',
    'CLOSED',
    'REOPENED',
    'TRIAGE_FAILED'
);
CREATE TYPE public.user_role AS ENUM (
    'customer',
    'agent',
    'supervisor'
);
CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
CREATE FUNCTION public.audit_event_link() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare head text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text, 1));
  select row_hash into head from audit_event where org_id = new.org_id order by id desc limit 1;
  if new.prev_hash is distinct from coalesce(head,'GENESIS') then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;
  return new;
end $$;
CREATE FUNCTION public.kb_gap_close_by_check(p_gap uuid, p_ledger bigint) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'CLOSED', closed_by_check_at = now(), closing_ledger_ref = p_ledger
   where id = p_gap;
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;
CREATE FUNCTION public.kb_gap_state_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if new.state is distinct from old.state
     and coalesce(current_setting('ledgerdesk.kb_gap_close', true), '') <> old.id::text then
    raise exception 'E_KB_GAP_CIERRE_NO_VERIFICADO';
  end if;
  return new;
end $$;
CREATE FUNCTION public.ledger_immutable() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin raise exception 'E_LEDGER_APPEND_ONLY'; end $$;
CREATE FUNCTION public.ledger_link() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
declare
  head      text;
  head_seq  bigint;
  required  text[];
begin
  -- The head read below is correct only under READ COMMITTED: at any stricter level the snapshot
  -- predates the lock and a stale head would be accepted.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;
  -- Serialise per run UNDER READ COMMITTED; the snapshot of a REPEATABLE READ transaction
  -- predates the lock, and what closes that case is the unique index on (run_id, prev_hash).
  perform pg_advisory_xact_lock(hashtextextended(new.run_id::text, 0));
  select seq, row_hash into head_seq, head
    from ledger_entry where run_id = new.run_id order by seq desc limit 1;
  -- The head is the LAST row: a seq that does not advance forks the chain without forging a hash.
  if head_seq is not null and new.seq <= head_seq then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;
  if new.prev_hash is distinct from coalesce(head,'GENESIS') then
    raise exception 'E_LEDGER_CHAIN_BROKEN';
  end if;
  if new.class = 'agent_call' and (
       new.prompt_version_id is null or new.model_requested is null or
       new.model_returned    is null or new.sampling        is null or
       new.input_hash        is null or new.input_path      is null or
       new.prompt_hash       is null or new.response_hash   is null or
       new.state_hash        is null) then
    raise exception 'E_LEDGER_FILA_INCOMPLETA';
  end if;
  -- Presence of the keys each class owns. The database guarantees that nothing is missing;
  -- the writer validates the full typing against quality/schemas/ledger_class/<class>.schema.json.
  required := case new.class
    when 'start'              then array['attempt_id','started_at','budget_reserved','code_sha']
    when 'promotion_attempt'  then array['attempt_id','candidate_prompt_version_id',
                                         'incumbent_prompt_version_id','conjuncts','failing_conjunct',
                                         'power','outcome','interpretation']
    when 'modification_event' then array['modification_id','gating_arm','verdict',
                                         'would_have_been_rejected','reason','dag_node_id']
    when 'commitment'         then array['commitment_kind','sha256','covers','committed_before']
    when 'prereg_anchor'      then array['document','sha256','field_count','blocks']
    when 'agreement_r3'       then array['item_id','template_id','agreement','r',
                                         'rollout_seeds','temperature']
    when 'kb_admission'       then array['admission_id','gap_id','approved_by','snapshot_from',
                                         'snapshot_to','content_hash','provenance_source']
    when 'checkpoint'         then array['seq_covered','head_row_hash','k']
    else null::text[]
  end;
  -- Presence is not enough where the contract says NAMED: a key carrying JSON null names nothing.
  -- failing_conjunct is the single key allowed to be null, and only in the state that authorises it.
  if required is not null and exists (
       select 1 from unnest(required) as k
        where k <> 'failing_conjunct'
          and (new.output -> k is null or jsonb_typeof(new.output -> k) = 'null')) then
    raise exception 'E_LEDGER_FILA_INCOMPLETA';
  end if;
  if new.class = 'promotion_attempt' then
    if (new.output -> 'failing_conjunct') is null then
      raise exception 'E_LEDGER_FILA_INCOMPLETA';
    end if;
    if jsonb_typeof(new.output -> 'failing_conjunct') = 'null'
       and (new.output ->> 'outcome') is distinct from 'PROMOTED' then
      raise exception 'E_LEDGER_FILA_INCOMPLETA';
    end if;
    if (new.output ->> 'outcome') = 'ABORTED' and (new.output -> 'abort_reason') is null then
      raise exception 'E_LEDGER_FILA_INCOMPLETA';
    end if;
  end if;
  return new;
end $$;
CREATE FUNCTION public.prompt_version_only_promoted_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    AS $$
begin
  if (to_jsonb(new) - 'promoted_at') is distinct from (to_jsonb(old) - 'promoted_at') then
    raise exception 'E_PROMPT_VERSION_INMUTABLE';
  end if;
  return new;
end $$;
CREATE TABLE public.account (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    tier text NOT NULL,
    value_band integer NOT NULL,
    CONSTRAINT account_tier_check CHECK ((tier = ANY (ARRAY['standard'::text, 'premium'::text]))),
    CONSTRAINT account_value_band_check CHECK (((value_band >= 1) AND (value_band <= 5)))
);
CREATE TABLE public.app_user (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    role public.user_role NOT NULL,
    locale text DEFAULT 'en-AU'::text NOT NULL
);
CREATE TABLE public.audit_event (
    id bigint NOT NULL,
    org_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    prev_hash text NOT NULL,
    row_hash text NOT NULL,
    CONSTRAINT audit_hash_shape CHECK (((row_hash ~ '^[a-f0-9]{64}$'::text) AND ((prev_hash = 'GENESIS'::text) OR (prev_hash ~ '^[a-f0-9]{64}$'::text)) AND (row_hash <> prev_hash)))
);
CREATE SEQUENCE public.audit_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.audit_event_id_seq OWNED BY public.audit_event.id;
CREATE TABLE public.eval_item (
    id uuid NOT NULL,
    item_id text NOT NULL,
    template_id text NOT NULL,
    family text NOT NULL,
    body text NOT NULL,
    body_sha256 text NOT NULL,
    label jsonb NOT NULL,
    label_source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eval_item_label_source_check CHECK ((label_source = ANY (ARRAY['generator'::text, 'blind_human'::text])))
);
CREATE TABLE public.eval_result (
    id uuid NOT NULL,
    split_id uuid NOT NULL,
    prompt_version_id uuid NOT NULL,
    query_index bigint NOT NULL,
    n integer NOT NULL,
    correct integer NOT NULL,
    accuracy numeric(5,4) NOT NULL,
    ci_low numeric(5,4) NOT NULL,
    ci_high numeric(5,4) NOT NULL,
    ci_unit text NOT NULL,
    deff numeric(6,3),
    sealed_hash text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT eval_result_ci_unit_check CHECK ((ci_unit = ANY (ARRAY['clan'::text, 'item'::text]))),
    CONSTRAINT eval_result_n_check CHECK ((n > 0))
);
CREATE TABLE public.eval_split (
    id uuid NOT NULL,
    run_id uuid NOT NULL,
    kind text NOT NULL,
    n integer NOT NULL,
    manifest_sha256 text NOT NULL,
    content_sha256 text NOT NULL,
    sealed_at timestamp with time zone NOT NULL,
    revealed_at timestamp with time zone,
    CONSTRAINT eval_split_kind_check CHECK ((kind = ANY (ARRAY['selection'::text, 'report'::text, 'ood'::text, 'blind_label'::text]))),
    CONSTRAINT eval_split_n_check CHECK ((n > 0))
);
CREATE TABLE public.human_edit (
    id uuid NOT NULL,
    response_id uuid NOT NULL,
    diff text NOT NULL,
    edit_distance_norm numeric(5,4) NOT NULL,
    editor_id uuid NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.kb_admission (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    gap_id uuid NOT NULL,
    approved_by uuid NOT NULL,
    snapshot_from text NOT NULL,
    snapshot_to text NOT NULL,
    content_hash text NOT NULL,
    provenance jsonb NOT NULL,
    ledger_ref bigint NOT NULL,
    admitted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_admission_check CHECK ((snapshot_from <> snapshot_to))
);
CREATE TABLE public.kb_article (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    kb_snapshot text NOT NULL,
    canonical_key text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    body_sha256 text NOT NULL,
    citable boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.kb_gap (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    query_terms text NOT NULL,
    kb_snapshot text NOT NULL,
    zero_match boolean NOT NULL,
    query_sha256 text NOT NULL,
    divergent_kb_ids uuid[],
    owner_id uuid NOT NULL,
    committed_date date NOT NULL,
    null_rule text NOT NULL,
    state public.kb_gap_state DEFAULT 'OPEN'::public.kb_gap_state NOT NULL,
    closed_by_check_at timestamp with time zone,
    opened_ledger_ref bigint,
    closing_ledger_ref bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT kb_gap_check CHECK (((state <> 'CLOSED'::public.kb_gap_state) OR ((closed_by_check_at IS NOT NULL) AND (closing_ledger_ref IS NOT NULL))))
);
CREATE TABLE public.ledger_checkpoint (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    seq_covered bigint NOT NULL,
    head_row_hash text NOT NULL,
    k integer NOT NULL,
    external_ref text NOT NULL,
    anchored_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT checkpoint_hash_shape CHECK ((head_row_hash ~ '^[a-f0-9]{64}$'::text))
);
CREATE SEQUENCE public.ledger_checkpoint_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.ledger_checkpoint_id_seq OWNED BY public.ledger_checkpoint.id;
CREATE TABLE public.ledger_entry (
    id bigint NOT NULL,
    run_id uuid NOT NULL,
    seq bigint NOT NULL,
    org_id uuid NOT NULL,
    ticket_id uuid,
    agent public.agent_kind NOT NULL,
    prompt_version_id uuid,
    model_requested text,
    model_returned text,
    sampling jsonb,
    seed bigint,
    input_hash text,
    input_path text,
    prompt_hash text,
    response_hash text,
    state_hash text NOT NULL,
    split_id uuid,
    toolchain jsonb NOT NULL,
    restarts integer DEFAULT 0 NOT NULL,
    tokens_in integer NOT NULL,
    tokens_out integer NOT NULL,
    cost_aud numeric(12,6) NOT NULL,
    latency_ms integer NOT NULL,
    cum_tokens bigint NOT NULL,
    class public.ledger_class NOT NULL,
    output jsonb NOT NULL,
    confidence numeric(4,3),
    ts timestamp with time zone DEFAULT now() NOT NULL,
    prev_hash text NOT NULL,
    row_hash text NOT NULL,
    CONSTRAINT ledger_agent_call_complete CHECK (((class <> 'agent_call'::public.ledger_class) OR ((prompt_version_id IS NOT NULL) AND (model_requested IS NOT NULL) AND (model_returned IS NOT NULL) AND (sampling IS NOT NULL) AND (input_hash IS NOT NULL) AND (input_path IS NOT NULL) AND (prompt_hash IS NOT NULL) AND (response_hash IS NOT NULL)))),
    CONSTRAINT ledger_agent_identity CHECK ((((class = ANY (ARRAY['promotion_attempt'::public.ledger_class, 'modification_event'::public.ledger_class])) AND (agent = 'evolve'::public.agent_kind)) OR ((class <> ALL (ARRAY['agent_call'::public.ledger_class, 'promotion_attempt'::public.ledger_class, 'modification_event'::public.ledger_class])) AND (agent = 'system'::public.agent_kind)) OR (class = 'agent_call'::public.ledger_class))),
    CONSTRAINT ledger_agreement_r3_has_split CHECK (((class <> 'agreement_r3'::public.ledger_class) OR (split_id IS NOT NULL))),
    CONSTRAINT ledger_entry_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT ledger_hash_shape CHECK (((row_hash ~ '^[a-f0-9]{64}$'::text) AND ((prev_hash = 'GENESIS'::text) OR (prev_hash ~ '^[a-f0-9]{64}$'::text)) AND (row_hash <> prev_hash))),
    CONSTRAINT ledger_nonmodel_costs_zero CHECK (((class = 'agent_call'::public.ledger_class) OR ((tokens_in = 0) AND (tokens_out = 0) AND (cost_aud = (0)::numeric) AND (latency_ms = 0) AND (restarts = 0))))
);
CREATE SEQUENCE public.ledger_entry_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.ledger_entry_id_seq OWNED BY public.ledger_entry.id;
CREATE TABLE public.org (
    id uuid NOT NULL,
    name text NOT NULL,
    tier_default text NOT NULL
);
CREATE TABLE public.prompt_version (
    id uuid NOT NULL,
    agent public.agent_kind NOT NULL,
    generation integer NOT NULL,
    text text NOT NULL,
    schema_hash text NOT NULL,
    parent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    promoted_at timestamp with time zone,
    CONSTRAINT prompt_version_generation_check CHECK ((generation >= 0))
);
CREATE TABLE public.response (
    id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    draft text NOT NULL,
    final text,
    sent_at timestamp with time zone,
    approved_by uuid,
    CONSTRAINT no_autosend CHECK (((sent_at IS NULL) OR (approved_by IS NOT NULL)))
);
CREATE TABLE public.sla_policy (
    id uuid NOT NULL,
    tier text NOT NULL,
    severity integer NOT NULL,
    first_response_minutes integer NOT NULL,
    resolution_minutes integer NOT NULL,
    CONSTRAINT sla_policy_severity_check CHECK (((severity >= 1) AND (severity <= 4)))
);
CREATE TABLE public.ticket (
    id uuid NOT NULL,
    org_id uuid NOT NULL,
    account_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    subject text NOT NULL,
    body_raw text NOT NULL,
    body_redacted text,
    channel text DEFAULT 'web'::text NOT NULL,
    language text DEFAULT 'en'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status public.ticket_state DEFAULT 'NEW'::public.ticket_state NOT NULL,
    category text,
    severity integer,
    sentiment numeric(4,3),
    confidence numeric(4,3),
    sla_policy_id uuid,
    sla_due_at timestamp with time zone,
    breached_at timestamp with time zone,
    retries integer DEFAULT 0 NOT NULL,
    dedupe_key text,
    CONSTRAINT ticket_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT ticket_sentiment_check CHECK (((sentiment >= ('-1'::integer)::numeric) AND (sentiment <= (1)::numeric))),
    CONSTRAINT ticket_severity_check CHECK (((severity >= 1) AND (severity <= 4)))
);
CREATE TABLE quality_report.eval_outcome (
    id bigint NOT NULL,
    attempt_id uuid NOT NULL,
    arm text NOT NULL,
    role text NOT NULL,
    item_id text NOT NULL,
    template_id text NOT NULL,
    dag_node_id uuid NOT NULL,
    kb_snapshot text NOT NULL,
    verdict text NOT NULL,
    prev_hash text NOT NULL,
    row_hash text NOT NULL,
    CONSTRAINT eval_outcome_hash_shape CHECK (((row_hash ~ '^[a-f0-9]{64}$'::text) AND ((prev_hash = 'GENESIS'::text) OR (prev_hash ~ '^[a-f0-9]{64}$'::text)) AND (row_hash <> prev_hash))),
    CONSTRAINT eval_outcome_role_check CHECK ((role = ANY (ARRAY['candidate'::text, 'champion_fresh'::text])))
);
CREATE SEQUENCE quality_report.eval_outcome_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE quality_report.eval_outcome_id_seq OWNED BY quality_report.eval_outcome.id;
ALTER TABLE ONLY public.audit_event ALTER COLUMN id SET DEFAULT nextval('public.audit_event_id_seq'::regclass);
ALTER TABLE ONLY public.ledger_checkpoint ALTER COLUMN id SET DEFAULT nextval('public.ledger_checkpoint_id_seq'::regclass);
ALTER TABLE ONLY public.ledger_entry ALTER COLUMN id SET DEFAULT nextval('public.ledger_entry_id_seq'::regclass);
ALTER TABLE ONLY quality_report.eval_outcome ALTER COLUMN id SET DEFAULT nextval('quality_report.eval_outcome_id_seq'::regclass);
ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.eval_item
    ADD CONSTRAINT eval_item_item_id_key UNIQUE (item_id);
ALTER TABLE ONLY public.eval_item
    ADD CONSTRAINT eval_item_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.eval_result
    ADD CONSTRAINT eval_result_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.eval_result
    ADD CONSTRAINT eval_result_split_id_prompt_version_id_query_index_key UNIQUE (split_id, prompt_version_id, query_index);
ALTER TABLE ONLY public.eval_split
    ADD CONSTRAINT eval_split_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.eval_split
    ADD CONSTRAINT eval_split_run_id_kind_key UNIQUE (run_id, kind);
ALTER TABLE ONLY public.human_edit
    ADD CONSTRAINT human_edit_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.kb_admission
    ADD CONSTRAINT kb_admission_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.kb_article
    ADD CONSTRAINT kb_article_kb_snapshot_canonical_key_id_key UNIQUE (kb_snapshot, canonical_key, id);
ALTER TABLE ONLY public.kb_article
    ADD CONSTRAINT kb_article_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.kb_gap
    ADD CONSTRAINT kb_gap_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ledger_checkpoint
    ADD CONSTRAINT ledger_checkpoint_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ledger_checkpoint
    ADD CONSTRAINT ledger_checkpoint_run_id_seq_covered_key UNIQUE (run_id, seq_covered);
ALTER TABLE ONLY public.ledger_entry
    ADD CONSTRAINT ledger_entry_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.ledger_entry
    ADD CONSTRAINT ledger_entry_run_id_seq_key UNIQUE (run_id, seq);
ALTER TABLE ONLY public.org
    ADD CONSTRAINT org_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.prompt_version
    ADD CONSTRAINT prompt_version_agent_generation_key UNIQUE (agent, generation);
ALTER TABLE ONLY public.prompt_version
    ADD CONSTRAINT prompt_version_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sla_policy
    ADD CONSTRAINT sla_policy_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.sla_policy
    ADD CONSTRAINT sla_policy_tier_severity_key UNIQUE (tier, severity);
ALTER TABLE ONLY public.ticket
    ADD CONSTRAINT ticket_org_id_dedupe_key_key UNIQUE (org_id, dedupe_key);
ALTER TABLE ONLY public.ticket
    ADD CONSTRAINT ticket_pkey PRIMARY KEY (id);
ALTER TABLE ONLY quality_report.eval_outcome
    ADD CONSTRAINT eval_outcome_attempt_id_role_item_id_key UNIQUE (attempt_id, role, item_id);
ALTER TABLE ONLY quality_report.eval_outcome
    ADD CONSTRAINT eval_outcome_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX audit_one_child_per_head ON public.audit_event USING btree (org_id, prev_hash);
CREATE UNIQUE INDEX ledger_one_child_per_head ON public.ledger_entry USING btree (run_id, prev_hash);
CREATE UNIQUE INDEX ledger_start_unique_per_attempt ON public.ledger_entry USING btree (((output ->> 'attempt_id'::text))) WHERE (class = 'start'::public.ledger_class);
CREATE UNIQUE INDEX ledger_terminal_unique_per_attempt ON public.ledger_entry USING btree (((output ->> 'attempt_id'::text))) WHERE (class = 'promotion_attempt'::public.ledger_class);
CREATE INDEX ledger_ticket_idx ON public.ledger_entry USING btree (ticket_id, seq) WHERE (ticket_id IS NOT NULL);
CREATE INDEX response_ticket_idx ON public.response USING btree (ticket_id);
CREATE INDEX ticket_queue_idx ON public.ticket USING btree (org_id, status, sla_due_at);
CREATE TRIGGER trg_audit_link BEFORE INSERT ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.audit_event_link();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON public.audit_event FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_audit_no_update BEFORE DELETE OR UPDATE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_checkpoint_no_truncate BEFORE TRUNCATE ON public.ledger_checkpoint FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_checkpoint_no_update BEFORE DELETE OR UPDATE ON public.ledger_checkpoint FOR EACH ROW EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_kb_gap_state_guard BEFORE UPDATE ON public.kb_gap FOR EACH ROW EXECUTE FUNCTION public.kb_gap_state_guard();
CREATE TRIGGER trg_ledger_link BEFORE INSERT ON public.ledger_entry FOR EACH ROW EXECUTE FUNCTION public.ledger_link();
CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON public.ledger_entry FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_ledger_no_update BEFORE DELETE OR UPDATE ON public.ledger_entry FOR EACH ROW EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_prompt_version_immutable BEFORE UPDATE ON public.prompt_version FOR EACH ROW EXECUTE FUNCTION public.prompt_version_only_promoted_at();
CREATE TRIGGER trg_eval_outcome_no_truncate BEFORE TRUNCATE ON quality_report.eval_outcome FOR EACH STATEMENT EXECUTE FUNCTION public.ledger_immutable();
CREATE TRIGGER trg_eval_outcome_no_update BEFORE DELETE OR UPDATE ON quality_report.eval_outcome FOR EACH ROW EXECUTE FUNCTION public.ledger_immutable();
ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.app_user
    ADD CONSTRAINT app_user_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.audit_event
    ADD CONSTRAINT audit_event_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.app_user(id);
ALTER TABLE ONLY public.audit_event
    ADD CONSTRAINT audit_event_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.eval_result
    ADD CONSTRAINT eval_result_prompt_version_id_fkey FOREIGN KEY (prompt_version_id) REFERENCES public.prompt_version(id);
ALTER TABLE ONLY public.eval_result
    ADD CONSTRAINT eval_result_split_id_fkey FOREIGN KEY (split_id) REFERENCES public.eval_split(id);
ALTER TABLE ONLY public.ledger_checkpoint
    ADD CONSTRAINT fk_checkpoint_row FOREIGN KEY (run_id, seq_covered) REFERENCES public.ledger_entry(run_id, seq);
ALTER TABLE ONLY public.kb_gap
    ADD CONSTRAINT fk_kb_gap_closing FOREIGN KEY (closing_ledger_ref) REFERENCES public.ledger_entry(id);
ALTER TABLE ONLY public.kb_gap
    ADD CONSTRAINT fk_kb_gap_opened FOREIGN KEY (opened_ledger_ref) REFERENCES public.ledger_entry(id);
ALTER TABLE ONLY public.human_edit
    ADD CONSTRAINT human_edit_editor_id_fkey FOREIGN KEY (editor_id) REFERENCES public.app_user(id);
ALTER TABLE ONLY public.human_edit
    ADD CONSTRAINT human_edit_response_id_fkey FOREIGN KEY (response_id) REFERENCES public.response(id);
ALTER TABLE ONLY public.kb_admission
    ADD CONSTRAINT kb_admission_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.app_user(id);
ALTER TABLE ONLY public.kb_admission
    ADD CONSTRAINT kb_admission_gap_id_fkey FOREIGN KEY (gap_id) REFERENCES public.kb_gap(id);
ALTER TABLE ONLY public.kb_admission
    ADD CONSTRAINT kb_admission_ledger_ref_fkey FOREIGN KEY (ledger_ref) REFERENCES public.ledger_entry(id);
ALTER TABLE ONLY public.kb_admission
    ADD CONSTRAINT kb_admission_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.kb_article
    ADD CONSTRAINT kb_article_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.kb_gap
    ADD CONSTRAINT kb_gap_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.kb_gap
    ADD CONSTRAINT kb_gap_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.app_user(id);
ALTER TABLE ONLY public.kb_gap
    ADD CONSTRAINT kb_gap_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.ticket(id);
ALTER TABLE ONLY public.ledger_entry
    ADD CONSTRAINT ledger_entry_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.ledger_entry
    ADD CONSTRAINT ledger_entry_prompt_version_id_fkey FOREIGN KEY (prompt_version_id) REFERENCES public.prompt_version(id);
ALTER TABLE ONLY public.ledger_entry
    ADD CONSTRAINT ledger_entry_split_id_fkey FOREIGN KEY (split_id) REFERENCES public.eval_split(id);
ALTER TABLE ONLY public.ledger_entry
    ADD CONSTRAINT ledger_entry_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.ticket(id);
ALTER TABLE ONLY public.prompt_version
    ADD CONSTRAINT prompt_version_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.prompt_version(id);
ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.app_user(id);
ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.ticket(id);
ALTER TABLE ONLY public.ticket
    ADD CONSTRAINT ticket_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.account(id);
ALTER TABLE ONLY public.ticket
    ADD CONSTRAINT ticket_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.app_user(id);
ALTER TABLE ONLY public.ticket
    ADD CONSTRAINT ticket_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.org(id);
ALTER TABLE ONLY public.ticket
    ADD CONSTRAINT ticket_sla_policy_id_fkey FOREIGN KEY (sla_policy_id) REFERENCES public.sla_policy(id);
ALTER TABLE ONLY quality_report.eval_outcome
    ADD CONSTRAINT eval_outcome_dag_node_id_fkey FOREIGN KEY (dag_node_id) REFERENCES public.prompt_version(id);
CREATE POLICY agent_writes ON public.response FOR UPDATE USING ((((auth.jwt() ->> 'role'::text) = ANY (ARRAY['agent'::text, 'supervisor'::text])) AND (EXISTS ( SELECT 1
   FROM public.ticket t
  WHERE ((t.id = response.ticket_id) AND (t.org_id = ((auth.jwt() ->> 'org_id'::text))::uuid)))))) WITH CHECK ((((auth.jwt() ->> 'role'::text) = ANY (ARRAY['agent'::text, 'supervisor'::text])) AND (EXISTS ( SELECT 1
   FROM public.ticket t
  WHERE ((t.id = response.ticket_id) AND (t.org_id = ((auth.jwt() ->> 'org_id'::text))::uuid))))));
ALTER TABLE public.audit_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_own_rows ON public.ticket AS RESTRICTIVE FOR SELECT USING (((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid) AND (((auth.jwt() ->> 'role'::text) = ANY (ARRAY['agent'::text, 'supervisor'::text])) OR (customer_id = auth.uid()))));
ALTER TABLE public.kb_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_article ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_gap ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY ledger_quality_select ON public.ledger_entry FOR SELECT TO quality_ro USING (true);
CREATE POLICY ledger_tenant_select ON public.ledger_entry FOR SELECT TO app_rw USING ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
CREATE POLICY ledger_writer_insert ON public.ledger_entry FOR INSERT TO app_rw WITH CHECK ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
ALTER TABLE public.response ENABLE ROW LEVEL SECURITY;
CREATE POLICY response_tenant_select ON public.response FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.ticket t
  WHERE ((t.id = response.ticket_id) AND (t.org_id = ((auth.jwt() ->> 'org_id'::text))::uuid)))));
CREATE POLICY tenant_isolation ON public.ticket USING ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
CREATE POLICY tenant_isolation_audit ON public.audit_event USING ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
CREATE POLICY tenant_isolation_kb_admission ON public.kb_admission USING ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
CREATE POLICY tenant_isolation_kb_article ON public.kb_article USING ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
CREATE POLICY tenant_isolation_kb_gap ON public.kb_gap USING ((org_id = ((auth.jwt() ->> 'org_id'::text))::uuid));
ALTER TABLE public.ticket ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT USAGE ON SCHEMA quality_report TO quality_ro;
GRANT USAGE ON SCHEMA quality_report TO quality_eval;
GRANT SELECT,INSERT ON TABLE public.eval_item TO quality_gen;
GRANT SELECT ON TABLE public.eval_item TO quality_ro;
GRANT SELECT,INSERT ON TABLE public.eval_result TO quality_eval;
GRANT SELECT ON TABLE public.eval_result TO quality_ro;
GRANT SELECT ON TABLE public.eval_result TO app_rw;
GRANT SELECT ON TABLE public.eval_split TO quality_ro;
GRANT SELECT ON TABLE public.eval_split TO app_rw;
GRANT SELECT,INSERT ON TABLE public.ledger_entry TO app_rw;
GRANT SELECT ON TABLE public.ledger_entry TO quality_ro;
GRANT SELECT ON TABLE public.ledger_entry TO quality_eval;
GRANT SELECT ON TABLE public.prompt_version TO quality_ro;
GRANT SELECT ON TABLE public.prompt_version TO app_rw;
