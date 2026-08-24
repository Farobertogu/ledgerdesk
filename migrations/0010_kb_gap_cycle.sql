-- 0010_kb_gap_cycle.sql — the knowledge gap becomes a record, the admission becomes a transaction,
-- and the closure becomes four refusals instead of four sentences.
-- Forward-only: once applied this file is never edited; a correction is a new numbered migration.
-- Authority: adr/ADR-026-kb-gap-cycle.md (this repository's series; see that record's numbering note).
--
-- 0009 built the receiver's half of the gap and left the writer to the increment that owns it. This
-- is that increment. Nine sections: three writers, one hardening the card discovered, and five
-- constraints that turn a sentence somebody has to remember into a row the database will not take.

-- ---------------------------------------------------------------------------
-- 1 · Two columns the writers need, added before the functions that populate them
--
-- ## `kb_gap.question_sha256` — the identity of a question, with the corpus left out
--
-- `query_sha256` is `sha256(query_terms ‖ kb_snapshot)`: the identity of one query under one corpus,
-- and it is what makes a retried emission idempotent. It is also, by construction, a DIFFERENT value
-- for the same question the moment the corpus moves — which is right for what it does and wrong for
-- what the requirement counts. The requirement counts escalations: *every `GROUND` escalation has
-- exactly one gap record*, which needs an identity that survives an advance.
--
-- This is that identity: the digest of the question's canonical form, computed by the producer and
-- recomputed by the receiver, so it ties like the other one rather than being asserted.
--
-- **The partial index is where the bound actually lives.** Unique over `(ticket_id,
-- question_sha256)` *where the record is not closed* — so a ticket carries at most one STANDING
-- record per question, and a question that fails again after a verified closure opens a new episode
-- with its own evidence instead of being refused. That is what "closure by verification" has to mean
-- if it means anything: a closed gap is finished, not a permanent ban on the question.
--
-- **0009's `unique (ticket_id, query_sha256)` is untouched**, and this is added beside it rather
-- than in place of it. Two identities, two jobs: one makes a retry the same row, the other makes an
-- episode one record.
--
-- ## `kb_admission.article_id` — the admission names the article it admitted
--
-- The composite key `(article_id, snapshot_to)` into `kb_article (id, kb_snapshot)` makes "this
-- admission put THAT document into THAT snapshot" a statement the database can refuse, in the same
-- way `response_citation` makes a citation refusable. It became expressible only once the advance
-- wrote the admission: the article has to exist before anything can reference it, and the advance is
-- what mints it.
--
-- **It comes before the function that populates it, and the order is not cosmetic.** A plpgsql body
-- resolves the names it uses at first execution rather than at creation, so a function written
-- against a column that does not exist yet is created without complaint and fails the first time
-- anybody calls it. Adding the column first makes that impossible instead of unlikely.
--
-- **Nullable, and the nullability is a declared cost rather than an oversight.** A NOT NULL column
-- would turn a green test red — the existing suite builds admission rows by hand, from the owner, to
-- exercise the refusals around the approver — and hardening a table by breaking the test that covers
-- it is exchanging a property for a red build. Every row the application can produce carries it,
-- because the application cannot insert into this table at all and the one writer that can always
-- populates it. The debt is recorded in ADR-026 with the shape of its repayment.
-- ---------------------------------------------------------------------------
alter table kb_gap add column question_sha256 text not null;

alter table kb_gap add constraint kb_gap_question_sha256_shape
  check (question_sha256 ~ '^[a-f0-9]{64}$');

create unique index kb_gap_one_standing_record_per_question
  on kb_gap (ticket_id, question_sha256) where state <> 'CLOSED';

alter table kb_admission add column article_id uuid null;

alter table kb_admission add constraint fk_admission_article_in_snapshot
  foreign key (article_id, snapshot_to) references kb_article (id, kb_snapshot);

