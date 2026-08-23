# ADR-026 · The knowledge gap becomes a record, the admission becomes one transaction with a person in it, and every privileged function stops being public

**Status:** accepted · **Decision date:** 2026-08-24

**On the number.** ADR-001…ADR-017 were taken during the design phase and are being curated into this directory; 018–021, 023, 024 and 025 are spoken for by the accepted files here, and 022 by a repository-process decision recorded outside it. This takes **026**, the next free index.

**On citing a decision by number at all, which this increment found is ambiguous.** The same three-digit indices name **different** decisions in this directory and in the project's separate decision register — 019, 020 and 021 are each two different things depending on which register a reader has in hand, and one of them is the decision that authorised the fourth channel this ADR lands. The rule from today, and it applies to every file in this repository: **an unqualified `ADR-NNN` always means the file of that name in `adr/`**, and a decision taken outside this directory is described rather than cited by bare number. Nothing already written is rewritten for it — a decision is amended by a new dated record, never by editing an old one — and this paragraph is the amendment.

## Context

0009 built the receiver's half of the knowledge gap and left the writer to the increment that owns it. `kb_gap` has held a shape since the first migration and nothing has ever written a row into it; `kb_admission` has held the record of material being let in and nothing has ever let anything in; `NOT_DOCUMENTABLE` gained a writer and `CLOSED` gained a function, and neither had a caller. The clause `draft_not_grounded` fires today and produces an escalation and nothing else.

This increment closes the cycle: a typed record when the corpus cannot answer, a versioned admission with provenance and a human approver, the same question asked again, and a closure that has to be earned. Four things stood in the way and each has a section below — the two human fields the schema demands and no machine knows; a channel with no home that a validator could reach; a privileged function that anybody could call; and a closure whose four conditions were four sentences in a record.

`migrations/` and `quality/schemas/` are both frozen scope, so this record precedes the merge rather than describing it afterwards. It amends the schema ADR-018 registered and, with it, the committed dump `ci/expected/schema.sql`, which is compared in **both** directions with no exception list.

## Decision

### 1 · The human fields are a commitment the organisation makes in advance

`kb_gap.owner_id` and `kb_gap.committed_date` are `not null`, and both are facts no machine knows: who owns closing this gap, and by when. The instant they are needed is the worst available for asking anybody — inside the server transaction that escalates the ticket, downstream of a retrieval that found nothing, with nobody in the loop. `owner_id` also carries a composite reference to a real user of the same organisation, so there is no placeholder that would even be accepted.

Three instantiations were considered and two are not executable against the schema as it stands. Typing them into the admission form is a different moment, hours later, and leaves the record unwritable in the meantime. Reading them per gap from a system that tracks who work is assigned to needs such a system, and this deployment has none — nor does the contract ask for one.

**Decided: a typed, versioned commitment per organisation, authored in advance.** It declares the person who owns knowledge gaps there, the term within which they are answered, and the sentence a human wrote saying so. At emission the record is built from it, and the receiver validates that the owner resolves to a live user of the same organisation. **Nobody invents an owner: a person wrote one down beforehand.**

**Which side of the channel it sits on, corrected against the published contract.** The brief for this card placed the artefact on the receiver, which would have the receiver *supplying* two fields the contract assigns to the channel — and the single-source rule exists precisely so that a refusal can name which side was wrong. The published division of labour says the receiver **validates and never supplies**, so the artefact sits on the producer's side and the receiver does exactly what the contract says it does.

**And there is no deviation from the contract here, which is worth stating plainly because an earlier draft of this record claimed there was.** The contract says the channel *transports* these two fields and that the receiver validates rather than supplies them. It says **nothing at all** about where the producer gets them from — no upstream system, no work-tracking tool, no source of any kind is named anywhere in it. That silence is the whole of the problem this section answers, and filling it is completion rather than departure.

The contract also publishes the precedent for exactly this shape, one row above in its own table of who supplies what: **`null_rule` — supplied by the receiver, *from configuration, declared in advance***. A field whose value is a human declaration made before the moment it is needed is a form the contract already blesses; the commitment is that form applied on the producer's side, where the contract puts these two. What the requirement insists on is that nobody invents an owner at the instant of failure, and a declaration made in advance by a named person is the strongest available way of not inventing one — stronger than reading it out of a system that would have to be asked, and available at an instant when nothing can be asked at all.