-- ---------------------------------------------------------------------------
-- 2 · kb_gap_open — the record of a question the corpus could not answer
--
-- security definer for the reason every privileged writer in this schema is: the application role
-- holds no INSERT on kb_gap and never will, so the record is reachable through this function and
-- through nothing else. That is the pattern the ledger writer and the audit writer established.
--
-- **It rejects in the body and not only by NOT NULL.** Four of the columns are already `not null`,
-- and a caller that omits one gets `23502` — a code that names a column and not a rule, eight frames
-- from whoever has to act on it. The requirement is that a record missing evidence, owner or date is
-- refused BY THE WRITER, so the writer refuses it, by name, and the constraint stays as the second
-- line it always was. What makes "present" mean something is the blank test below: a `null_rule` of
-- three spaces satisfies `not null` and declares nothing.
--
-- **And that test is a regular expression rather than `btrim`, because `btrim` was not enough.** Its
-- default trim set is the SPACE character and nothing else — not a tab, not a newline — so
-- `btrim(E'   \n  ') = ''` is FALSE, and a first draft of this function accepted a record whose
-- entire query evidence was a line break. It satisfied `not null`, it satisfied the guard, and it
-- said nothing at all; the re-run that is supposed to close it would have had a newline to search
-- for. `!~ '[^[:space:]]'` asks the question that was meant: does this value contain a single
-- character that is not whitespace.
--
-- **It does not accept the organisation from its caller.** `security definer` runs the body with the
-- owner's privileges, so a function that took an organisation on trust would let any holder of
-- EXECUTE write a record into any tenant. The organisation is checked against the session's own
-- claim, which is the same reading §3 applies to the advance and for the same reason.
--
-- **Idempotent by mechanism, not by looking first, and the mechanism is now TWO identities.** The
-- unit the requirement counts is the **escalation**: *every `GROUND` escalation has exactly one gap
-- record*. That is a lower bound and an upper bound at once, and the two are held by different
-- things.
--
-- The lower bound is the transaction: this function returns an identifier to the escalation that
-- called it, in the same transaction, and the decision filed beside the transition names it. The
-- upper bound is `question_sha256` — the digest of the question with the corpus left out — under a
-- **partial** unique index that ignores closed records. So a ticket carries at most one STANDING
-- record per question, however many times the question is asked and however often the corpus moves
-- underneath it, and a question that fails again after a verified closure opens a new episode with
-- its own evidence, which is what closure by verification means.
--
-- 0009's `unique (ticket_id, query_sha256)` is **untouched** and `query_sha256` is not redefined: it
-- goes on being the idempotency key of one query under one corpus, which is what makes a retried
-- emission return the same row. The second identity is ADDED beside it, never in place of it.
--
-- **There is no ceiling here, and its absence is a decision.** An earlier draft of this function
-- refused above a count of records per ticket. It was wrong three times over: it counted closed
-- history, so a ticket that had been answered honestly four times could never raise a fifth
-- question; it counted and then inserted, which is a race; and — the one that matters — it raised
-- inside the escalation's own transaction, which does not bound anything, it **destroys the
-- escalation** and leaves the ticket in a state nothing in this system would ever move it out of.
-- With the partial index, "exactly one" stopped being something to count. If a volume guard is ever
-- wanted it belongs on the intake surface, never in this writer.
-- ---------------------------------------------------------------------------
create function kb_gap_open(
  p_gap             uuid,
  p_org             uuid,
  p_ticket          uuid,
  p_query_terms     text,
  p_kb_snapshot     text,
  p_zero_match      boolean,
  p_query_sha256    text,
  p_question_sha256 text,
  p_owner           uuid,
  p_committed_date  date,
  p_null_rule       text,
  p_divergent       uuid[]  default null,
  p_ledger          bigint  default null)
  returns uuid
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  existing uuid;
begin
  if p_org is distinct from (auth.jwt() ->> 'org_id')::uuid then
    raise exception 'E_KB_HUECO_ORG_AJENA';
  end if;

  -- Evidence: what was searched for, under which corpus, and what came back.
  if p_query_terms is null or p_query_terms !~ '[^[:space:]]' then
    raise exception 'E_KB_HUECO_SIN_EVIDENCIA';
  end if;
  if p_kb_snapshot is null or p_kb_snapshot !~ '[^[:space:]]' then
    raise exception 'E_KB_HUECO_SIN_EVIDENCIA';
  end if;
  if p_zero_match is null then
    raise exception 'E_KB_HUECO_SIN_EVIDENCIA';
  end if;
  if p_query_sha256 is null or p_query_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'E_KB_HUECO_SIN_EVIDENCIA';
  end if;
  if p_question_sha256 is null or p_question_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'E_KB_HUECO_SIN_EVIDENCIA';
  end if;

  -- The commitment: who closes it, and by when. Both are human facts and neither is invented here.
  if p_owner is null then
    raise exception 'E_KB_HUECO_SIN_DUENO';
  end if;
  if p_committed_date is null then
    raise exception 'E_KB_HUECO_SIN_FECHA';
  end if;

  -- The rule for what the absence means, declared before the absence rather than after it.
  if p_null_rule is null or p_null_rule !~ '[^[:space:]]' then
    raise exception 'E_KB_HUECO_SIN_REGLA_DE_NULO';
  end if;

  -- The STANDING record for this question on this ticket, whatever corpus it was raised under. This
  -- is what makes a question re-asked after an admission the same episode rather than a new one:
  -- the corpus moved, the query digest moved with it, and the question did not.
  select id into existing from kb_gap
   where ticket_id = p_ticket and question_sha256 = p_question_sha256 and state <> 'CLOSED';
  if existing is not null then
    return existing;
  end if;

  -- And the record for this exact query under this exact corpus, in whatever state it is in. 0009's
  -- uniqueness forbids a second one, so a retried emission finds its own row here.
  --
  -- **Declared residual**: when that row is CLOSED, this returns a closed episode to a live
  -- escalation. It is honest — same question, same corpus, already adjudicated — and it is visible:
  -- a supervisor following the link from an escalated ticket lands on a record marked CLOSED. The
  -- alternative would be writing a second row for a pair the frozen constraint says is one, which is
  -- not this migration's to change. ADR-026 §2 records it.
  select id into existing from kb_gap
   where ticket_id = p_ticket and query_sha256 = p_query_sha256;
  if existing is not null then
    return existing;
  end if;

  -- No conflict target: two uniqueness rules can refuse this row now, and a target would name only
  -- one of them. Whichever refuses, the read-backs below find the row that stands.
  insert into kb_gap (id, org_id, ticket_id, query_terms, kb_snapshot, zero_match, query_sha256,
                      question_sha256, divergent_kb_ids, owner_id, committed_date, null_rule, state,
                      opened_ledger_ref)
  values (p_gap, p_org, p_ticket, p_query_terms, p_kb_snapshot, p_zero_match, p_query_sha256,
          p_question_sha256, p_divergent, p_owner, p_committed_date, p_null_rule, 'OPEN', p_ledger)
  on conflict do nothing;

  -- Read back in the same order the two checks above ask in, because a concurrent writer may have
  -- won either race.
  select id into existing from kb_gap
   where ticket_id = p_ticket and question_sha256 = p_question_sha256 and state <> 'CLOSED';
  if existing is null then
    select id into existing from kb_gap
     where ticket_id = p_ticket and query_sha256 = p_query_sha256;
  end if;
  if existing is null then
    raise exception 'E_KB_HUECO_NO_ESCRITO';
  end if;
  return existing;