**The artefact names its author.** `declared_by` and `declared_on` are part of it, because an owner assigned by a document nobody signed is an owner assigned by nobody — which is the failure the commitment exists to prevent, moved one level up, and it is the second question any reader asks. Both are resolved against `app_user` exactly as the owner is.

**Two refusals, not one.** The receiver already refuses an `owner_id` that does not resolve to a live user of the same organisation; it now also refuses a `committed_date` that has already passed. The database refuses a record born overdue as well, and keeping both is deliberate: the receiver's refusal can name the artefact, and the constraint is the line that holds whatever calls it.

**The three alternatives, and why each was rejected rather than merely not chosen.** A `kb_gap_duty` table puts the commitment where the tenant's own administrators would edit it, which is right eventually and is a migration, an access surface and an audit story this card does not own. A document anchored in the ledger gives it provenance and gives the emission a file to read at the instant it must not be reading files. And **inferring the owner from the supervisor role** reads like the obvious rule and is the worst of the three: one of the two organisations seeded here has no supervisor at all, so it would produce no owner, silently, at the moment a retrieval failed. `test_KB_gap_commitment_names_live_users_of_its_organisation` measures that organisation by name.

**The point that moves if this is decided differently:** `src/server/kb/commitment.ts` in full, and the producer half of `gapChannelRecordFor` in `src/server/kb/gap.ts`. The receiver, the channel, the schema and the writer are unaffected by which of the three instantiations is chosen — that is what makes this a cheap decision to revisit and an expensive one to leave implicit.

### 2 · The unit is the ESCALATION, and nothing a writer refuses may take one down

**The requirement counts escalations, and this card had been reading it as counting queries.** `docs/PROPOSAL.md` publishes FR-A15's closing evidence in as many words: *Every `GROUND` escalation has exactly one gap record; a record missing evidence, owner or date is refused by the writer.* The phrase *exactly one gap record per unanswered query* appears twice in this repository — in the comment of `migrations/0009` and in ADR-024 — and both present it as a quotation of the requirement. **It is not one.** The requirement never said query.

**ADR-024 is amended by this record, on this date, in that one sentence.** `0009` is not edited: forward-only means an applied migration is never rewritten, and a comment is not worth a migration. Both stand as written and this is the amendment that governs.

#### What the two bounds are, and what holds each

*Exactly one* is a lower bound and an upper bound, and they are different mechanisms.

**The lower bound is the transaction.** The writer returns an identifier to the escalation that called it, in the same transaction, and the decision filed beside the transition names it. The instrument was already there: the append-only chain holds one `TICKET_ESCALATED` row per escalation, and each one now carries the `gap_id` it rested on. Counting escalations is counting those rows.

**The upper bound is a second identity under a partial index.** `question_sha256` is the digest of the question with the corpus left out, and `kb_gap` is unique over `(ticket_id, question_sha256)` **where the record is not closed**. So a ticket carries at most one *standing* record per question, however often the corpus moves underneath it.

The card had already computed that identity and thrown it away: the channel carries it, the receiver ties it, and `src/alg/gap_channel.ts` says in its own words that it *lets a re-run under a new corpus be recognised as the same question asked again*. The writer simply never received it. The case that made the omission expensive is not exotic — it is the ordinary one: **somebody else's admission moves the corpus, the question is asked again, and a second record appears** with its own owner and its own committed date, for a question nobody had answered once.

**0009's `unique (ticket_id, query_sha256)` is untouched and `query_sha256` is not redefined.** The two identities do two jobs: one makes a retried emission the same row under one corpus, the other makes an episode one record across corpora. A second identity is added beside the first, never in place of it.

#### Why closed records are outside the index

A closure that also banned the question for ever would be a system that answered something once and had no way to say the answer had stopped being enough. A record closed **by verification** is finished, not forbidden: if the question fails again, a new episode opens with its own evidence, its own owner and its own date. That is what closure by verification has to mean.

**Declared residual.** When the same question fails again under the **same** corpus and nothing is standing, the writer returns the closed record, because the frozen uniqueness of 0009 says that pair is one row. It is honest — same question, same corpus, already adjudicated — and it is visible: a supervisor following the link from a live escalation lands on a record marked `CLOSED`. It is asserted in `test_KB_gap_closed_question_reopens_as_a_new_record` so that it cannot quietly become something else.

#### Nothing a writer refuses may take down the transition that invoked it

This is a rule, not a repair, and it came out of a mechanism that was proposed for this card and would have been worse than the problem it solved.