end $$;

-- ---------------------------------------------------------------------------
-- 3 · kb_snapshot_advance(bigint, jsonb) — the admission, derived from the row that paid for it
--
-- A SECOND function and not a replacement, because `create or replace` with a different signature
-- does not replace: it creates an overload and leaves the original executable. The original stays
-- exactly as 0009 wrote it — forward-only means it is never edited — and §5 below revokes it from
-- PUBLIC, which is what actually closes the hole it left open.
--
-- **What the hole was, measured rather than supposed.** The original takes the organisation, the
-- outgoing snapshot and the incoming one as parameters and runs `security definer`. Anything holding
-- EXECUTE — which, by the default `create function` applies, was everybody — could therefore write
-- articles into another tenant's corpus and move that tenant's pointer, with no approver, no
-- admission and no ledger row anywhere. Nothing about the call would look unusual.
--
-- **So the parameters go away and the facts come from the ledger row.** `kb_admission.ledger_ref` is
-- NOT NULL with a foreign key, so the row of the chain necessarily exists before the admission does;
-- and its `output` already carries `snapshot_from` and `snapshot_to` by the published contract of its
-- class. The organisation and both snapshots are read from there. There is nothing left for a caller
-- to be wrong about, and the ordering is forced by the keys rather than chosen by whoever writes the
-- next caller.
--
-- **The two ties, which are what put a person in the loop.** The session's organisation must be the
-- row's, and `auth.uid()` must be the `approved_by` the row names: whoever approves IS whoever
-- executes. The machine actor carries an organisation and a role and NO subject, so it fails the
-- second tie by construction rather than by a rule somebody has to apply — there is no session it
-- can present that satisfies it.
--
-- **It writes the admission row too, and that is a consolidation with a reason.** The row is
-- derived, field for field, from the ledger row's own `output`: the same identity, the same gap, the
-- same approver, the same snapshots, the same provenance, the same hash. Written beside the function
-- instead of inside it, the admission would be a second statement of the same fact that could
-- disagree with the chain; written here it cannot, and `article_id` and `content_hash` are checked
-- against the body this call actually inserted rather than against one the caller declared.
--
-- **`citable` loses its default.** The original treats an absent flag as `true`, which is the wrong
-- direction for a value that decides whether a document may be quoted to a customer. Absent is now
-- an error.
--
-- **And the pointer is locked and compared, so two admissions cannot both win.** The outgoing label
-- the row carries has to be the one in force at the moment the corpus actually moves, not merely the
-- one that was in force when the application read it. Without that, two admissions decided in the
-- same window strand one of their documents in silence. The body says what the failure looks like.
-- ---------------------------------------------------------------------------
create function kb_snapshot_advance(p_ledger bigint, p_admitted jsonb)
  returns table (article_id uuid, canonical_key text, body_sha256 text)
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  row_org       uuid;
  row_ticket    uuid;
  row_out       jsonb;
  snapshot_from text;
  snapshot_to   text;
  admission     uuid;
  gap           uuid;
  approver      uuid;
  gap_ticket    uuid;
  item          jsonb;
  body          text;
  digest        text;
  minted        uuid;
  head_now      text;