The proposal was a ceiling: refuse above so many records per ticket. **It was wrong three times over.** It counted closed history, so a ticket honestly answered four times could never raise a fifth question. It counted and then inserted, which is a race. And — the one that matters — **it raised inside the escalation's own transaction.** The emission runs inside the transaction that moves the ticket to `ESCALATED` and files the decision, and in PostgreSQL a failed statement poisons the whole transaction. A ceiling that fired would not have bounded the archive: it would have **destroyed the escalation** and left the ticket in the state it started in, with nothing to move it. There is no sweeper in this system and there is deliberately not meant to be one.

**So the ceiling is gone and is not replaced by another counter** — with the partial index, *exactly one* stopped being something to count. If a volume guard is ever wanted it belongs on the intake surface, never in this writer.

**And the general rule is implemented rather than remembered.** The emission runs inside a savepoint of its own. A refusal — from the channel, from the receiver's validation, from a constraint — rolls back to the savepoint and comes back as a code, which is filed in the decision as `gap_refused` beside a null `gap_id`. The escalation commits either way. The escalation is a fact about the ticket; the record is evidence about that fact; losing the evidence is bad and is reported, losing the fact is worse and is now unrepresentable.

#### The domain of the emission is narrower than the domain of the clause

All three entries into the escalation funnel fire `draft_not_grounded`, because all three report `grounded: false`. Only one of them is a statement about the **corpus**: a retrieval that produced nothing usable, or a draft the grounding conjunction rejected. The other two are a provider that could not answer — every attempt failed, or the validation never came back — and `grounded: false` is set there unconditionally because the cycle has nothing else to say.

**Those two emit no record.** Filing a knowledge gap on a timeout would put a permanent claim about the corpus into the record every time a model was slow, and the re-run that is supposed to close it would have nothing to close against, because nothing about the corpus was ever established. The reading of ADR-024 §11 stands unchanged — the emission fires on the **clause**, not on the stored reason — and this narrows *which firings of the clause are about a corpus at all*.

**On `opened_ledger_ref`, which a reader will look for.** The canonical `GROUND` escalation writes **no ledger row**: nothing is retrieved, no model is called, and the beat costs zero. So that column is null in exactly the case FR-A15 governs, and any uniqueness built over it would restrict nothing. The durable identity of an escalation is its `TICKET_ESCALATED` row in the chain, and that is where this record points readers.

#### The point that moves if the scope is decided differently

The uniqueness. Under the reading this record rejects — one per (ticket, query, corpus) — the partial index comes out and `question_sha256` becomes a column nothing reads. Under a reading that ignored closure, the index loses its `where` clause. Everything else in the cycle is indifferent.

### 3 · The fourth declared channel: where it lives, and what validates it

The boundary publishes a closed set of typed channels with declared caps. Three have crossed it since the seam was written — the drafted answer, the closed alphabet of escalation codes, the promotion gate's one bit — and the knowledge-gap record is the fourth. **The count moves the day the channel lands and not the day it was authorised**, because a check expecting four against code that exposes three fails a build for a reason that is not its own.

The document is domiciled in `quality/schemas/gap_channel.schema.json`, which has **no reader at run time** and which the module boundary forbids the application to import. The arrangement that satisfies the domicile, the coverage and the seam is the one the published agent envelope already lives under:

- **Authored in TypeScript** (`src/alg/gap_channel.ts`), emitted to the frozen path, and **diffed in CI**. The receiver validates from the authored value and never opens the file: a server bundle does not carry the repository's directory layout, and a receiver that had to find a file to learn its own contract is a receiver that cannot start.
- **Executable cover**: the published file is added to the cases of `ci/schema_check.mjs`, which is what makes implementing `enum`, `maxLength` and `maxItems` load-bearing rather than optional — that validator throws on a keyword it does not implement, and the throw is deliberately not silenced, because a validator that ignored a keyword would let a fixture pass for the wrong reason.
- `format` is annotation only. Every field that carries one also carries a `pattern`, and the pattern is what decides; a schema whose strictness depended on which validator read it would be a schema with two meanings.

**Every cap is measured in BYTES**, with `Buffer.byteLength(value, 'utf8')`. 512 characters of CJK are 1 536 bytes, so a cap enforced on string length — which counts UTF-16 units — admits three times the payload the contract declares, on exactly the inputs where the difference matters. The published JSON document also carries `maxLength`, and that keyword is defined over code points, so the document is the weaker of the two bounds and the receiver is the binding one. They are not in competition: the document says what shape a record has, and the receiver says how much of it may arrive.

**The declared «≤ 1024 B per record» does not say what the bytes are measured over.** Fixed here as **the sum of the per-field caps**, which is a precision of the contract and not a change to it. The nine caps — 36 + 64 + 64 + 64 + 36 + 10 + 16 + 144 + 512 — sum to **946 bytes**, of which at most 512 are open content, so the bound is respected by construction rather than by a check at the border.

**The receiver ties, validates, and refuses whole.** Three refusals, all `E_CONTRATO`: a `state` other than `OPEN` on emission — a record born closed would close a gap through the channel, which is the one thing the closure requirement forbids; a `query_sha256` or a `canonical_key_sha256` that does not match the receiver's own recomputation from the terms it searched with; and an `owner_id` that does not resolve to a live user of the same organisation. **Nothing is truncated and nothing is filled in.** A trimmed note is a sentence its author did not write, and a filled-in owner is the invention the field exists to prevent.

**A precision on `query_sha256`, which is NOT a change to it.** It is `sha256(query_terms ‖ kb_snapshot)`, concatenated without a separator, exactly as the column's own frozen comment writes it. Strictly, a boundary shift makes distinct pairs collide in principle: terms ending in what another snapshot label begins with. It is harmless in practice — both sides compute the same function of the same two values, so the tie holds either way — but *identical by construction* overstates it by a hair, and the honest form is *identical by construction for every pair this system can produce*. The published comment governs and the code is left alone; this is the note that keeps the claim accurate.

**`canonical_key_sha256`, instantiated.** The contract requires it and the contract also requires it to be a **tie** — something the receiver recomputes and compares. A gap born of `GROUND` has no article key to hash, because the corpus matched nothing. It is therefore fixed as **the digest of the question's canonical form**: the identity of a gap *across* corpora, where `query_sha256` is its identity *under one*. The pair is what makes «the same question asked again after the corpus moved» a statement with a value behind it, and the reading is fixed now, before the ninth escalation index exists, so that it does not arrive and find the field already meaning something else.

### 4 · `E_CONTRATO` enters the application surface register, and the partition is answered

The code appears in none of the three registers of this repository, and all three declare themselves closed and disjoint by construction. It belongs to none of them by inheritance: it is the **boundary's**, fixed by the seam's own contract, which says an out-of-contract payload is refused *rather than truncated in silence*.

**Decided: it enters `src/server/errors.ts` by this record**, and the reason answers the partition rather than ignoring it. That register owns the HTTP surface of the three consoles — what a request did wrong, read by whoever wrote the client — and the receiver of the fourth channel is a console route: the emission is reached through a drafting cycle a person triggers, and the admission through a route that carries a body. A code raised on an HTTP surface and reported to whoever made the request is that register's kind of failure, whatever its origin. The other two registers are untouched.

`E_RUNTIME_SNAPSHOT_STALE` enters the same register by the same decision; §9 is what raises it.

### 5 · Two ceilings, both declared, and they are not the same number

The admission route is the only route in this system that carries a **document**, and its two siblings deliberately carry no payload at all. Two bounds therefore apply to it and confusing them would break either the channel or the product:

| Bound | Value | What it is a statement about |
|---|---|---|
| The gap channel's record | **1 024 B**, of which the caps use 946 | how much a producer may **say** |
| The admission request body | **16 384 B** | how much an HTTP request may **weigh** |

An article is bigger than a note by construction — up to an excerpt's worth of prose, which is thousands of bytes in UTF-8 — so a route sized to the channel would refuse every legitimate admission. Sixteen kibibytes leaves room for a body at the excerpt bound in a script costing three bytes a character, plus its title, its key and its provenance, and nothing like room for a payload nobody intended to send. Over the ceiling is `E_CONTRATO` and 413, refused whole.

### 6 · Every privileged function stops being public, as a standing rule

**This is not an oversight of 0009 being corrected. It is the default of `create function` being refused.** PostgreSQL grants EXECUTE to PUBLIC on every new function, so a `security definer` function is, on the day it is written, a privilege escalation available to every role in the cluster unless somebody says otherwise. Nobody had said otherwise, for three migrations.