begin
  select l.org_id, l.ticket_id, l.output into row_org, row_ticket, row_out
    from ledger_entry l
   where l.id = p_ledger and l.class = 'kb_admission';
  if row_org is null then
    raise exception 'E_KB_AVANCE_SIN_FILA';
  end if;

  if row_org is distinct from (auth.jwt() ->> 'org_id')::uuid then
    raise exception 'E_KB_AVANCE_ORG_AJENA';
  end if;

  snapshot_from := row_out ->> 'snapshot_from';
  snapshot_to   := row_out ->> 'snapshot_to';
  admission     := (row_out ->> 'admission_id')::uuid;
  gap           := (row_out ->> 'gap_id')::uuid;
  approver      := (row_out ->> 'approved_by')::uuid;

  if approver is null or auth.uid() is distinct from approver then
    raise exception 'E_KB_AVANCE_SIN_APROBADOR';
  end if;

  if snapshot_from is null or snapshot_to is null or snapshot_from = snapshot_to then
    raise exception 'E_KB_SNAPSHOT_NO_AVANZA';
  end if;
  if exists (select 1 from kb_article where org_id = row_org and kb_snapshot = snapshot_to) then
    raise exception 'E_KB_SNAPSHOT_YA_EXISTE';
  end if;

  -- The corpus this admission was decided under has to be the one still in force, and the pointer is
  -- LOCKED before that is asked.
  --
  -- **The lost update this closes.** The application reads the head, puts it in the chain row as
  -- `snapshot_from`, and calls this. Two admissions decided in the same window therefore read one
  -- head, mint two different successors, copy the same corpus twice and set the pointer twice: the
  -- second wins and the document the first admitted stops being in force — while its chain row, its
  -- `kb_admission` row and its approver all record an admission that happened. Nothing is destroyed,
  -- because the corpus is append-only and the stranded snapshot keeps its articles; but the gap the
  -- first was raised for can then never close, because the closure asks the corpus IN FORCE for the
  -- admitted key and it is not there. A supervisor is left with an admission that succeeded and a
  -- gap that will not shut, and nothing on any screen connects the two.
  --
  -- `for update` is what makes the check mean anything rather than merely usually hold: the second
  -- transaction blocks here until the first commits, then reads the pointer the first moved and is
  -- refused by name. Read without the lock, both would pass the comparison and both would write.
  --
  -- **It is asked AFTER the two above, and the order is deliberate.** A retried admission — the same
  -- chain row replayed — trips both this and `E_KB_SNAPSHOT_YA_EXISTE`, and "this admission has
  -- already happened" is the more useful of the two things to be told. This one is for the case
  -- nobody has a word for yet, so it gets the message about the corpus having moved.
  select kb_snapshot into head_now from kb_snapshot_head where org_id = row_org for update;
  if head_now is distinct from snapshot_from then
    raise exception 'E_KB_SNAPSHOT_MOVIDO';
  end if;

  -- The chain row has to hang off the gap's own ticket, or the admission does not appear in the
  -- panel that shows the ticket's chain and the evidence of the cycle is invisible where it is read.
  select g.ticket_id into gap_ticket from kb_gap g where g.id = gap and g.org_id = row_org;
  if gap_ticket is null then
    raise exception 'E_KB_ADMISION_SIN_HUECO';
  end if;
  if row_ticket is distinct from gap_ticket then
    raise exception 'E_KB_ADMISION_SIN_TICKET';
  end if;

  if row_out -> 'provenance' is null or jsonb_typeof(row_out -> 'provenance') <> 'object' then
    raise exception 'E_KB_ADMISION_SIN_PROVENIENCIA';
  end if;

  -- One body per admission, because one admission names one article: `kb_admission.article_id` is a
  -- single reference and a list would have to pick one of its own elements to put in it.
  if p_admitted is null or jsonb_typeof(p_admitted) <> 'array' or jsonb_array_length(p_admitted) <> 1 then
    raise exception 'E_KB_ADMISION_NO_ES_UNA';
  end if;
  item := p_admitted -> 0;

  if item ->> 'canonical_key' is null or item ->> 'title' is null or item ->> 'body' is null then
    raise exception 'E_KB_ADMISION_INCOMPLETA';
  end if;
  if item -> 'citable' is null or jsonb_typeof(item -> 'citable') <> 'boolean' then
    raise exception 'E_KB_ADMISION_SIN_CITABILIDAD';
  end if;

  body := item ->> 'body';

  -- A body that does not fit whole into one excerpt is refused rather than trimmed. The retrieval
  -- truncates at the envelope's bound, so an article whose deciding sentence falls after the cut
  -- would be quoted to a customer with the deciding sentence missing — and the gap it was admitted
  -- to close would close on padding. 2048 is `EXCERPT_MAX` of the published envelope contract; the
  -- two are compared by a test rather than kept in step by hand.
  if length(body) > 2048 then
    raise exception 'E_KB_ADMISION_NO_CABE_EN_EXTRACTO';
  end if;

  digest := encode(sha256(convert_to(body, 'UTF8')), 'hex');
  if row_out ->> 'content_hash' is distinct from digest then
    raise exception 'E_KB_ADMISION_HASH_NO_CUADRA';
  end if;

  -- The complete copy, exactly as 0009 argues it: a snapshot is a set and never a delta.
  insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
  select gen_random_uuid(), a.org_id, snapshot_to, a.canonical_key, a.title, a.body, a.body_sha256, a.citable
    from kb_article a
   where a.org_id = row_org and a.kb_snapshot = snapshot_from;

  minted := gen_random_uuid();
  insert into kb_article (id, org_id, kb_snapshot, canonical_key, title, body, body_sha256, citable)
  values (minted, row_org, snapshot_to, item ->> 'canonical_key', item ->> 'title', body, digest,
          (item ->> 'citable')::boolean);

  insert into kb_admission (id, org_id, gap_id, approved_by, snapshot_from, snapshot_to,
                            content_hash, provenance, ledger_ref, article_id)
  values (admission, row_org, gap, approver, snapshot_from, snapshot_to, digest,
          row_out -> 'provenance', p_ledger, minted);

  insert into kb_snapshot_head (org_id, kb_snapshot, set_by, set_at)
  values (row_org, snapshot_to, p_ledger, now())
  on conflict (org_id) do update
    set kb_snapshot = excluded.kb_snapshot, set_by = excluded.set_by, set_at = excluded.set_at;

  return query select minted, item ->> 'canonical_key', digest;