The consequence was **measured rather than supposed** during this card's review, by execution in a transaction that was rolled back: the application role could write articles into another organisation's corpus and move that organisation's snapshot pointer — with no approver, no admission and no row in any chain. Nothing about the call would look unusual.

**The rule, from today: every function this repository creates with `security definer` carries its own revocation in the same migration.** It is written into `migrations/README.md` as well, because a rule that lives only in the migration that discovered it is a rule the next migration forgets.

Three functions keep an application caller because the application calls them: `kb_gap_open`, `kb_snapshot_advance(bigint, jsonb)` and `kb_gap_close_by_verification`. The other three are revoked and granted to nobody — reachable by the owner, which is what the SQL suite runs as, and unreachable by anything the application can present. **Granting `app_rw` EXECUTE on the original advance would have handed back the exact hole this section closes**, and the brief's instruction to grant on all of them is departed from for that reason, declared here rather than resolved in silence.

**Trigger functions are outside the sweep, and the exclusion is stated so it is not read as an omission.** A trigger function is not callable — invoking one directly raises *trigger functions can only be called as triggers* — so its EXECUTE privilege grants nobody anything. What that privilege does gate is `create trigger`, which the migrations perform as the owner. Revoking it would buy no property and would change the conditions under which every existing trigger fires, which is not a trade this card can measure. `test_SEC_kb_definer_functions_are_not_public` sweeps `pg_proc` under the same rule rather than a hand-written list, so a callable definer function added tomorrow is covered without anybody remembering this paragraph.

**The golden schema is regenerated**, because a revoke changes an ACL from null to explicit and the applied schema is compared against the committed dump in both directions with no exception list.

### 7 · The advance is re-signed, and the original is left exactly as it is

`create or replace` with a different signature does not replace: it creates an **overload** and leaves the original executable. So `kb_snapshot_advance(bigint, jsonb)` is a second function; 0009's is untouched, because forward-only means an applied migration is never edited, and §6 is what actually closes what it left open. Dropping it was rejected: a green test calls it.

The parameters go away and the facts come from the row of the chain. `kb_admission.ledger_ref` is `not null` with a foreign key, so the row necessarily exists before the admission does, and its `output` already carries `snapshot_from` and `snapshot_to` by the published contract of its class. The organisation and both snapshots are read from there; there is nothing left for a caller to be wrong about, and the ordering is forced by the keys rather than chosen by whoever writes the next caller.

Two ties are checked in the body. The session's organisation must be the row's. And **`auth.uid()` must be the approver the row declares — whoever approves is whoever executes**, which puts the machine actor out of reach by construction rather than by rule: it carries an organisation and a role and no subject, so there is no session it can present that satisfies the tie.

**It writes the `kb_admission` row too, and that consolidation is a decision.** The brief ordered the row as a separate step after the advance. Written beside the function, the admission would be a second statement of a fact the chain already holds and could disagree with it; written inside, every field is derived from the chain row — the same identity, gap, approver, snapshots, provenance and hash — and `article_id` and `content_hash` are checked against the body this call actually inserted rather than against one the caller declared. `p_admitted` remains a parameter because the chain carries digests and identifiers, not prose.

`citable` loses its default. The original treats an absent flag as `true`, which is the wrong direction for a value deciding whether a document may be quoted to a customer. Absent is now `E_KB_ADMISION_SIN_CITABILIDAD`.

**A third tie, to the corpus rather than to a person: the pointer is locked and compared, and the label the row was decided under must still be the one in force.** Without it the advance believed `snapshot_from` instead of checking it, and the failure that produced is a lost update rather than a wrong answer. Two admissions decided in the same window — which §8 says must be workable in either order — read one head, mint two different successors, copy the same corpus twice and set the pointer twice. Neither trips `E_KB_SNAPSHOT_YA_EXISTE`, because that only sees a label that already exists. The second wins, and the document the first admitted falls out of force while its chain row, its `kb_admission` row and its approver all go on recording an admission that happened. Nothing is destroyed, because the corpus is append-only; nothing turns red either. The gap the first was raised for simply never closes, because the closure asks the corpus in force for the admitted key and it is no longer there — a supervisor left holding an admission that succeeded and a gap that will not shut, with nothing on any screen connecting them.

`select … for update` is what makes the comparison mean something rather than usually hold: the second transaction blocks until the first commits, reads the pointer the first moved, and is refused as `E_KB_SNAPSHOT_MOVIDO`. Read without the lock, both would pass and both would write. It is asked **after** the organisation, approver and existing-label checks, because a replayed admission trips this and `E_KB_SNAPSHOT_YA_EXISTE` together and "this admission has already happened" is the more useful of the two things to be told.

### 8 · The closure is a new function, its four clauses are four refusals, and it takes nothing on trust

`kb_gap_close_by_verification(p_gap, p_response)` is new beside `kb_gap_close_by_check`, which stays as it is for the reason §7 gives. It converts four sentences of the requirement into four things the database refuses:

1. the answer is **anchored** — `grounded` is true, and not merely present;
2. it belongs to the **same organisation** as the gap, checked before anything else is read out of it, so that which refusal comes back does not tell a caller whether another tenant's answer exists;
3. it was produced under the snapshot **in force**;
4. it **cites material admitted against this gap**, by canonical key.

**Its whole argument list is a gap and an answer, and that is the correction that matters.** An earlier draft took the canonical key as a parameter, which meant the load-bearing value of the closure was supplied by whoever called it: anybody holding EXECUTE could close a gap *on the admitted source* by naming any key the answer happened to cite — a pre-existing article, for instance. That is the caller being believed instead of refused, in the one function whose own header says a caller holding a wrong belief is refused by the database. The key is now derived inside, through the admission's own `article_id`, and the chain of joins is the argument: an admission for this gap names an article, that article carries a key, the corpus in force carries a row under the same key, and the answer cites *that* row.

**The fourth is matched by key and never by identity**, and that is not a preference: an advance mints a new identity for every row it copies, so the article the admission recorded and the article standing under the corpus in force are different rows with the same key. `response_citation` holds the old identity anchored by a composite reference to the old snapshot — correct, deliberate, and useless for checking a closure under the new one.

**The third is the snapshot IN FORCE, and the earlier reading was a defect.** FR-A16 says *re-run against the current snapshot*, and "current" is an equality against the pointer, not an ordering between labels — 0009 §1 already refuses to order snapshot labels, because `max` over text is an alphabetical accident that happens to agree with time. An earlier draft required the answer's snapshot to be the one *this gap's admission advanced into*, and paired with a refusal in the admission writer against admitting for a gap raised before the corpus last moved, it made the whole system **serial**: with two gaps open, working the second after any advance was impossible, permanently, for a reason nobody could act on. Both halves are gone. `snapshot_from` on an admission remains the head, because that is a fact of the advance — it copies the corpus in force — and never a claim about when the gap was raised.

**And the witness is the ledger row of the validation, read out of the answer rather than taken from the caller.** A closure that accepted a row number would accept any row number: a caller could name a checkpoint written last week and the gap would close carrying a witness that proves nothing about it.

### 9 · The corpus cannot move under a runtime without somebody being told

The snapshot pointer is read twice with two lifetimes: frozen into `state` when a runtime is built, fresh at the top of every cycle. After an admission that did not evict, the retrieval reads the **new** corpus while every row written beside it records the **old** label — the evidence this card exists to produce, falsified in the act of producing it, invisibly.

Two halves, and the second is what makes forgetting the first impossible to ignore. **(a)** The admission writer calls `evictRuntime` as its last act. **(b)** Every cycle compares the fresh head against the runtime's own and refuses with `E_RUNTIME_SNAPSHOT_STALE` if they differ. The runtime is discarded on the way out, so the refusal is recoverable rather than permanent: the next attempt rebuilds against the corpus in force and proceeds. Noisy once, in front of whoever pressed the control, is the outcome to want.

**"Every cycle" was written here before it was true, and the exception was the triage cycle.** It called `runtimeFor` and never compared, so it was the one path that could write a row naming a corpus the organisation had already left. It is now included, and the reason it belongs is not the one that was first argued against it. Triage cites no corpus, so this was read as a guard it did not need — but the guard is not about the answer, it is about the **row**. Every row pins the conditions it was produced under; a row whose snapshot label is not the one in force is false about the world, in a card whose entire claim is that the chain records what happened. And `state_hash` is part of the replay cache key, so such a call is stored under a state no later runtime will present: **its replay is unreachable**, which for a demonstration whose second half is served from the chain is a cache miss on the beat.

The case is reachable in production and not only under a test that moves the pointer by hand: `evictRuntime` reaches the process that ran it, so a second process goes on holding the label it was built with until something makes it notice. Placed after the status check, so a ticket the cycle would skip is not refused for an unrelated reason, and read against the same `kb:none` sentinel `buildRuntime` uses rather than through the refusing reader — an organisation that has never published an article can still be triaged, exactly as before.