end $$;

-- ---------------------------------------------------------------------------
-- 4 · kb_gap_close_by_verification — four clauses of a requirement, as four refusals
--
-- A NEW function beside `kb_gap_close_by_check`, which stays exactly as it is. Recreating the old
-- one under a wider signature would have produced an overload, not a replacement, and dropping it
-- would break a green test that calls it. §5 revokes it from PUBLIC instead, so the closure the
-- application can reach is this one and only this one.
--
-- The requirement says a gap closes only when the original query, re-run against the snapshot in
-- force, comes back grounded on the admitted source. Four things have to be true, and until now all
-- four were sentences in a record:
--
--   1. the answer is anchored — `grounded` is true, and not merely present;
--   2. it belongs to the same organisation as the gap;
--   3. it was produced under the snapshot **in force**;
--   4. it cites material admitted against THIS gap.
--
-- **Nothing load-bearing is taken from the caller.** The function's whole argument list is a gap and
-- an answer; every fact it decides on is read out of rows. An earlier draft took the canonical key
-- as a parameter, and that was the hole: anybody holding EXECUTE could close a gap "on the admitted
-- source" by naming any key the answer happened to cite — a pre-existing article, for instance —
-- which is precisely the caller being believed instead of refused. The key is now derived inside,
-- from the admission's own `article_id`.
--
-- **The fourth is matched by canonical key and never by identity, and that is not a preference.**
-- An advance mints a new identity for every row it copies, so the article the admission recorded and
-- the article standing under the corpus in force are different rows with the same key. The key is
-- copied verbatim and its shape is constrained; the identity is not comparable across an advance.
--
-- **The third is the snapshot IN FORCE and not an ordering between labels.** The requirement says
-- *re-run against the current snapshot*, and "current" is an equality against the pointer, not a
-- comparison between two strings — 0009 §1 already refuses to order snapshot labels, because `max`
-- over text is an alphabetical accident that happens to agree with time. An earlier draft required
-- the answer's snapshot to be the one THIS gap's admission advanced into, and that quietly made the
-- system serial: with two gaps open, any advance for the first left the second permanently
-- unclosable, because its own admission would start from a label that was no longer where the gap
-- had been opened. Comparing against the head is both the letter of the requirement and the thing
-- that lets two gaps be worked in either order.
--
-- **The witness is the ledger row of the validation, taken from the response rather than from the
-- caller.** A closure that accepted a row number would accept any row number: a caller could name a
-- checkpoint written last week and the gap would close carrying a witness that proves nothing about
-- it. Reading it from the answer is what makes the witness the answer's own.
-- ---------------------------------------------------------------------------
create function kb_gap_close_by_verification(p_gap uuid, p_response uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  gap_org      uuid;
  gap_state    kb_gap_state;
  res_org      uuid;
  res_snapshot text;
  res_grounded boolean;
  res_witness  bigint;
  head         text;
begin
  -- 0 · the caller's own organisation, folded into the read of the gap itself.
  --
  -- **This is `security definer`, so RLS does not apply inside it — and without this line the
  -- function undid the policy that hides the row.** A session of another tenant could not SEE this
  -- gap under RLS and could still close it, because every check below compares the gap against the
  -- ANSWER and none of them compared either against the session. Measured, in a transaction that was
  -- rolled back: a Corella Health session read zero rows for a Northwind gap and then closed it.
  --
  -- §2 of this file already set the standard — a function that took the organisation on trust would
  -- let any holder of EXECUTE write a record into any tenant — and this function was the one that
  -- did not meet it. "Nothing load-bearing is taken from the caller" was true of the FACTS it
  -- decides on and false of the AUTHORISATION to decide them, which are not the same claim.
  --
  -- It is folded into the read rather than added as a check afterwards, so a foreign session is
  -- refused with "no such gap" — indistinguishable from one that does not exist, which is the
  -- doctrine the application surface already applies at this boundary.
  select g.org_id, g.state into gap_org, gap_state
    from kb_gap g
   where g.id = p_gap and g.org_id = (auth.jwt() ->> 'org_id')::uuid;
  if gap_org is null then
    raise exception 'E_KB_CIERRE_SIN_HUECO';
  end if;
  if gap_state <> 'OPEN' then
    raise exception 'E_KB_CIERRE_HUECO_NO_ABIERTO';
  end if;

  select t.org_id, r.kb_snapshot, r.grounded, r.validate_ledger_ref
    into res_org, res_snapshot, res_grounded, res_witness
    from response r join ticket t on t.id = r.ticket_id
   where r.id = p_response;
  if res_org is null then
    raise exception 'E_KB_CIERRE_SIN_RESPUESTA';
  end if;

  -- 2 · the same organisation. Checked before anything else is read out of the answer, so a caller
  --     cannot learn whether another tenant's answer exists from which refusal comes back.
  if res_org is distinct from gap_org then
    raise exception 'E_KB_CIERRE_ORG_AJENA';
  end if;

  -- 1 · anchored, and with the row that paid for the verdict.
  if res_grounded is not true then
    raise exception 'E_KB_CIERRE_SIN_ANCLAJE';
  end if;
  if res_witness is null then
    raise exception 'E_KB_CIERRE_SIN_TESTIGO';
  end if;

  -- 3 · produced under the corpus in force, which is what "the current snapshot" means.
  select h.kb_snapshot into head from kb_snapshot_head h where h.org_id = gap_org;
  if head is null or res_snapshot is null or res_snapshot is distinct from head then
    raise exception 'E_KB_CIERRE_SNAPSHOT_NO_VIGENTE';
  end if;

  -- 4 · and it cites material admitted against THIS gap, matched by the key that survives an
  --     advance and derived here rather than accepted from whoever called.
  --
  --     The chain of joins is the whole argument: an admission for this gap names an article; that
  --     article carries a canonical key; the corpus in force carries a row under the same key; and
  --     the answer cites THAT row. Nothing in it is a value the caller supplied.
  if not exists (
       select 1
         from kb_admission m
         join kb_article admitted
           on admitted.id = m.article_id and admitted.kb_snapshot = m.snapshot_to
         join kb_article standing
           on standing.canonical_key = admitted.canonical_key
          and standing.org_id = gap_org
          and standing.kb_snapshot = res_snapshot
         join response_citation c
           on c.kb_article_id = standing.id and c.kb_snapshot = standing.kb_snapshot
        where m.gap_id = p_gap
          and m.org_id = gap_org
          and c.response_id = p_response) then
    raise exception 'E_KB_CIERRE_SIN_CITA_ADMITIDA';
  end if;

  perform set_config('ledgerdesk.kb_gap_close', p_gap::text, true);
  update kb_gap set state = 'CLOSED', closed_by_check_at = now(), closing_ledger_ref = res_witness
   where id = p_gap;
  perform set_config('ledgerdesk.kb_gap_close', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- 5 · Every privileged function stops being public, as a standing rule
--
-- **This is not an oversight of 0009 being corrected: it is the default of `create function` being
-- refused.** PostgreSQL grants EXECUTE to PUBLIC on every new function, so a `security definer`
-- function is, on the day it is written, a privilege escalation available to every role in the
-- cluster unless somebody says otherwise. Nobody had said otherwise. The consequence was measured
-- rather than supposed: the application role could write articles into another organisation's corpus
-- and move that organisation's snapshot pointer, with no approver, no admission and no row in any
-- chain.
--
-- **The rule, from today: every function this repository creates with `security definer` carries its
-- own revocation in the same migration.** It is written in `migrations/README.md` as well, because a
-- rule that lives only in the migration that discovered it is a rule the next migration forgets.
--
-- **The three that keep an application caller are the three the application calls.** The other three
-- are revoked and granted to nobody: they remain reachable by the owner — which is what the SQL
-- tests run as — and unreachable by anything the application can present. Granting `app_rw` EXECUTE
-- on the original advance would have handed back the exact hole this section closes.
--
-- **Trigger functions are deliberately outside this sweep, and the reason is stated so the omission
-- is not read as one.** A trigger function is not callable: invoking one directly raises "trigger
-- functions can only be called as triggers", so its EXECUTE privilege grants nothing to anybody.
-- What it does do is gate `create trigger`, which the migrations perform as the owner. Revoking it
-- would therefore buy no property and would change the conditions under which every existing trigger
-- fires, which is not a trade this card can measure. `test_SEC_kb_definer_functions_are_not_public`
-- sweeps `pg_proc` under the same rule rather than a list, so a callable definer function added
-- tomorrow is covered without anybody remembering this paragraph.
-- ---------------------------------------------------------------------------
revoke execute on function kb_gap_close_by_check(uuid, bigint) from public;
revoke execute on function kb_gap_mark_not_documentable(uuid, text) from public;
revoke execute on function kb_snapshot_advance(uuid, text, text, jsonb, bigint) from public;

revoke execute on function kb_gap_open(uuid, uuid, uuid, text, text, boolean, text, text, uuid, date, text, uuid[], bigint) from public;
revoke execute on function kb_snapshot_advance(bigint, jsonb) from public;
revoke execute on function kb_gap_close_by_verification(uuid, uuid) from public;

grant execute on function kb_gap_open(uuid, uuid, uuid, text, text, boolean, text, text, uuid, date, text, uuid[], bigint) to app_rw;
grant execute on function kb_snapshot_advance(bigint, jsonb) to app_rw;
grant execute on function kb_gap_close_by_verification(uuid, uuid) to app_rw;

-- ---------------------------------------------------------------------------
-- 6 · The admission becomes readable, and readable is all it becomes
--
-- The panel that exhibits the admission cannot read the table at all today, and the repair anybody
-- would make on meeting an empty panel is the one that opens the hole: a grant of INSERT alongside
-- the SELECT, because the writer is right there. The writer is a security definer function and the
-- application role reaches the row through EXECUTE, exactly as it reaches the gap record.
--
-- No INSERT and no UPDATE on kb_admission, today or ever. An admission the application could write
-- directly is an admission with no approver tied to the session that made it, and the tie is the
-- whole of what makes a human approver mean anything.
-- ---------------------------------------------------------------------------
grant select on kb_admission to app_rw;

-- ---------------------------------------------------------------------------
-- 7 · The gap queue stops showing one customer's words to another
--
-- `tenant_isolation_kb_gap` is PERMISSIVE and covers the organisation, and there is no restrictive
-- policy on SELECT — whereas `ticket`, which holds the same words, has carried `customer_own_rows`
-- since 0001. `kb_gap.query_terms` is the ticket's own subject and body in clear, so the queue this
-- card creates would have published one customer's enquiry to every other customer of the tenant.
--
-- RESTRICTIVE, so it ANDs with the tenant policy rather than widening it, and the organisation
-- clause stays inside it so that deleting the permissive policy still fails closed. Staff only:
-- a gap record is a work item, and the person who raised the ticket is not the person who closes it.
-- ---------------------------------------------------------------------------
create policy kb_gap_read_is_staff on kb_gap as restrictive for select
  using (org_id = (auth.jwt() ->> 'org_id')::uuid
         and (auth.jwt() ->> 'role') in ('agent', 'supervisor'));

-- ---------------------------------------------------------------------------
-- 8 · Four bounds that were prose
--
-- A commitment that is already overdue on the day it is made is not a commitment, and a record that
-- carried one would show a supervisor a date in the past beside a gap opened this minute.
--
-- The reason a gap could not be documented is bounded in BYTES and not in characters, and the
-- distinction is the one this card keeps making: 512 characters of CJK are 1 536 bytes, so a bound
-- written in characters admits three times the storage it declares on exactly the input where the
-- difference matters. `octet_length` is what the declared number means.
-- ---------------------------------------------------------------------------
-- The day is taken in UTC, and the cast is written that way because it has to be: a bare
-- `created_at::date` reads the session's time zone, which makes the expression STABLE rather than
-- IMMUTABLE, and PostgreSQL refuses a check constraint built on one. Pinning the zone is not a
-- workaround for that refusal — it is the thing the refusal is asking for. A commitment that meant a
-- different day depending on who was connected would be a commitment with two due dates, and the
-- writer computes the same day in the same zone.
alter table kb_gap add constraint kb_gap_commitment_is_not_born_overdue
  check (committed_date >= (created_at at time zone 'UTC')::date);

alter table kb_gap add constraint kb_gap_not_documentable_reason_is_bounded
  check (not_documentable_reason is null or octet_length(not_documentable_reason) <= 512);

-- The snapshot labels of an admission travel into `state_hash` and into a composite reference, so a
-- label with two spellings is two corpora. Same alphabet the knowledge-base identifier is built on.
alter table kb_admission add constraint kb_admission_snapshot_shape
  check (snapshot_from ~ '^[A-Za-z0-9:._-]{1,64}$' and snapshot_to ~ '^[A-Za-z0-9:._-]{1,64}$');

-- ---------------------------------------------------------------------------
-- 9 · One ledger row per admission, by index rather than by discipline
--
-- The chain row and the advance are in two transactions on two pools and there is no distributed
-- transaction to be had. What makes that window recoverable instead of duplicating is this index,
-- in the same shape 0002 already uses for the opening of a promotion attempt: a retry carrying the
-- same admission identity collides, the writer reads the collision as "already written" and carries
-- on with the row that stands rather than writing a second one.
-- ---------------------------------------------------------------------------
create unique index ledger_admission_unique_per_admission
  on ledger_entry ((output->>'admission_id')) where class = 'kb_admission';