### 10 · `citable` becomes a filter, and the ruleset digest moves twice

The column has been in the schema since the first migration and nothing read it. With a corpus only a seed wrote, every row was citable and the omission cost nothing. An admission is where it stops being free: a supervisor is asked, in as many words, whether the document may be quoted to a customer, and a retrieval that ignored the answer would hand a model an excerpt of a document whose own approver said no. Everything downstream of the retrieval is entitled to quote what it was given, so the filter has to be at the query or it is nowhere.

`retrieval.citableOnly` enters `rulesetDescription`, and so does `policyNormalisation` (§11). **`ruleset_hash` therefore moves in this release, and `state_hash` with it.** The declared consequence is a cache, not a loss: answers recorded under the previous digest stop being reachable as hits, and the rows remain and remain readable. Both fields are in the digest for the same reason the thresholds are — two runs under two settings are two experiments, and without them they would share a cache while disagreeing about which documents a draft could stand on.

### 11 · The injection matcher is normalised, and it is still not the defence

Every pattern in the matcher's table is anchored on word boundaries, and a character that occupies no width makes two words out of one. `ig<zero-width space>nore all previous instructions` matched nothing, rendered identically to the sentence that matches everything, and was found by attacking the table rather than by reading it. Compatibility normalisation does not remove those characters and the whitespace collapse does not reach them: the language's own whitespace class stops one code point short of where the useful ones begin.

A helper of its own now removes them — **removes, never replaces with a space**, because a substitution leaves two words where the writer put one and the evaded pattern goes on not matching. The table of code points is published and closed, and `POLICY_NORMALISATION` travels in the ruleset digest, so a normaliser that changed what it removes cannot leave two runs sharing a cache while disagreeing about which tickets carry a flag.

**And the sentence that matters more than the fix: the matcher is not the defence against a poisoned corpus. The human approver is.** A regular expression is a poor classifier and a good instrument; what it buys is a cheap, reproducible, auditable first line that a person can read in advance. Writing that this hardening *prevents* injection into the corpus would be writing the claim the specification forbids. **The residual is declared:** a well-written false policy — plausible prose, no marker, no instruction, simply untrue — passes every check in this cycle and is admitted if a supervisor approves it. What stands against that is the approver's judgement, the provenance recorded beside the document, and the fact that the admission names a person. It is a process control, not a code control, and it is recorded as one.

### 12 · What this card deliberately does not harden, and the debt it books

The SQL suite that covers the admission guarantees **deletes from `kb_gap` and from `kb_admission`** and **reopens a closed gap by hand**, because that is how it builds and tears down its cases. Three hardenings that would otherwise belong here would turn it red: a delete trigger on `kb_gap`, an immutability trigger on `kb_admission`, and a guard that refuses reopening.

**Decided: this card adds none of the three.** Hardening a table by breaking the test that covers it exchanges a property for a red build. **The debt is booked with the shape of its repayment**: the test file is rewritten to build its cases inside transactions that roll back instead of deleting rows, and the triggers land with that rewrite. It is not resolved here and it is not pretended to be.

`kb_admission.article_id` is nullable for the same reason and pays the same debt: a `not null` column would refuse the rows that suite builds by hand. Every row the application can produce carries it, because the application cannot insert into that table at all and the one writer that can always populates it.

**And one more, found in this card's own writer and left standing in its sibling.** The blank tests in `kb_gap_open` were written with `btrim`, whose default trim set is the SPACE character and nothing else — so `btrim(E'   \n  ')` is a newline, not the empty string, and a record whose entire query evidence was a line break satisfied both `not null` and the guard. It was caught by the test whose name is about exactly that distinction, and the guard now asks the question that was meant: does the value contain one character that is not whitespace.

`kb_gap_mark_not_documentable`, in `0009`, has the identical shape — `btrim(p_reason) = ''` — and therefore the identical hole: a reason of one tab would be accepted. It is **not fixed here**, and the reason is the forward-only rule rather than an opinion about its severity: an applied migration is never edited, so correcting it means a new function beside the old one and a revocation, which is the whole apparatus §7 goes through for the advance. Nothing calls it in this card. **Booked as debt**, to land with whichever increment gives `NOT_DOCUMENTABLE` a caller — which is the increment that would first be able to notice.

**A third was found the same way and, unlike the other two, was BUILT here.** The advance believed `snapshot_from` rather than checking it, which is a lost update and not a wrong answer; §7 carries the mechanism and `E_KB_SNAPSHOT_MOVIDO` is its refusal. It was booked as debt first and then built, and the argument that moved it is worth recording because it generalises: the fix costs one function body, one case and a golden regeneration **today**, and a whole numbered migration with its own ADR **after the merge**, because forward-only forbids editing an applied one. An order of magnitude, for a defect that contradicts a promise this same document makes one section earlier.

**And a fourth, recorded because the reasoning about it was wrong twice before it was right.** `triage` was the one cycle-driving path with no staleness guard, and the first reading — mine — was that it did not need one, because triage cites no corpus. That reading was accepted and then falsified by measurement rather than by argument: a gap-cycle test reported an admission whose `state_hash` matched neither half of its own chain, with all four snapshot labels around it correct. The third value was the triage row, written under the label a previous file had left in the process's cache. §9 carries the guard and the argument that replaced mine. The lesson worth keeping is narrower than the fix: **"this component does not read X" is not the same claim as "this component's record does not depend on X"**, and only the second one licenses leaving a guard out.

### 13 · What this increment does NOT do

- **No new edge and no amended count.** `{console: 3, guarded: 16, illegal: 81}` is a signed partition and the re-run is of the QUERY, not of the ticket. The verification writes a new answer and does not move the ticket: the escalation put it in somebody's queue and it is theirs to move.
- **No ninth escalation index.** `INCONSIST` stays reserved. The conflict predicate is computed, recorded in the decision detail, and resolves the identities of the diverging sources for the record's own field — and does nothing else.

  **The tension with the frozen comment on that column, named so it is not read as an oversight.** `0001` says `divergent_kb_ids` is *populated only when the gap is born from a source conflict*, and this card populates it on a gap born of `GROUND` whenever the conjunction found keys in conflict. Both are true at once and the resolution is which fact is being recorded: a source conflict is a fact about the **corpus**, computed in the same cycle, on the same sources, at no extra cost. The alternative to writing it beside the gap that did open is losing it — because the gap it would otherwise open is the one the reserved ninth index would raise, and that index is not taken. A field that is empty in the ordinary case and carries what was measured in the rare one is worth more than a field that stays empty until an increment nobody has scheduled. The comment is 0009's and older, it is not edited, and this is the amendment that governs.
- **No third organisation**, no anchoring discipline every K rows, no update grant on `response`, and no edit of a `prompt_version` row.
- **No INSERT or UPDATE on `kb_gap` or `kb_admission` for the application, today or ever.** Both are reached through a security definer function and EXECUTE, which is the pattern every privileged writer in this schema already follows.

## Consequences

**Easier.** A question the corpus cannot answer becomes a record with a person's name and a date on it, instead of an escalation and a shrug. Material enters the corpus through one path, with provenance, an approver tied to the session that performed it, and a row of the chain that pins the corpus the decision was taken under. The closing act of the demonstration is one chain with two state values and the admission row between them, which a panel can show without anybody having to explain it.

**Harder.** Every `security definer` function from today carries its own revocation, and a migration that forgets it fails a sweep rather than passing quietly. An organisation with no declared knowledge-gap commitment cannot emit a gap record at all — loudly, naming the organisation, which is better than a record naming somebody who never agreed to anything. A rehearsal **spends a variant**: an admission cannot be repeated and a gap record cannot be reopened, so a third rehearsal of the same beat needs new data with its own passage through the dataset test.

**Now mandatory.** **Nothing a writer refuses may take down the transition that invoked it** — a refusal that can reach a caller's transaction is a refusal that can strand a ticket in a system with no sweeper, so a privileged writer called from inside somebody else's transaction runs in a savepoint and reports rather than raises. A change to what the canonical form of a question strips or composes is a change to `question_sha256`, which re-partitions every record already written and which no database can recompute to notice — `test_SEC_admission_channel_refuses_out_of_contract` pins it to fixed vectors for that reason. A change to what the policy normaliser removes moves `POLICY_NORMALISATION` and is declared as a recalibration. A new typed channel is a fifth row in the boundary's declaration and fails the seam check until it is one. A citation authored into the demonstration dataset names a canonical key and never an identity — an advance re-mints every identity it copies, and a literal one would take the anchored beat down in the middle of the demonstration.
