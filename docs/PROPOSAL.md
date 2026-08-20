# LedgerDesk — A Grounded-Answer Platform with a Sealed Quality Firewall, Demonstrated on Customer Support

Project proposal for LedgerDesk (COIT20273 Software Design and Development Project, CQUniversity, Term 2 2026). Content dated 19 August 2026, submitted for facilitator approval; this copy is maintained in the delivery repository.

---

## Baseline statement

Once approved, this issue is sealed as the project baseline — the tag name `baseline-v1.0` is retained, because it is the identifier every other project document refers to — and is not edited thereafter. Every subsequent change is issued as a dated amendment with an architecture decision record, never as a silent rewrite. This is what makes the later claim *"the project is on track"* measurable rather than asserted.

---

## Submission context and approval request

Three matters are declared at the front of this document rather than left for the reader to infer.

**1. Delivery model.** The unit anticipates groups of three to four students. This project is delivered under a **single-executor delivery model with functional role separation**: six named functional roles, each with a defined responsibility set, decision rights and a hand-off artefact, all held by one practitioner. Separation is enforced **by artefact, not by headcount** — a role cannot promote work that the downstream role has not certified against a dated, hash-sealed artefact held in version control. Section 11 specifies the model, the RACI matrix and the control for its principal risk. Approval of this delivery model is requested.

**2. Project approval.** The unit requires that all proposed projects be approved by the project facilitator. This proposal requests approval of the project as a **modified version of listed project #4**. Section 4.5 states precisely which feature of the listed option has been deliberately excluded and why, so that the modification is visible rather than discovered.

**3. Case basis.** The unit permits industry-based or case-based projects. This is a **case-based** project. The client, "MidCo", is a **hypothetical case organisation** — an anonymised profile of an Australian B2B SaaS provider, not a real client, and never described as one. Every operational figure attributed to it is a declared assumption, registered as such in Section 1.4.

---

## Executive summary

**The product, and what is demonstrated.** LedgerDesk is a **generic grounded-answer platform**: any organisation that answers questions against a body of documents — customer support, employee training, internal operations — can load it with its own corpus. Every answer cites its sources and stays tied to the exact corpus version that produced it; every question the corpus cannot answer becomes a record that closes only when a check passes. **Built generic, demonstrated specific:** this term's instance loads a customer-support corpus for MidCo, a hypothetical case organisation profiling an Australian B2B SaaS provider of roughly 40 employees and 1,200 business accounts — listed unit project #4, modified (Section 4.5).

**The problem of the demonstrated instance, and the headline figure.** MidCo triages, drafts and escalates every support ticket by hand, measures the quality of none of those decisions, and records nowhere the questions its documentation cannot answer. On the declared case assumptions of Table 1, that is 850 tickets a month at 14.0 minutes each: **198.3 agent hours a month**, a **90th-percentile first response of 31 hours**, and **22% of escalations that did not require a senior person** — a manual support effort of **≈ A$90,000 per year** (A$90.4k on the stated inputs), `ASSUMED`, derived from AS-1 to AS-4; declared case assumptions, not data from a real organisation. That status travels with the figure to every document that uses it. The benefit is expressed as **capacity released, not cash saved** (no headcount reduction is proposed): 36.3 to 59.5 agent hours a month against roughly A$2,300 to A$4,700 a year of operating and curation cost, about **3.5:1 to 11.7:1** under those assumptions. An earlier 66:1 ratio that ignored its own cost lines has been withdrawn.

**The differentiators, stated so they can be checked.** Four properties carry the claim; the first is stated in commitment tense because no code exists on the date of this issue. **(1) The knowledge-gap cycle with verified closure:** a question the corpus cannot answer becomes a gap record with evidence, an owner and a date, and moves to `CLOSED` only when the original query, re-run against the new snapshot, returns `grounded = true` — no application path closes it by hand; dated and assigned to work packages in Sections 3.1 and 4.6. **(2)** Every published accuracy number comes only from a **sealed reporting split the improvement loop never observes**, against a visible query budget. **(3)** Every automated decision writes one **append-only, hash-chained ledger row** tied to the corpus version consumed (`kb_snapshot` inside its state hash). **(4)** Queue priority and escalation are **deterministic functions with a declared reason code**, not model calls. What is not claimed is set out in Table 5.

**The minimum committed scope.** A working **end-to-end vertical slice**: ticket raised in the portal → automated triage with declared confidence → grounded draft citing knowledge-base sources → human edit, approval and send, or escalation with a stated reason — raising a gap record when the corpus had no answer → supervisor dashboard. Everything in that slice is in the "Must" row. The improvement engine and the negative battery may be delivered in reduced form; the ledger and the negative tests are never conceded. Fully automated customer-facing replies are deliberately excluded: human approval is enforced as a database constraint, not as a workflow convention.

**The schedule.** Seven milestones (Table 14), each with an exit condition that is true or false on its date, from **M1** Progress Report 1 (17 Aug 2026) to **M7** final report, working application and presentation (12–13 Oct). The critical path, the parallel quality lane and a reduced-capacity window in weeks 9 to 11 are declared in Section 8; fifteen risks with observable triggers are registered in Section 9; the whole-of-term model API spend is capped at **A$120 with an automatic cut-off at A$100**, enforced by a circuit breaker with a test.

**The delivery model.** One practitioner holds **six named functional roles**; separation is enforced **by artefact, not by headcount** — seals and tags created before the runs they certify, continuous integration as the mechanical gate, dated decision records. The limit is stated rather than glossed: the control is evidential, not physical.

**What is requested.** Approval of (a) the project as **listed project #4, modified** as described in Section 4.5, and (b) the **single-executor delivery model** described in Section 11. Six open questions, each with a default position the project will follow unless directed otherwise, are listed in Section 15.

---

## Compliance map — where each requirement is answered

*This map exists so that no mark depends on the reader searching. Every required component and every marking criterion is answered in the body of this document. There are no appendices carrying assessable content.*

| # | Required component | Section |
|---|---|---|
| 1 | Project background and justification | **1** |
| 2 | Problem statement and project objectives | **2** |
| 3 | Innovative aspects of the proposed solution | **3** |
| 4 | Project scope, assumptions, and constraints | **4** |
| 5 | High-level requirements overview | **6** |
| 6 | Work decomposition (WBS) | **7** |
| 7 | Delivery roadmap (milestones, dependencies, Gantt) | **8** |
| 8 | Risk identification and mitigation plan | **9** |
| 9 | Quality considerations | **10** |
| 10 | Team structure, roles, and responsibilities matrix | **11** |
| 11 | Task leads for major deliverables | **12** |
| 12 | Required tools and resources | **13** |
| + | Stakeholder needs matrix | **5** |
| + | Course-level product requirements | **6.6** |
| + | Assumption register | **1.4** and **4.3** |
| + | Declaration of individual contributions | **14.1** |
| + | Harvard references | **16** |

| Marking criterion | Principally answered in |
|---|---|
| Project justification and problem definition | Section 1 (context, quantified business case, cost–benefit), Section 2 (problem, objectives, alignment), Section 3 (innovation) |
| Scope, requirements and feasibility | Section 4 (MoSCoW, assumptions, constraints), Section 5 (stakeholder needs), Section 6 (requirements with thresholds), Section 4.6 (feasibility note) |
| Project planning and structure | Section 7 (WBS), Section 8 (roadmap and critical path), Section 11 (roles), Section 12 (task leads) |
| Risk and quality considerations | Section 9 (risk register and heat map), Section 10 (quality management plan) |
| Team organisation and resource planning | Section 11 (delivery model, RACI), Section 13 (tools, technologies, budget) |
| Professional presentation and communication | Document structure, controlled versioning, numbered figures and tables, Harvard referencing (Section 16) |

---

# 1. Project background and justification

## 1.1 Industry context

Any organisation that answers questions against a body of documents — a support desk against its help centre, a trainer against course material, an operations team against its procedures — faces the same two scaling facts: question volume grows with the organisation, and the quality of an answer depends on which individual happened to produce it. **The position this proposal takes, and the reason it exists, is that generative AI has lowered the cost of drafting text far faster than it has lowered the cost of *governing* it.** A manager who deploys an AI assistant and is asked "is it actually right?" typically has three sources of evidence available: the vendor's marketing, their own impression, and a dashboard number produced by the same system that is being judged. **The platform proposed here is generic over the corpus it answers from; customer support is the corpus loaded for this term's demonstration**, and B2B software support is the instance the business case is quantified on. Section 1.3 assesses the terrain as six architectural classes of question-answering system, with Zendesk, Freshdesk and Intercom named as examples of the class a buyer of MidCo's size would meet first.

That last point is the gap this project addresses. The cost of a model answering a question has fallen sharply; what has not fallen is the cost of everything around the model — the configuration, the guardrails, the validation, and above all the evidence that the thing is working. That surrounding layer is where organisational risk now sits, and it is where a software engineering project can make a defensible contribution.

## 1.2 The case organisation

MidCo is a **hypothetical case organisation**: an Australian B2B SaaS provider with approximately 40 employees and around 1,200 business accounts. It operates support through email and a web form. There is no automated triage, no priority policy encoded in software, and no measurement of decision quality. Tickets are read, categorised, drafted and escalated by hand. The support team is three agents and one supervisor. **MidCo is the demonstration instance of a generic platform**: the corpus loaded for the demonstration is MidCo's support knowledge base, MidCo remains a declared hypothetical case, and no regulatory or compliance exposure is added to its profile to flatter the differentiators.

MidCo does not have an AI problem. It has a **cost-of-attention** problem: roughly two hundred hours a month spent re-typing answers that already exist somewhere in the knowledge base, and a first-response time whose 90th percentile is **31 hours** (AS-6) — roughly eight times the four-hour first response this project adopts as its target (G0), and a figure the case organisation cannot encode as a service commitment in the tier-and-severity policy of FR-A05 without breaching it. Automating the drafting addresses the cost. Automating it *without an auditable quality signal* replaces one problem with another.

## 1.3 Why this project, and why not buy a product

Commercial products already answer questions over documents, and the assessment below is made against **architectural classes rather than feature lists** — statements about what information each pipeline contains and what decision it can therefore make, which do not expire with a product release. Six classes cover the terrain:

| # | Class | What it solves | What it structurally leaves unsolved |
|---|---|---|---|
| 1 | **General-purpose chat without your data** | Fluent answers from the model's own weights | No enumerable corpus, so "grounded in our documents" is not even statable; nothing is measured on your questions |
| 2 | **Chat with attached files** | The document enters the context for one conversation | Scope resets every conversation; there is no "before" against which improvement could be measured |
| 3 | **Workspace with a persistent corpus** | Sources persist; answers restricted to them, with citations | *Who* uploaded a document is recorded; *which failed question motivated it* is not; failed questions are never re-run |
| 4 | **Standard RAG stack** | Chunk → embed → retrieve → generate, a programmable ingestion pipeline, and the best public evaluation practice of the six | Evaluation iterates and reports on the same set the tuning process observes; the unanswered question has no metric because it has no object |
| 5 | **Enterprise search with generated answers** | Connectors and permissions: the corpus follows the organisation without anyone uploading anything — the best corpus growth of the six | A connector mirrors what is written; no number of connectors creates a document nobody has written, and usage telemetry measures behaviour, not correctness |
| 6 | **Commercial product-support agent** — Zendesk, Freshdesk and Intercom are named as examples of membership in this class | The complete ticket workflow — intake, routing, drafting, SLA reporting, escalation to a human — at a maturity no capstone can match | The unanswered question and the corpus end the episode exactly as they began; deflection metrics separate from correctness precisely where the system fails silently; and the quality figure is produced by the same process being judged |

**The build case is structural, not competitive.** What no class was found to contain — as information in the pipeline, refutable by showing the component that fills the hole — is: **(i)** the unanswered question as an object with an owner, a date and a closure that only a passing check can effect; **(ii)** an answer tied to the *version* of the corpus that produced it; and **(iii)** a published quality number taken from a sealed reporting split that the improvement process never observes. Buying remains the correct commercial decision for the workflow alone — classes 5 and 6 in particular are better bought than built. What is built here is the mechanism the classes do not contain, and that is also what gives the project the analytical depth the unit requires: the interesting engineering is the measurement discipline around the assistant rather than the assistant itself. Because the argument is over classes it degrades gracefully: sourcing action **A-2** (work package 2.6.2, on the same terms as action A-1 in Section 1.4) still seeks dated product documentation for the three named class-6 examples, but if that search returns nothing citable, the class argument stands as reasoning over declared premises — and it is falsified, per class, by exhibiting the missing component.

## 1.4 Baseline and Assumption Register

**Every figure in this section is a declared case assumption, not data collected from a real organisation.** The register is presented in the body of the proposal, not appended, because the credibility of Sections 2, 4 and 9 depends on the reader being able to see exactly which numbers are asserted and which are derived.

**Table 1 — Baseline and Assumption Register**

| # | Baseline metric | Value | Derivation | Status |
|---|---|---|---|---|
| AS-1 | Ticket volume | 850 tickets / month | Case profile | **ASSUMED** |
| AS-2 | Average handling time (AHT) | 14.0 min / ticket | Case profile | **ASSUMED** |
| AS-3 | Manual effort | 198.3 h / month | 850 × 14 min | DERIVED from AS-1, AS-2 |
| AS-4 | Loaded agent cost | A$38 / h | Indicative Australian market rate | **ASSUMED — external source not yet obtained** (see action A-1) |
| AS-5 | Annual cost of manual support | **≈ A$90,000 / year** (A$90.4k on the stated inputs) | 198.3 × 38 × 12 | DERIVED from AS-1 to AS-4 — headline figure; carries `ASSUMED` status because every input is assumed |
| AS-6 | First-response time | p50 6.5 h / **p90 31 h** | Case profile | **ASSUMED** |
| AS-7 | Unnecessary escalation rate | 22% | Case profile | **ASSUMED** |
| AS-8 | Repetitive tickets (top-5 categories) | 61% of volume | Case profile | **ASSUMED** |
| AS-9 | Realisation of benefit | Released agent capacity is **redeployed** (backlog reduction, proactive outreach, SLA recovery), not converted to headcount reduction | Project position | **ASSUMED — stated, not modelled** |
| AS-10 | Evaluation corpus | 100% synthetic, template-generated with ground-truth labels | Ethical constraint | DECIDED |

**Rule attached to this table, and travelling with it to every later document:** the headline figure never appears without its `ASSUMED` status. A caveat declared by whoever produced a number accompanies that number to the last document that uses it, or the number is not used.

**Open sourcing action A-1.** Obtaining a citable Australian industry benchmark for support cost-per-contact and loaded agent cost would raise the floor of this business case by replacing AS-4 with sourced data. That search is a registered task (WBS 2.6.2) with a declared possible outcome of *nothing citable found*, in which case the case values remain marked `ASSUMED` and the business case is presented as scenario analysis rather than as forecast. Declaring that in advance is deliberate. **Sourcing action A-2**, registered in Section 1.3, runs on the same terms and covers the dated product documentation of the three commercial suites named in the build-versus-buy assessment.

## 1.5 The business case, expressed as capacity and as cost

The five highest-volume categories account for **61%** of ticket volume (AS-8). Because handling time is broadly uniform across categories in this profile, those five categories absorb a proportionate share of the 198 hours a month the function currently consumes — which is precisely where a repeatable, grounded answer has leverage. Meanwhile the 90th-percentile first response of **31 hours** (AS-6) sits at roughly eight times the G0 target, and 22% of escalations (AS-7) are unnecessary — senior time spent on cases that did not require it.

**The benefit is expressed as capacity released, not as cash saved.** No headcount reduction is proposed or assumed (AS-9); the value is realised only if the released hours are redeployed.

**Table 2 — Cost–benefit, expressed as a range**

| Line | Conservative | Target | Basis |
|---|---|---|---|
| **Benefit** — agent capacity released | **36.3 h / month** (−30% AHT on the repetitive 61% only) | **59.5 h / month** (−30% AHT across assisted tickets) | AS-3 × 0.30, scoped two ways |
| Benefit, annualised | 435 h / year ≈ A$16,500 equivalent | 714 h / year ≈ A$27,100 equivalent | at AS-4; **equivalent value, not cash saving** |
| **Cost** — AI operating cost | A$918 / year (A$0.09 / ticket) | A$408 / year (A$0.04 / ticket) | 10,200 tickets / year; unit cost is a *requirement* (NFR-Q05), to be confirmed by a metered pilot, not asserted |
| **Cost** — ongoing operation and curation | A$3,800 / year (100 h) | A$1,900 / year (50 h) | prompt curation, knowledge-base upkeep, periodic re-evaluation, at AS-4 |
| **Cost** — residual human editing | *inside the benefit* | *inside the benefit* | the −30% AHT target is **net** of the agent editing the draft, not additional to it |
| **Cost** — build effort | **excluded from the operating comparison** | | delivered as academic coursework; a commercial equivalent would be a capital cost recovered against released capacity, and is declared out of this model rather than netted silently |
| **Recurring benefit : recurring cost** | **≈ 3.5 : 1** | **≈ 11.7 : 1** | ranges, under AS-1 to AS-4 and AS-9 |

**Why cost is priced against correctness rather than reported on its own.** The unit-cost line above is a cost per *processed* ticket, and it is never published without the accuracy measurement beside it. That pairing follows the published economic framework for evaluating language models, which prices a system as the expected monetary cost of producing a **correct** result and benchmarks it against the approximate cost of hiring the human expert who would otherwise produce it (Erol *et al.* 2026). The same source supplies the reason the pairing is not optional: its Appendix C.8 (pp. 21–22) records that a cheap model configured to guess at random can win on cost-per-correct-answer alone, because a metric of the form cost-over-result rewards whatever is cheap and occasionally lucky. That is a documented degeneracy of the metric family, not a hypothetical, and it is why the promotion gate in Section 10.4 requires a paired quality test and a green negative battery **before** any cost figure is quoted, and why NFR-Q05 remains labelled *asserted* until the metered pilot measures it.

**Withdrawn figure.** Earlier drafts of this business case carried a benefit/cost ratio of approximately 66:1. That figure compared released agent hours against API cost alone, ignoring operation, curation and the residual editing effort, and it is **withdrawn**. Table 2 replaces it with a bounded range and a stated exclusion. A ratio that cannot survive its own cost lines is worse than no ratio.

**Non-financial justification.** Two outcomes matter independently of the arithmetic: a first response measured in minutes rather than a day and a half, and the ability to answer the question *"why was this ticket escalated, by what, at what cost?"* for any individual ticket, months after the fact. The second is a compliance capability, and compliance capabilities are not usually priced until they are needed.

---

# 2. Problem statement and project objectives

## 2.1 Problem statement

> **"MidCo's support function cannot meet its response-time commitments at current volume because every ticket is triaged, drafted and escalated manually, with no measured quality signal on any of those three decisions — and when a ticket asks something the knowledge base does not cover, that lack is recorded nowhere."**

The statement carries four clauses and each has a distinct consequence:

| Clause | Consequence | Baseline evidence |
|---|---|---|
| **Volume** — 850 tickets a month against three agents | Cost: 198.3 h/month, ≈ A$90k/year (`ASSUMED`) | AS-1, AS-3, AS-5 |
| **Manual decision** — triage, drafting and escalation are all human judgement calls made from scratch | Latency: p90 first response of 31 h; 22% of escalations unnecessary | AS-6, AS-7 |
| **No measured quality signal** | Nobody can tell whether a change improved anything; improvement is an opinion | — |
| **The unanswered question leaves no trace** — when the system cannot answer, the lack is not represented anywhere, the episode ends, and the corpus stays exactly as it was | The same failure repeats for every future asker; corpus growth is disconnected from demonstrated need | — |

Most support-automation projects address the first two clauses and leave the last two standing. This project is built around the last two: the measured quality signal (O4, O5) and the unrepresented gap (O6).

## 2.2 Goal and objectives

**Table 3 — Objectives hierarchy**

| Level | ID | Objective | Measure that proves it | Target |
|---|---|---|---|---|
| **Goal** | **G0** | Reduce the cost and latency of MidCo's support function **without transferring quality risk to the customer** | AHT against the AS-2 baseline; first-response p90 | −30% AHT; p90 < 4 h |
| Objective | **O1** | Automate triage — category, severity and sentiment — **with a declared confidence** on every classification | Triage accuracy measured on a sealed, held-out reporting split, published with n and a 95% confidence interval | Accuracy reported with its interval; see Section 6.4 on why no absolute threshold is asserted |
| Objective | **O2** | Generate a reply draft **grounded in retrieved knowledge-base content** | Share of sent drafts requiring ≤ 20% normalised edit distance | ≥ 70% of sent drafts |
| Objective | **O3** | Escalate risk cases correctly, and **state which rule fired** | Escalation recall on a fixed negative-case battery | ≥ 0.90 recall; 100% of escalations carry a reason code from a closed set |
| Objective | **O4** | Give the supervisor operational visibility on **measured**, not self-reported, quality | Dashboard rendering accuracy only alongside n, confidence interval, seal hash and query budget consumed | Dashboard cannot display an accuracy number without those four fields |
| Objective | **O5** | Improve the system from human feedback **without retraining any model** | Paired change in accuracy between prompt generations, with a confidence interval, and a green negative battery | A promoted generation carries Δ, its paired interval, n and the split hash |
| Objective | **O6** | Convert every question the corpus cannot answer into a **gap record whose closure is decided by a check, not by a person** — *stated in commitment tense: dated and assigned to work packages in Sections 3.1 and 4.6, no code existing on the date of this issue* | Proportion of gap records closed by verification: the original query re-run against the new snapshot returns `grounded = true` with the admitted source | 100% of gaps reaching `CLOSED` do so through the check; no manual-closure path exists (FR-A16) |

Each objective is SMART in the sense that matters for assessment: it names the artefact that measures it, the population the measurement is taken over, and the condition under which the claim may be published. Objectives O1 to O6 are the baseline against which all subsequent progress reporting will be aligned.

## 2.3 Alignment between the organisational problem and the objectives

**Table 4 — Problem-to-objective traceability**

| Problem clause | Objective(s) | Mechanism | Business outcome |
|---|---|---|---|
| Volume drives cost | O1, O2 | Automated triage and grounded drafting remove the two highest-effort steps of the 14-minute handling time | Capacity released (Table 2) |
| Manual decisions drive latency | O1, O3 | Classification happens on intake; an explicit, deterministic rule decides queue order and escalation | p90 first response from 31 h toward < 4 h |
| Unnecessary escalation | O3 | Escalation becomes an enumerated rule with a stated reason, not a judgement call | Senior time recovered; 22% baseline becomes measurable |
| No measured quality signal | O4, O5 | Sealed evaluation split, query budget, per-decision ledger, gated promotion | Quality becomes a number the supervisor can defend to an auditor |
| The unanswered question leaves no trace | O6 | A `GROUND` escalation emits a gap record with evidence, owner and date; only the re-run check closes it (FR-A15, FR-A16) | The corpus grows where askers demonstrated it thin, with proof that each addition answers the question that caused it |

---

# 3. Innovative aspects of the proposed solution

The unit asks for an original or semi-original idea with business value. The originality claimed here is bounded and specific, and it is stated in a form that can be checked.

## 3.1 The four differentiators

**(1) The knowledge-gap cycle with verified closure — a commitment with a date and a work package, not a description of built software.** In every class of Section 1.3, a question the corpus cannot answer is a dead end: the reply says "no", the episode ends, and the corpus is exactly as it was. Here, an escalation on `GROUND` **emits a gap record** carrying the evidence of the query — the terms searched, the snapshot identifier, the zero-match result — an owner, a committed date, and a null-result rule declared in advance; and the record moves to `CLOSED` **only when the original query, re-run against the new corpus snapshot, returns `grounded = true` with the admitted source. No application path closes a gap by hand** (FR-A15, FR-A16). Closure stops being something a person declares and becomes something a check proves — the property none of the six classes was found to contain. Because no code exists on the date of this issue, this is written as what it is: a dated commitment, scheduled inside work packages 4.2 and 5.1 — owner R3, with the closure test held by R4 — in place for the Week 7 demonstration (M4). What the record's evidence does and does not establish is bounded in Table 5.

**(2) A sealed evaluation split — the quality firewall.** The evaluation corpus is partitioned into a `selection` split, a `report` split and an out-of-distribution probe set. The improvement engine may consult **only** the selection split. **Every accuracy number the product publishes comes exclusively from the report split, which the improvement loop never observes,** and every consultation of the report split is counted against a pre-committed query budget displayed on screen. The partition membership is committed by hash before the first evaluation run, with the partition salt withheld until close.

This differentiator rests on a documented phenomenon rather than on intuition. Repeatedly selecting against the same held-out data inflates the reported result — Dwork *et al.* (2015) formalise this as adaptive data analysis and show that re-using a standard holdout can drive reported accuracy above 63% where no classifier can exceed 50% in truth. Zela *et al.* (2020, p. 4) observe the same pathology in automated architecture search, where the search "finds the global minimum but starts overfitting the architectural parameters to the validation set in the end" (Fig. 2). Blum and Hardt (2015) show that leaderboard-style repeated evaluation admits a mechanism for limiting adaptivity, although their bound is not operative at the scale of this project and is cited here only as conceptual precedent.

**The claim is bounded, and the bound is stated.** Roelofs *et al.* (2019) find that in practice the overfitting effect is typically small — under one percentage point of classification accuracy — and becomes material chiefly under named pathologies such as a small held-out set. That pathology *does* apply here, because a capstone-scale evaluation set is small. So the honest claim is not "everyone else's numbers are wrong"; it is: **the conditions under which a self-improving system inflates its own quality report are documented, this project operates squarely inside those conditions, and it therefore instruments against them and shows the instrumentation to the user.** Applying that accounting inside a working business application, and surfacing it on a supervisor's dashboard, is what is new here.

**(3) A per-decision ledger, claimed only for its three proprietary pieces.** Every automated decision writes one row: agent, prompt version, confidence, tokens, latency, cost, the model identifier *returned* by the provider, seed, split — and the path of the input it consumed, a field that earns its keep in the quality lane (evaluation runs, manifests, splits) and exists because of a measurement failure **in my own prior research work** (Section 10.6). Logging as such is commodity; what is claimed is the conjunction of three specific pieces: **`kb_snapshot` inside the row's state hash**, which ties the decision to the corpus *version* and not merely to the fragment cited; **append-only enforced by database mechanism** — revoked update and delete plus a trigger — not by application convention; and **a hash chain anchored at its head**, because a prefix of a valid chain is still a valid chain.

**(4) The language model produces features; an explicit algorithm decides.** Queue priority and escalation are pure, deterministic functions of ticket features — no model call sits inside the decision. Priority is a weighted composite of severity, sentiment, ageing and account tier, with a hard rule that a service-level breach outranks any score. Escalation fires on an enumerated clause set `{CONF, SENT, TIER, RETRY, SLA, GROUND, POLICY, LANG}` and the system **reports which clause fired**. The weights are not asserted: they are initialised from expert defaults and then calibrated by a sweep across the labelled corpus, and the sensitivity of escalation recall to the confidence threshold θ and sentiment threshold σ is published as a table rather than hidden inside a constant. Complexity is stated per layer: heap construction over *n* queued tickets is O(*n*) per re-prioritisation tick with O(*n*) memory, while a full ordering is O(*n* log *n*); the production path uses a database B-tree index, and a test asserts that the database ordering and the in-memory ordering agree. This makes the decision testable, explainable and auditable: the escalation can be reproduced from the ticket's features alone, and the clause that fired can be pointed at. Keeping the final decision with a human is likewise grounded in measurement rather than caution: the tool-agent benchmark published by the vendor Sierra reports that even the best-performing agents reach only above 60% single-pass success in the retail domain (Table 2 and Section 5.1, p. 7) (Yao *et al.* 2025) — a figure read here alongside the published checklist for rigorous agentic benchmarks, which documents how easily such headline metrics overstate what they appear to measure (Zhu *et al.* 2025).

**Frozen model weights are deliberately not on this list.** An earlier draft carried "continuous improvement over frozen model weights" as the first differentiator; it is withdrawn as one, because every class of Section 1.3 that calls a hosted model already runs on weights its operator does not retrain — freezing is the terrain. It is retained as constraint C-03 because it is the validity condition of every generation-to-generation comparison, and the strong claim that paragraph used to make — that a measured difference between generations is attributable to a legible, revertible object — is produced by the ledger recording the model identifier returned on every call, not by the freeze. The evolvable layer itself (prompts, schemas, workflows, validators, improved from the edits agents make anyway) is retained as objective O5.

Differentiator (2) draws on an explicit design principle from the peer-reviewed literature on self-improving systems: part of an evolving system must be unmodifiable, so that something is left to evaluate the rest with — an option the Darwin Gödel Machine work raises in its safety discussion and names as worth exploring rather than as something that work implements (Zhang *et al.* 2026, p. 9). LedgerDesk instantiates that principle as a product feature rather than as a research construct.

## 3.2 What is deliberately **not** claimed

The boundary of each claim is declared alongside it. The following statements are prohibited in this project's documentation, and their permitted replacements are given.

**Table 5 — Bounded claims**

| Statement that is **not** made | Permitted statement |
|---|---|
| "The firewall makes violation impossible" | Every known route is closed by a control with a failing test; the routes that remain open are quantified and declared |
| "The firewall is a security boundary" | It prevents accidental violation and detects deliberate violation. **It is not a security boundary against an in-process adversary.** The declared threat model is a non-adversarial but optimising improvement loop, plus a practitioner with an incentive to report a good result |
| "The separation of roles is enforced because one role cannot see the other's data" | Separation is enforced by **artefact**: seals carrying a hash and a timestamp created *before* evaluation, continuous integration as the gate, and dated architecture decision records. One practitioner holds all roles and has filesystem access; the control is evidential, not physical |
| "Accuracy is measured, not self-reported" | Accuracy is measured **on a sealed, held-out reporting split** that the improvement loop never observes |
| "This does not exist in any product" | This mechanism **does not appear in the unit's list of project options**, and the build-versus-buy assessment in Section 1.3 states what the six architectural classes do and do not contain. A universal market claim is not made |
| "Deterministic because temperature is set to zero" | Replay from the ledger without network calls reproduces the recorded run exactly. Temperature zero is set on the demonstration path but is not claimed to guarantee determinism |
| "Multi-agent architecture" | Three prompt roles orchestrated sequentially, with the ledger as the boundary between them, plus one improvement agent that runs offline against the ledger |
| "The system detects when the information is not in the corpus" | What is recorded is **zero lexical matches for the queried terms against an identified snapshot. Whether the information is absent, or present but not retrieved, is not determined** |

Every one of these replacements stands in place of a stronger earlier wording that could not be defended. Carrying the weaker, true sentence is a deliberate professional choice.

---

# 4. Project scope, assumptions and constraints

## 4.1 Scope — MoSCoW

**Table 6 — Scope classification**

| Class | Content |
|---|---|
| **Must (in scope)** | Customer portal (raise ticket, track ticket, AI disclosure, request-a-human route) · agent console (queue with explanation, draft, edit / approve / send) · three prompt roles (triage, grounded drafting, escalation validation) · explicit ticket state machine · append-only hash-chained ledger · sealed evaluation splits with a Model Quality surface · supervisor dashboard (volume, SLA, measured quality) · role-based authentication with row-level security across two seeded tenants · knowledge-gap record on `GROUND` escalation with verification-only closure, over a corpus versioned by `kb_snapshot` (FR-A15, FR-A16 — decision note of 19 Aug 2026, Section 4.2) |
| **Should** | Prompt-improvement engine with a gated promotion rule · negative-test battery running in continuous integration **(scheduled here, but never conceded under pressure — Section 10.7, rule 4)** · operations and cost panel · accessibility verification in CI · security threat model with a test per row · user-experience evaluation against NFR-Q10 |
| **Could** | CSV audit export · per-team cost breakdown |
| **Won't (declared exclusions)** | Multichannel intake (voice, WhatsApp) · multilingual answering · integration with a live CRM · real customer data · production multi-tenant deployment at scale · enterprise single sign-on · **an unversioned, self-mutating knowledge base** (decision note in Section 4.2) · **fully automated customer-facing replies without human approval** (see Section 4.5) |

The "Won't" row is part of the scope statement. An explicit exclusion is evidence of scope control, and it is also what makes any later change visible as a documented divergence rather than as drift.

## 4.2 Out-of-scope backlog, with reasons

| Excluded item | Reason |
|---|---|
| Multichannel intake | Each channel is a separate intake, redaction and SLA policy; no additional requirement is satisfied by adding one |
| Multilingual answering | The escalation path already routes non-English tickets to a human; answering would require a second labelled evaluation corpus |
| Self-updating knowledge base — **split by decision note dated 19 August 2026** | **What stays excluded:** a corpus that mutates in place without a version — ADR-011 stands, because such a corpus changes what retrieval returns and breaks the offline replay guarantee. **What enters scope:** admission of new material with provenance under a versioned `kb_snapshot`, because the ledger's state hash already includes `kb_snapshot` — the corpus never changes under a recorded decision, it grows by immutable versions, and every answer stays tied to the version that produced it. The formal architecture decision record amending ADR-011 follows in the repository once it exists; until then, this note is the record |
| Live CRM integration | External dependency with an approval path outside the project and no demonstrable value |
| Real customer data | Ethical and privacy constraint; the corpus is 100% synthetic by design |
| Production-scale deployment | Two seeded tenants prove the isolation mechanism; scale is an operations concern, not a design one |

## 4.3 Assumptions

**Table 7 — Project assumptions (operational figures are registered separately in Table 1)**

| ID | Assumption | Impact if false |
|---|---|---|
| A-01 | A synthetic corpus generated from deterministic templates carries usable ground truth for triage labels | The absolute accuracy claim is invalidated; the project degrades to a **relative** paired comparison between prompt generations (a pre-registered response, Section 10.5) |
| A-02 | One simulated tenant profile is representative enough for design; two tenants are seeded to prove isolation | Isolation testing weakens; the mechanism claim would need re-wording |
| A-03 | A commercial language model is reachable via API for the duration of the term, with no fine-tuning | Risk R-12; mitigated by a single gateway and offline replay |
| A-04 | The facilitator approves both the project and the single-executor delivery model | Risk R-01; the project proceeds as "listed project #4, modified" and the position is recorded |
| A-05 | The case model is sufficient: there is no contractual client and no external stakeholder sign-off to obtain | Would add an approval path and a dependency outside the term |
| A-06 | Free tiers of the platform services are sufficient for a demonstration-scale system | Additional cost; would be absorbed by the declared budget cap (Section 13.4) |

## 4.4 Constraints

| ID | Constraint | Type | Consequence for the plan |
|---|---|---|---|
| C-01 | Fixed academic term dates; three hard submission deadlines exempt from any grace period | Schedule | The delivery rule is *submit the current version, unedited, at the gate* |
| C-02 | **API budget capped at A$120 for the whole term, with an automatic cut-off at A$100** | Cost | Cheap model for high-volume triage, stronger model for drafting; response caching; a budget breaker with a test |
| C-03 | Model weights frozen by design | Technical | The improvement engine may only alter prompts, schemas, workflows and validators |
| C-04 | No access to real personal information (self-imposed ethical constraint) | Ethical / legal | 100% synthetic corpus; redaction chokepoint before any external call |
| C-05 | One practitioner, six functional roles | Resource | Section 11; risk R-07 and R-13 |
| C-06 | Submission in the required document format, with Harvard referencing | Presentation | This document |
| C-07 | Demonstration must run on a laboratory computer, personal computer or mobile device | Technical | Local-first architecture, offline replay, install from a clean clone in five commands or fewer |
| C-08 | **Reduced capacity in weeks 9 to 11 (14 Sep – 4 Oct) owing to a concurrent commitment outside this project** | Resource / schedule | Project management runs at governance cadence only in that window; **no *Must*-class build work on the critical path is scheduled inside it.** Two critical-path packages do fall inside the window and are declared rather than glossed: 5.6 Packaging and 5.7b Final reporting begin in W11 — the week the M6 freeze falls in — and run past it to M7. Both are excluded by name from the M6 definition of "built" (Table 14), so what is scheduled inside the window is packaging and reporting work, not build work. The window is drawn on the schedule (Section 8.2), explained beneath it, and carried as risk R-15 |

## 4.5 Declared modification of the listed project option

Listed project #4 names, as its first key feature, an AI chatbot that answers customer questions automatically. **That feature is deliberately excluded and placed in the "Won't" row.** The reason is a professional one rather than a technical one: in this design, human approval before any customer-facing send is enforced as a **database constraint**, not as a workflow convention — a response row with a null approver cannot be persisted. Automated sending would require removing that constraint, and removing it would remove the accountability property that the rest of the system is built to support. The modification is therefore declared here, at the front, so that approval is given or withheld on an accurate description of what will be built.

## 4.6 Feasibility note — the minimum committed scope

Feasibility within the term is the criterion this proposal is most exposed on, because the architecture described is not small. The response is to state the **minimum committed deliverable** separately from the ambition, so that the commitment can be judged on its own.

**The minimum commitment is a working end-to-end vertical slice:** ticket raised in the portal → automated triage with declared confidence → grounded draft with cited knowledge-base sources → human edit, approval and send, or escalation with a stated reason → supervisor dashboard. That slice is fully within the "Must" row, and it alone satisfies the demonstration requirement. **The knowledge-gap cycle in its reduced form travels with the slice** — the gap record raised from the `GROUND` escalation and its verification-only closure, demonstrated against the synthetic corpus (FR-A15, FR-A16; work packages 4.2 and 5.1; in place for M4). What is *not* committed this term is the full acquisition cycle over real-world knowledge, which would require a fourth sealed evaluation set with its own budget; it is named in the backlog rather than implied.

**Feasibility rests on two different kinds of thing, and they are separated deliberately.** Three items below are evidence that exists on the date of this submission and can be inspected now. Two are commitments with a date, an owner and a work package — they are written as commitments because that is what they are, and a proposal that presented them as existing evidence would be making the first claim this project is designed not to make.

**Evidence that exists today**

1. **A dependency-ordered build plan of twenty-seven verifiable work packages** — the twenty-seven of Table 13, counted there and here — each ending in an artefact that is green or red rather than in a phase that is "80% done" (Sections 7 and 8). The plan, its work-package dictionary and its critical path are in this document and can be read against the schedule.
2. **A declared critical path** (Section 8.3) with the quality-engine work running as a parallel lane that can slip without stopping the demonstrable slice — so the consequence of any single delay is already known rather than discovered.
3. **A requirements baseline that already exists in seven dated versions with a change log**, rather than as a single draft, and a verified reference register in which every source carries a citability class, its mandatory caveat and the named claim it is permitted to support (WBS 2.2, 2.6). Requirements discipline is the capability this practitioner can evidence today, and it is the one the first four weeks of this plan depend on.

**Commitments, each with its date, owner and work package**

4. **A repository holding the full change history, created and pushed at M1 · 17 Aug 2026** — owner R1, WBS 1.1 and 1.3 — **and a continuous integration pipeline operating as a merge gate from M3 · 30 Aug 2026** — owner R4, WBS 5.1 with the repository rules in 1.3, extended with the accessibility gate at M6 · 4 Oct 2026 (WBS 5.3). From M3 onward, progress is externally verifiable at any moment rather than reported. Neither the repository nor the pipeline is presented here as existing evidence: both are dated commitments, and the Progress Reports are where they become evidence.
5. **A cost ceiling that cannot be exceeded by accident** (C-02), enforced by a circuit breaker with a test — owner R5, WBS 4.1.3, in place by M3 · 30 Aug 2026 — so that the project cannot fail for a reason as avoidable as an unnoticed API bill.

**What the practitioner already operates, and what is deliberately being learned.** The stack in working use is **Next.js, TypeScript, Postgres and the model provider's API**: a retrieval-augmented assistant and a production portfolio are built and deployed on it. That is what removes *platform* risk from the critical path. It is not the whole of what this project needs. **Declarative row-level security, continuous integration operating as a gate, systematic integration testing and threat modelling are competencies this practitioner does not yet hold at the level the plan requires**, and they are named as gaps in the Individual Learning Plan (Part B, Section 3.3) rather than assumed away here. They are acquired inside named work packages with dated verification — row-level security in 3.1 by M3 · 30 Aug; continuous integration as a gate in 5.1 by M3 · 30 Aug; the integration test suite in 5.1, continuous and complete at M6 · 4 Oct; the threat model in 5.4 by M6 · 4 Oct — and each one is gated by an artefact that is green or red on its date. **The feasibility claim is therefore narrower and stronger than the one an earlier draft made: the platform is known, the engineering practice is being built on a schedule, and the schedule says when each piece is checkable.**

**Complexity is appropriate rather than maximal.** This is a 12-credit-point unit and the expected effort is that of two ordinary units, which is why the project carries a genuine data model, a state machine, a deterministic algorithm with edge cases, a security model, and an evaluation subsystem — rather than a single CRUD application with a model call bolted on. Equally, the "Should" and "Could" rows exist so that the improvement engine and the negative battery can be delivered in reduced form without touching the committed slice. **Two things are never conceded under any circumstance: the ledger and the negative tests.** They are the load-bearing evidence of the entire quality argument, and a degradation ladder that sacrificed them would sacrifice the project's thesis.

---

# 5. Stakeholder needs matrix

**Table 8 — Primary stakeholders**

| Stakeholder | Interest | Needs | Quantified pain (Table 1) | How LedgerDesk serves it | Metric that proves it |
|---|---|---|---|---|---|
| **End customer** (MidCo's own user) | Get the problem solved quickly without repeating themselves | Immediate acknowledgement · visible status · a correct answer the first time · a human when it matters | p90 first response of **31 h** (AS-6); re-explaining the case; no tracking reference | Portal issues an acknowledgement and a tracking identifier on submission; assisted reply within minutes; automatic escalation when frustration or low confidence is detected; explicit "talk to a person" control | First-response p90 (target < 4 h) · escalation recall ≥ 0.90 |
| **Support agent** | Close more tickets without lowering quality | Context already gathered · a draft worth starting from · **not losing control of the reply** · their judgement counting for something | **14 min/ticket** (AS-2), roughly half spent gathering context; re-typing the same answer daily; tools that "decide for them" | Draft arrives with knowledge-base sources cited and the triage rationale visible; **the agent edits, approves and sends — always the last word**; the edit is captured as the improvement signal | AHT reduction against AS-2 · ≥ 70% of sent drafts with ≤ 20% edit distance |
| **Support supervisor** | Meet the service commitment and be able to prove it | Volume and SLA visibility · knowing whether the AI is actually right · auditability of individual decisions · cost control | No data at all: quality is estimated by impression; no audit trail explaining why a case was or was not escalated | Dashboard with volume and SLA; **Model Quality panel showing accuracy measured on the sealed reporting split with n, confidence interval, seal hash and queries consumed**; per-ticket Decision Audit Log; operations and cost panel | Accuracy reported with its interval · 100% of automated decisions auditable · A$ per ticket |

**Table 9 — Secondary stakeholders**

| Stakeholder | Interest | Needs | How served | Metric |
|---|---|---|---|---|
| **Project facilitator / Unit Coordinator** | Academic sponsor: scope, complexity, feasibility | An approvable project of appropriate complexity, demonstrable within the term | This proposal as the governing contract; a live demonstration; a repository containing the full change history | Approval on record; dated submissions against the baseline |
| **Privacy / compliance owner** | No personal information reaching a third party | Data minimisation · audit trail · lawful basis | Synthetic corpus; deterministic redaction at a single chokepoint before any external call; row-level security; append-only audit log | Zero occurrences of raw personal information leaving the tenant boundary |
| **Model provider** *(non-negotiating party, listed because it receives data)* | — | — | Declared, not managed: the provider receives whatever the scaffolding sends it. This is stated as an **open limit**, not as a closed control | Redaction test with a planted canary token that must never egress |

---

# 6. High-level requirements overview

## 6.1 Requirements method

Requirements are elicited from the stakeholder needs matrix (Section 5) and the objectives hierarchy (Section 2.2), specified with an acceptance condition, and traced through to a user story and a named integration test. The traceability chain **requirement → story → test** is generated by the continuous integration pipeline rather than maintained by hand, so that it cannot drift out of agreement with the code it describes. The engineering process follows the consensus body of knowledge codified by the IEEE (IEEE Computer Society 2024) rather than an ad-hoc method, and the non-functional requirements are classified against an international product quality model (International Organization for Standardization and International Electrotechnical Commission [ISO/IEC] 2023) rather than invented.

## 6.2 Functional requirements — application layer

**Table 10 — Application functional requirements**

| ID | Requirement | Acceptance decided by |
|---|---|---|
| FR-A01 | Three user roles — customer, agent, supervisor — plus a tenant boundary and an account service tier. Role determines every read and write | Role × resource matrix enumerated and enforced at the data layer, with a passing or failing test per cell |
| FR-A02 | A customer creates a ticket and receives an acknowledgement carrying a tracking identifier | HTTP 201, tracking identifier visible, persisted row in state `NEW` |
| FR-A03 | Every ticket moves through an explicit state machine: `NEW → TRIAGED → DRAFTED → AWAITING_AGENT → {SENT \| ESCALATED} → RESOLVED → CLOSED`, plus `REOPENED → TRIAGED` and `TRIAGE_FAILED → ESCALATED`. No transition outside this set is reachable | Illegal transitions rejected at the persistence layer, not by convention |
| FR-A04 | The system classifies each ticket by category, severity and sentiment, and **declares a confidence** | Four non-null fields plus one ledger row carrying the confidence; confidence is a first-class field, not a log line |
| FR-A05 | An SLA policy (tier × severity → first-response and resolution minutes) is **data, not code**; each ticket carries a due timestamp and breach is a queryable fact | Given a seeded policy, due dates are reproducible and breach flips deterministically at the boundary |
| FR-A06 | The queue is prioritised by a **deterministic, explainable algorithm** with a total ordering — no model call inside the decision | For any queue state the order is byte-reproducible, and every breached ticket precedes every non-breached ticket regardless of score |
| FR-A07 | The system escalates on an enumerated rule set and **reports which clause fired**, from the closed set `{CONF, SENT, TIER, RETRY, SLA, GROUND, POLICY, LANG}` | Escalated status always accompanied by exactly one code from the closed set; free-text reasons rejected |
| FR-A08 | The system drafts a response **grounded in retrieved knowledge-base content** and records which articles were used. A draft with zero sources is not a draft | Grounded status requires at least one referenced article; ungrounded routes to escalation, never to send |
| FR-A09 | **Human-in-the-loop is not bypassable**: no customer-facing response is sent or closed without a recorded human approval — a **data-layer constraint**, not a workflow convention | Persisting a sent response with a null approver fails at the database |
| FR-A10 | The agent edits, approves and sends, and the edit is captured as a first-class learning signal | Every send has a corresponding edit record, including zero-edit sends |
| FR-A11 | The supervisor dashboard shows volume, SLA compliance and triage accuracy, where accuracy is read **only from the reporting split** and rendered with n, confidence interval, seal hash and queries consumed | The dashboard cannot render an accuracy number without those four fields beside it |
| FR-A12 | Every automated decision is reconstructable from a **Decision Audit Log**: agent, prompt version, confidence, tokens, latency, cost, chained hash | For any ticket the full decision chain renders on one screen with no gaps |
| FR-A13 | The customer is **told an AI is assisting** and can always request a human; the request creates an escalation with its own service commitment | Disclosure present on every AI-assisted surface; the human-route control creates a real escalation record |
| FR-A14 | Data governance is **executable**: a personal-information dictionary, a retention policy, and a purge job that runs and reports rows removed | The purge job has a test that seeds expired rows and asserts they are gone |
| FR-A15 | When escalation fires on `GROUND`, the system **emits a knowledge-gap record** carrying the evidence of the query (terms searched, snapshot identifier, zero-match result), an owner, a committed date, and a **null-result rule declared in advance**: if no citable document is obtained, the gap is marked not-documentable and the answer is presented as reasoning over declared premises, never as policy | Every `GROUND` escalation has exactly one gap record; a record missing evidence, owner or date is refused by the writer |
| FR-A16 | A gap record moves to `CLOSED` **only** when the original query, re-run against the current snapshot, returns `grounded = true` with the admitted source. **No application path closes a gap by hand** | The closure check is the only writer of the `CLOSED` state; a manual state change is rejected at the persistence layer |
| FR-A17 | The drafting validator checks **consistency between the retrieved sources** and, when they disagree, escalates with a dedicated reason code — an addition to the closed set of FR-A07, which stays closed | Seeded contradictory sources produce the dedicated reason code, never a fluent draft |

*Numbering note.* These three requirements were first drafted as A12–A14, colliding with the existing FR-A12–A14 above; they are issued here as FR-A15–A17.

## 6.3 Functional requirements — quality instrument

**Table 11 — Quality-instrument functional requirements**

| ID | Requirement | Acceptance decided by |
|---|---|---|
| FR-I01 | An **evolvable layer over frozen weights**: prompts, schemas, workflows and validators change; model weights never do | A promoted generation differs only in the evolvable layer; the model identifier in the ledger is unchanged across the comparison |
| FR-I02 | A **per-decision ledger**: every model invocation writes one row, fail-closed | The writer refuses to persist an incomplete row |
| FR-I03 | An **evaluation firewall**: sealed partitions (selection / report / out-of-distribution), pre-committed exposure budget, visible query counter | The published number comes only from the reporting split; the counter is visible and bounded |
| FR-I04 | An **out-of-process guard**: the component holding the reserved split is not inside the process being evaluated | The residual — the guard and the candidate share an operating-system principal — is declared, not hidden |
| FR-I05 | A **promotion gate**: a paired significance test on the selection split **and** a green negative battery — not merely "improved" | Promotion writes a lineage record carrying Δ, its paired interval, the test statistic, n and the split hash |
| FR-I06 | A **negative-test battery that grows monotonically**: every adversarial round adds its case and no case is ever retired | The battery carries a version, a date and a round number |
| FR-I07 | A **metered pilot** producing real cost-per-ticket and latency figures instead of asserting them | Two non-functional requirements change status from *asserted* to *measured*, with the measurement date |
| FR-I08 | An **honestly measured result, including the null**: if the interval crosses zero, the minimum detectable effect is published instead | A null result is a deliverable, not a failure |

## 6.4 Non-functional requirements, classified under ISO/IEC 25010:2023

The 2023 edition is the **second edition** and cancels and replaces the 2011 model (ISO/IEC 2023). Three of its changes are load-bearing for this project and are the reason the classification is not decorative: *usability* became **interaction capability**, whose sub-characteristic *inclusivity* is where accessibility formally belongs; *portability* became **flexibility**, which makes "installable from a clean clone in five commands" a classified requirement rather than a nicety; and **safety** was added as a new characteristic, which is where non-bypassable human approval and fail-closed abort belong. Citing the 2011 edition would be a verifiable error.

**Table 12 — Non-functional requirements with numeric thresholds**

| ID | Characteristic → sub-characteristic | Requirement | Threshold | Verified by |
|---|---|---|---|---|
| NFR-Q01 | Functional suitability → correctness | Triage accuracy on the reporting split | Published **with n, 95% CI, split hash and query index**. **No absolute threshold is asserted** — see the note below | Firewall report |
| NFR-Q02 | Functional suitability → correctness | Escalation recall on the reporting split | **≥ 0.90** | Precision–recall curve with the operating point marked |
| NFR-Q03 | Performance efficiency → time behaviour | Triage latency, p95 | **≤ 2.5 s** | Performance harness (asserted now, measured by FR-I07) |
| NFR-Q04 | Performance efficiency → capacity | Queue re-prioritisation over *n* tickets | **O(*n*)** per tick, memory **O(*n*)** | Complexity assertion plus benchmark |
| NFR-Q05 | Performance efficiency → resource use | Cost per processed ticket | **≤ A$0.04** — *asserted, not measured*; the caveat travels with the figure | Ops & Cost panel fed by the ledger |
| NFR-Q06 | Performance efficiency → resource use | Total API budget for the term | **A$120 cap, automatic cut-off at A$100** | Budget breaker test |
| NFR-Q07 | Compatibility → interoperability | Demonstration runs on a laboratory, personal or mobile device | **1 clean machine, 0 manual patches** | Timed clean-clone install |
| NFR-Q08 | Interaction capability → **inclusivity** | **WCAG 2.2 level AA** (World Wide Web Consortium [W3C] 2024), also adopted as an international standard (ISO/IEC 2025), on the three principal flows | **0 critical automated violations**, run in CI, plus manual keyboard, focus and contrast verification. An automated pass covers only part of the success criteria and **is not a conformance audit** | Accessibility report artefact |
| NFR-Q09 | Interaction capability → self-descriptiveness | Every automated decision shown to a human displays its inputs and the clause that fired | **100%** of escalations carry a reason code; **0** free-text reasons | FR-A07 acceptance |
| NFR-Q10 | Interaction capability → user assistance | User-experience evaluation with real participants feeding at least one dated decision record | **≥ 3 participants**; findings → decision record | Evaluation report |
| NFR-Q11 | Reliability → recoverability | Demonstration reproducible **without network** | **100% replay** from the ledger, fixed seeds | Replay-mode test |
| NFR-Q12 | Reliability → fault tolerance | The evaluation budget survives worker restarts | Budget recomputed from the chained ledger, never from a variable; total accepted queries across processes equals the cap exactly | Budget-integrity test |
| NFR-Q13 | Security → confidentiality | Raw personal information reaching the model provider | **0 occurrences**; single chokepoint plus a planted canary token that must never egress | Redaction test with a network fake; canary test |
| NFR-Q14 | Security → confidentiality | Rows visible across tenants or across roles | **0** (row-level security, two seeded tenants) | Cross-tenant and cross-role isolation tests |
| NFR-Q15 | Security → integrity | Ledger and audit tables append-only; truncation detectable | Hash chain verifies intact / broken; the undetected window is bounded and published | Chain-verification test |
| NFR-Q16 | Security → accountability | Every automated decision records actor, model returned, prompt version, timestamp | **0** incomplete rows accepted (fail-closed writer) | Writer test |
| NFR-Q17 | Maintainability → testability | Implemented stories with a documented **integration** test | **1 : 1, 100%** | Generated story–test report |
| NFR-Q18 | Maintainability → modifiability | Commit discipline: atomic, attributed, ticket-referenced | **100%** of merges traceable to a work item; **0 retro-dated commits** | Repository audit |
| NFR-Q19 | Maintainability → modifiability | Design change without a dated decision record | **0 merges** — enforced by a repository hook, not by memory | Decision record log |
| NFR-Q20 | Maintainability → modularity | The application layer must not import the quality layer | **0 violations**, enforced by a CI check | Dependency graph check |
| NFR-Q21 | Flexibility → installability | Install from a clean clone | **≤ 5 commands**, timed and recorded | Recorded clean run |
| NFR-Q22 | Flexibility → adaptability | Environment pinned and reproducible | Lockfile digest identical across runs; a moved environment **aborts fail-closed** | Environment attestation test |
| NFR-Q23 | **Safety** → operational constraint | The system cannot send or close a customer response without human approval | Enforced as a **database constraint**; **0** sends with a null approver | FR-A09 acceptance |
| NFR-Q24 | **Safety** → fail-safe | Any aborted evaluation run produces **no publishable number** | Abort is recorded and the number is withheld | Abort-control test |
| NFR-Q25 | **Safety** → hazard warning | Prompt injection and policy-flagged content never auto-send; the injection corpus is built against the published risk catalogue for agentic applications (OWASP Foundation 2025) | **100% escalation** on a fixed injection corpus; **0** auto-sends | Injection corpus in CI |
| NFR-Q26 | **Safety** → risk identification | Bias probe across cohorts (tier, locale, message length, name substitution) | Probe runs every release; disparity reported **with intervals**, never as a point estimate | Fairness report |

**Note on NFR-Q01, stated deliberately.** Earlier drafts carried an absolute target of "accuracy ≥ 85%". That figure was **an example of formulation, not a derived threshold**, and it is withdrawn as a stated target for a reason that is arithmetic rather than modest: on a hand-labelled sample of 100–150 items, a 95% confidence interval around 0.85 is approximately ±5.7 percentage points, which means the result could not distinguish 85% from 79%. The sample size available in this term cannot support that precision, so the target is not stated in those terms. The requirement is therefore stated as it can be honoured: **accuracy is published as a point estimate with its interval, its n, its split hash and its query index**, and the project's primary quality claim is the **paired change between prompt generations** with its confidence interval — a comparison that remains valid even where the absolute level is uncertain. If the pilot supports a defensible absolute threshold, it will be adopted by dated decision record.

## 6.5 Requirements traceability

Every requirement in Tables 10–12 resolves to a user story with a testable acceptance criterion and a named integration test. The ten layer-one stories that constitute the demonstrable slice are: ticket submission and acknowledgement; triage with declared confidence; grounded draft with cited sources; escalation with a stated clause; the knowledge-gap record with verification-only closure; agent edit, approve and send with feedback capture; supervisor dashboard reading the sealed split; per-ticket audit log; generation-to-generation comparison with uncertainty; and AI disclosure with a human route. The traceability matrix is **generated in CI**, so it cannot silently disagree with the code.

## 6.6 Course-level product requirements

The requirements above specify the product. Five further requirements are imposed by the unit on the deliverable itself; they are recorded here as requirements rather than as narrative so that they carry the same acceptance discipline as the rest, and so that Part B can trace a learning goal to them.

**Table 12b — Course-level product requirements**

| ID | Requirement | Acceptance decided by |
|---|---|---|
| FR-C01 | The deliverable is a **smart enterprise application** with business value, inside which the quality instrument lives. The wrapper is listed project #4, *AI-Based Customer Support Automation System*, modified as declared in Section 4.5 | An application a user operates, not a script with a report; the modification declared and submitted for approval (Section 15, Q-1) |
| FR-C02 | A **demonstrable end-to-end vertical slice** by the demonstration date, runnable on a laboratory, personal or mobile device, with an offline fallback | Slice runs end to end at M4; offline replay verified (NFR-Q11); `demo-w7` tag created before presenting |
| FR-C03 | A **fully-working enterprise application** at final submission — not a mock | All ten layer-one stories executable against the seeded environment at M7, with the generated story–test report as evidence |
| FR-C04 | **Systematic testing**, with a documented integration test per implemented user story, and non-functional thresholds that are testable in the demonstration | 1 : 1 story-to-integration-test ratio in the generated report (NFR-Q17); each threshold in Table 12 verified by its named verifier |
| FR-C05 | A **project tracking tool with visible evidence**, and a repository containing the history of all changes to the source code | Board with visible flow (WBS 1.2.1); repository link submitted with the final report, its history unbroken from M1 |

These five are traced in the same way as Tables 10–12: FR-C02 and FR-C03 are gated by milestones M4 and M7 respectively (Section 8.1), FR-C04 by NFR-Q17 and work package 5.1, and FR-C05 by work packages 1.2 and 1.3.

---

# 7. Work decomposition

## 7.1 Work breakdown structure

The structure decomposes to three levels across five branches. **Rule applied to every level-3 package: one verifiable deliverable, one named task lead, one assessment criterion it satisfies.** Nothing appears in the structure that does not end in an artefact.

```
LedgerDesk — Capstone Delivery
│
├── 1.0  PROJECT MANAGEMENT
│    ├── 1.1  Baseline and schedule
│    │     ├── 1.1.1  Project proposal (this document)
│    │     ├── 1.1.2  Schedule, dependencies and critical path
│    │     └── 1.1.3  Sealed baseline tag  (baseline-v1.0)
│    ├── 1.2  Tracking and reporting
│    │     ├── 1.2.1  Project board with visible flow
│    │     ├── 1.2.2  Weekly status record
│    │     └── 1.2.3  Mentor meeting minutes (official template)
│    └── 1.3  Risk, change and configuration
│          ├── 1.3.1  Risk register upkeep and review
│          ├── 1.3.2  Architecture decision record log
│          └── 1.3.3  Divergence log (baseline vs actual)
│
├── 2.0  REQUIREMENTS AND DESIGN
│    ├── 2.1  Stakeholder analysis
│    │     └── 2.1.1  Stakeholder needs matrix
│    ├── 2.2  Requirements specification
│    │     ├── 2.2.1  Functional requirements (application + instrument)
│    │     ├── 2.2.2  Non-functional requirements under ISO/IEC 25010:2023
│    │     └── 2.2.3  Traceability skeleton (requirement → story → test)
│    ├── 2.3  User stories
│    │     ├── 2.3.1  Layer 1 — demonstrable MVP stories
│    │     └── 2.3.2  Layer 2 — backlog declared out of scope
│    ├── 2.4  Domain model
│    │     ├── 2.4.1  Entity model and data dictionary
│    │     └── 2.4.2  Ticket state machine
│    ├── 2.5  Architecture
│    │     ├── 2.5.1  Architecture decision records
│    │     └── 2.5.2  Module seam: application layer vs quality layer
│    └── 2.6  Best-practice review
│          ├── 2.6.1  Annotated bibliography with named consumers
│          └── 2.6.2  Verified reference register (incl. sourcing action A-1)
│
├── 3.0  APPLICATION BUILD
│    ├── 3.1  Platform skeleton
│    │     ├── 3.1.1  Authentication and three roles
│    │     ├── 3.1.2  Schema and migrations
│    │     └── 3.1.3  Row-level security policies (two seeded tenants)
│    ├── 3.2  Customer portal
│    │     ├── 3.2.1  Raise ticket with acknowledgement and tracking id
│    │     ├── 3.2.2  Track ticket status
│    │     └── 3.2.3  AI disclosure and request-a-human route
│    ├── 3.3  Agent console
│    │     ├── 3.3.1  Queue with priority explainer
│    │     ├── 3.3.2  Draft edit / approve / send
│    │     └── 3.3.3  Edit capture as learning signal
│    ├── 3.4  Supervisor dashboard
│    │     ├── 3.4.1  Volume and SLA compliance
│    │     ├── 3.4.2  Model Quality surface (sealed split, n, CI, hash)
│    │     └── 3.4.3  Operations and cost panel
│    └── 3.5  Data seeding
│          ├── 3.5.1  Synthetic ticket generator with ground truth
│          ├── 3.5.2  Two-organisation seed
│          └── 3.5.3  Knowledge-base corpus
│
├── 4.0  AI AND QUALITY ENGINE
│    ├── 4.1  Model gateway
│    │     ├── 4.1.1  Single chokepoint for all model calls
│    │     ├── 4.1.2  Deterministic redaction and canary token
│    │     └── 4.1.3  Budget breaker and response cache
│    ├── 4.2  Prompt roles
│    │     ├── 4.2.1  Triage role with declared confidence
│    │     ├── 4.2.2  Retrieval and grounded drafting role
│    │     └── 4.2.3  Escalation validation role
│    ├── 4.3  Deterministic algorithms
│    │     ├── 4.3.1  Composite SLA-aware priority function
│    │     ├── 4.3.2  Escalation rule with closed reason set
│    │     └── 4.3.3  Edge cases and weight-sensitivity table
│    ├── 4.4  Decision ledger
│    │     ├── 4.4.1  Schema with input path, seed, split, hash chain
│    │     ├── 4.4.2  Append-only enforcement and truncation detection
│    │     └── 4.4.3  Decision Audit Log surface
│    ├── 4.5  Evaluation firewall
│    │     ├── 4.5.1  Sealed splits with committed hash and withheld salt
│    │     ├── 4.5.2  Out-of-process guard and query budget counter
│    │     └── 4.5.3  Blind human sample, agreement measure, OOD probe
│    └── 4.6  Improvement engine
│          ├── 4.6.1  Prompt versioning with lineage
│          ├── 4.6.2  Promotion gate (paired test + green battery)
│          └── 4.6.3  Negative-test battery, five families
│
└── 5.0  VERIFICATION AND RELEASE
     ├── 5.1  Test suite
     │     ├── 5.1.1  One documented integration test per story
     │     ├── 5.1.2  Story–test report generator
     │     └── 5.1.3  Traceability matrix generator
     ├── 5.2  Non-functional harness
     │     ├── 5.2.1  Performance and latency harness
     │     └── 5.2.2  Metered cost pilot
     ├── 5.3  Accessibility
     │     ├── 5.3.1  Automated checks in CI on three flows
     │     └── 5.3.2  Manual keyboard, focus and contrast verification
     ├── 5.4  Security and privacy
     │     ├── 5.4.1  STRIDE threat table with a test per row
     │     ├── 5.4.2  Prompt-injection corpus in CI
     │     └── 5.4.3  Dependency audit and secret scanning
     ├── 5.5  User-experience evaluation
     │     ├── 5.5.1  Heuristic walkthrough
     │     └── 5.5.2  Sessions with 3–5 participants → decision records
     ├── 5.6  Packaging
     │     ├── 5.6.1  README with ≤ 5 install commands
     │     ├── 5.6.2  Timed install from a clean clone
     │     └── 5.6.3  Offline replay mode and environment lockfile
     └── 5.7  Demonstration and reporting
           ├── 5.7.1  Demonstration script and recorded rehearsal
           ├── 5.7.2  Progress reports 1 and 2
           └── 5.7.3  Final report, presentation and reflection
```

## 7.2 Work package dictionary

**Table 13 — WBS dictionary at work-package level (27 packages)**

**Lead roles R1–R6 are defined in Section 11.3, Table 17**, with their responsibilities, decision rights and hand-off artefacts; they are used here first because the work decomposition is what the role structure is drawn against.

| WBS | Work package | Deliverable | Lead role | Predecessor |
|---|---|---|---|---|
| 1.1 | Baseline and schedule | Approved proposal, schedule, `baseline-v1.0` tag | R1 | — |
| 1.2 | Tracking and reporting | Board, weekly status records, minutes | R1 | 1.1 |
| 1.3 | Risk, change and configuration | Risk register, decision records, divergence log | R1 | 1.1 |
| 2.1 | Stakeholder analysis | Stakeholder needs matrix | R1 | — |
| 2.2 | Requirements specification | Requirements set with thresholds and traceability skeleton | R1 | 2.1 |
| 2.3 | User stories | Two-layer story set with acceptance criteria | R1 | 2.2 |
| 2.4 | Domain model | Entity model, data dictionary, state machine | R2 | 2.2 |
| 2.5 | Architecture | Decision records, module seam definition | R2 | 2.4 |
| 2.6 | Best-practice review | Annotated bibliography, verified reference register | R1 | 2.2 |
| 3.1 | Platform skeleton | Auth, schema, migrations, row-level security | R3 | 2.4, 2.5 |
| 3.2 | Customer portal | Raise, track, disclosure, human route | R3 | 3.1 |
| 3.3 | Agent console | Queue explainer, edit/approve/send, edit capture | R3 | 3.1, 4.2 |
| 3.4 | Supervisor dashboard | Volume, SLA, Model Quality, cost panel | R3 | 4.4, 4.5 |
| 3.5 | Data seeding | Synthetic generator, two-tenant seed, knowledge base | R3 | 3.1 |
| 4.1 | Model gateway | Chokepoint, redaction, canary, budget breaker | R5 | 3.1 |
| 4.2 | Prompt roles | Triage, drafting, escalation validation | R3 | 4.1, 4.3 |
| 4.3 | Deterministic algorithms | Priority function, escalation rule, sensitivity table | R2 | 2.4 |
| 4.4 | Decision ledger | Schema, append-only enforcement, audit surface | R4 | 3.1 |
| 4.5 | Evaluation firewall | Sealed splits, guard, query budget, blind sample | R4 | 4.4 |
| 4.6 | Improvement engine | Prompt lineage, promotion gate, negative battery | R4 | 4.5 |
| 5.1 | Test suite | Integration test per story, generated reports | R4 | 3.3, 2.3 |
| 5.2 | Non-functional harness | Performance results, metered cost pilot | R4 | 4.4 |
| 5.3 | Accessibility | CI accessibility report, manual verification record | R6 | 3.3 |
| 5.4 | Security and privacy | Threat table with tests, injection corpus, audits | R5 | 4.1, 3.3 |
| 5.5 | User-experience evaluation | Walkthrough and participant findings → decision records | R6 | 3.3 |
| 5.6 | Packaging | README, timed clean install, replay mode, lockfile | R3 | 3.4 |
| 5.7 | Demonstration and reporting | Rehearsal, progress reports, final report and presentation | R1 | 5.6 |

---

# 8. Delivery roadmap

## 8.1 Milestones and dependencies

**Table 14 — Milestone schedule**

| ID | Milestone | Date | Depends on | Exit condition (what makes it true) |
|---|---|---|---|---|
| **M1** | Progress Report 1 submitted | Mon 17 Aug 2026 | 1.1, 1.2 | Uploaded before the deadline; no grace period applies |
| **M2** | **Documentary baseline sealed** | Sun 23 Aug 2026 | M1, 2.1–2.5 | Tag `baseline-v1.0` exists, is immutable, and the skeleton starts on the local machine |
| **M3** | End-to-end vertical slice running, rehearsal recorded | Sun 30 Aug 2026 | M2, 3.1–3.3, 4.1–4.4 | The slice runs end to end (running, not "nearly"); a complete rehearsal recording exists |
| **M4** | **Prototype demonstration (Week 7 class)** | Week of 31 Aug – 4 Sep 2026 | M3 | Demonstration delivered, tag `demo-w7` created **before** presenting, dated screenshots archived the same day |
| **M5** | Metered pilot complete; Progress Report 2 submitted | Mon 14 Sep 2026 | M4, 4.5, 5.2 | Pilot report with real cost and latency figures; report uploaded |
| **M6** | **Feature freeze** | Sun 4 Oct 2026 | M5, 4.6, 5.1, 5.3–5.5 | Nothing is built after this date. **"Built" is defined for this exit condition as: new or changed behaviour in the application, the model gateway, the deterministic algorithms, the ledger, the evaluation firewall or the improvement engine.** Packaging, documentation, the timed clean install, the offline replay lockfile, reporting and presentation work are explicitly **outside** that definition and are scheduled after the freeze by design (work packages 5.6 and 5.7b); so is a defect fix to already-implemented behaviour, which requires a dated decision record and a regression test. Incomplete features are documented as divergences with dated decision records and are not finished |
| **M7** | Final report, working application and presentation submitted | 12–13 Oct 2026 | M6, 5.6, 5.7 | All three artefacts uploaded, each under the submit-current-version rule |

## 8.2 Delivery schedule (Gantt)

**Shaded cells represent calendar windows and their dependencies. They are not effort estimates**, and they are deliberately not presented as such: this project is delivered by one practitioner whose available hours vary week to week, and drawing effort bars would assert a precision the plan does not have. Sequence, dependency and the critical path are what the schedule commits to.

**Table 14b — Delivery schedule.** `█` = work package active in that calendar window · `░` = reduced-capacity window (see the note below the table) · `◆` = milestone gate · `*` = on the critical path (Section 8.3) · VAC = university vacation week (a calendar fact, not a capacity assumption). Each column is a Monday-to-Sunday calendar week labelled by its Monday, and **each gate is drawn in the week that contains its date in Table 14** — so M2 (Sun 23 Aug) sits in W6, and M6 (Sun 4 Oct) sits in W11, the last day of that week. Work package 5.7 is scheduled in two separate windows and is therefore drawn as two rows, 5.7a (recorded rehearsal) and 5.7b (final reporting); the schedule shows twenty-eight rows against the twenty-seven packages of Table 13 for that reason alone.

| WBS | Work package | W6<br>17 Aug | VAC<br>24 Aug | W7<br>31 Aug | W8<br>7 Sep | W9<br>14 Sep | W10<br>21 Sep | W11<br>28 Sep | W12<br>5 Oct | EXAM<br>12 Oct |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.1 | Baseline and schedule | █ | █ | | | | | | | |
| — | **M1 · Progress Report 1** | **◆** | | | | | | | | |
| 1.2 | Tracking and reporting | █ | █ | █ | █ | █ | █ | █ | █ | █ |
| 1.3 | Risk, change and configuration | █ | █ | █ | █ | █ | █ | █ | █ | █ |
| 2.1 | Stakeholder analysis | █ | | | | | | | | |
| 2.2 | Requirements specification | █ | █ | | | | | | | |
| 2.3 | User stories | █ | █ | | | | | | | |
| 2.4 | Domain model | █ | █ | | | | | | | |
| 2.5 | Architecture | █ | █ | | | | | | | |
| 2.6 | Best-practice review | █ | █ | | | █ | | █ | | |
| 3.1 | Platform skeleton `*` | █ | █ | | | | | | | |
| 3.5 | Data seeding | | █ | | | | | | | |
| — | **M2 · Documentary baseline sealed** | **◆** | | | | | | | | |
| 4.1 | Model gateway `*` | | █ | | | | | | | |
| 4.3 | Deterministic algorithms | | █ | | | | | | | |
| 4.4 | Decision ledger `*` | | █ | | | | | | | |
| 4.2 | Prompt roles `*` | | █ | █ | | | | | | |
| 3.2 | Customer portal | | █ | █ | | | | | | |
| 3.3 | Agent console `*` | | █ | █ | | | | | | |
| 5.7a | Recorded rehearsal `*` | | █ | █ | | | | | | |
| — | **M3 · Vertical slice running** | | **◆** | | | | | | | |
| — | **M4 · Prototype demonstration** | | | **◆** | | | | | | |
| 4.5 | Evaluation firewall | | | █ | █ | | | | | |
| 5.2 | Non-functional harness | | | | █ | | | | | |
| 3.4 | Supervisor dashboard | | | | █ | █ | | | | |
| — | **M5 · Metered pilot · Progress Report 2** | | | | | **◆** | | | | |
| — | **Reduced-capacity window** (concurrent commitment; governance cadence only — see below) | | | | | ░ | ░ | ░ | | |
| 4.6 | Improvement engine | | | | | | █ | █ | | |
| 5.1 | Test suite | | | █ | █ | █ | █ | █ | | |
| 5.3 | Accessibility | | | | | | | █ | | |
| 5.4 | Security and privacy | | | | █ | | | █ | | |
| 5.5 | User-experience evaluation | | | | | | | █ | | |
| 5.6 | Packaging `*` | | | | | | | █ | █ | |
| — | **M6 · Feature freeze** | | | | | | | **◆** | | |
| 5.7b | Final reporting `*` | | | | | | | █ | █ | █ |
| — | **M7 · Final submissions** | | | | | | | | | **◆** |

**The reduced-capacity window, stated rather than left on the chart.** Weeks 9 to 11 (14 September to 4 October) carry a **concurrent commitment outside this project** that reduces the hours available to it. During that window the project management branch runs at **governance cadence only** — the weekly status record, the board, the risk review and the mentor meeting continue; nothing else in branch 1.0 is scheduled. This is declared as constraint **C-08** and registered as risk **R-15**, with the trigger and the contingency written in Section 9.2, so that the reduction is carried in the constraint register and the risk register rather than only on the chart.

**What the window means for the work placed against it, and why the plan is still honest.** The last week of the window, W11 (28 September – 4 October), is the busiest column of the delivery phase: **ten rows are active in it — 1.2, 1.3, 2.6, 4.6, 5.1, 5.3, 5.4, 5.5, 5.6 and 5.7b.** They are not of one kind, and the claim this plan makes is only true of some of them, so they are separated here rather than counted together.

- **Governance cadence (1.2, 1.3), plus one discrete review (2.6).** 1.2 and 1.3 are what C-08 explicitly keeps running — the weekly status record, the board, the risk review, and the decision-record and divergence logs. They are the window's declared floor, not work added to it. 2.6 Best-practice review sits in branch 2.0 and is therefore outside the C-08 declaration; it is scheduled in W11 as a single review pass rather than as continuing cadence.
- **The quality lane (4.6, 5.1, 5.3, 5.4, 5.5) — five packages, and *none of the five is on the critical path*.** Four of them (4.6, 5.3, 5.4, 5.5) are *Should*-class work that the degradation ladder is written to reduce, and the demonstrable slice is complete and demonstrated at M4, before the window opens. The fifth, 5.1, is the integration test suite: it runs continuously from W7 rather than starting at W11, and what falls in W11 is its completion against the last implemented stories.
- **Packaging and reporting (5.6, 5.7b) — and these two *are* on the critical path.** This is stated here rather than left for a reader to find on the chart. 5.6 Packaging and 5.7b Final reporting begin in W11, which is the week the M6 freeze falls in, and run past the freeze to M7. They are there by design and not by drift: both are excluded **by name** from the M6 definition of "built" (Table 14), so what sits inside the window is packaging, documentation, the timed clean install, the replay lockfile and reporting — not new or changed system behaviour.

**The claim this plan therefore makes is the narrow one, and it is the one written into C-08 and R-15: no *Must*-class build work on the critical path is scheduled inside the reduced-capacity window.** It is not the broader claim that nothing on the critical path falls inside it; two packages do, they are named above, and the reason they can sit there is that neither of them builds anything.

The consequence is stated in advance: if the window bites, the degradation ladder of Section 10.7 executes in its declared order, so the improvement engine reduces to two compared generations rather than a full curve, the accessibility work reduces to the automated CI gate plus a documented manual pass, and the user-experience evaluation reduces to the minimum three participants of NFR-Q10. **Packaging and final reporting are protected ahead of all of that, because M7 cannot move.** What does **not** move either is the integration test suite, the ledger and the negative battery.

**What is deliberately left open.** Whether the hours available in W11 can carry the completion of the quality lane *and* the start of packaging depends on how much of the concurrent commitment actually lands in that week, and that is a capacity fact rather than a planning fact — it is not knowable at the date of this proposal. The plan is drawn as it is on purpose, and the response if it does not hold is written rather than improvised: the R-15 contingency executes, the quality lane concedes in the declared order, and 5.6 and 5.7b keep their hours. If the concurrent commitment turns out to be heavier than assumed, the schedule is re-issued as a dated amendment with a decision record, under the baseline statement above, rather than quietly re-drawn.

## 8.3 Critical path

**Critical path of demonstrability:**

> **3.1 Platform skeleton → 4.4 Decision ledger → 4.1 Model gateway → 4.2 Prompt roles → 3.3 Agent console → 5.7a Recorded rehearsal → M4 Demonstration → 5.6 Packaging → 5.7b Final reporting → M7**

Three ordering rules govern that path and are not negotiable:

1. **The ledger lands before any prompt role writes a row.** A ledger made append-only after data has been written to it is a ledger whose earlier rows cannot be compared with its later ones — and generation-to-generation comparability is the project's core evidence.
2. **The gateway lands before any prompt role.** A redaction chokepoint added afterwards turns the privacy guarantee from a structural property into a promise.
3. **The deterministic algorithm is built and tested before the prompt roles**, on synthetic feature vectors, so that it does not depend on model behaviour working first.

**Parallel quality lane (never on the critical path):** 4.5 → 4.6 → 5.1 → 5.3 → 5.4 → 5.5. Its first package, 4.5 Evaluation firewall, completes before the reduced-capacity window opens; the remaining five are the ones Section 8.2 names as active in W11. This lane can slip by a week without endangering the demonstration, which is exactly why it is structured this way; the order in which it concedes under pressure is Section 10.7, and the ledger and the negative battery are not part of it because they are never conceded at all.

**Float.** The Should-class work (improvement engine, negative battery, cost panel) carries genuine float against M6. The Must-class slice carries none after M3, which is why M3 has an explicit control (Section 9, R-14): if the slice is not running by 25 August, all quality-engine work stops until it is.

---

# 9. Risk identification and mitigation plan

## 9.1 Method

Risks are scored on probability and impact, each 1 (very low) to 5 (very high); exposure is their product. Every risk carries an **observable trigger** — a condition someone can check, on a date, without judgement — and a contingency that executes without further deliberation once the trigger fires. A risk whose response depends on someone deciding at the time is not managed.

**Where the AI-specific risks come from.** The delivery and academic risks below are identified from the project's own structure. The risks that belong to the architecture rather than to the schedule — an improvement loop that optimises against its own evaluation signal, content that arrives from outside and is treated as instruction, and a persistent decision record that a later process can rewrite — are organised against the published risk catalogue for agentic applications (OWASP Foundation 2025), whose declared scope covers tool-using agents with persistent memory, and whose *least agency* principle is the rule that bounds what the evolvable layer is allowed to touch (C-03). That catalogue is a risk-awareness framework and not a certification: mapping a control to it evidences design intent, not conformance, and no individual category identifier is quoted here. The caution is not theatrical: the published empirical taxonomy of multi-agent LLM system failures reports failure rates of 41% to 86.7% on the seven state-of-the-art open-source systems it studies (Cemri *et al.* 2025, p. 2) — whole-task failure rates per framework, not a property of its fourteen failure modes — which is one more reason this project's pipeline is described as three sequential prompt roles and never as a multi-agent architecture (Table 5).

## 9.2 Risk register

**Table 15 — Risk register**

| ID | Risk | P | I | Exp | Response | Mitigation | Observable trigger | Contingency | Owner |
|---|---|---|---|---|---|---|---|---|---|
| **R-01** | Project or delivery model not approved by the facilitator | 3 | 5 | **15** | Mitigate | Project drawn from the unit's own option list and presented as #4 modified, with the modification declared (Section 4.5); formal written approval request accompanying this proposal | No written approval by 18:00, Thu 27 Aug | Proceed and describe the project as "listed project #4, modified" in all subsequent documents; record the position in the next progress report | R1 |
| **R-02** | Model non-determinism breaks the live demonstration | 4 | 5 | **20** | Mitigate + fallback | Temperature zero on the demonstration path, response cache keyed by hash, fixed seeds, offline replay from the ledger, complete rehearsal recorded in advance | Two consecutive failed runs, in rehearsal or live | **Two-attempt rule**: switch to the recorded run without a third attempt, and continue the verbal walkthrough — the explanation carries marks in its own right | R3 |
| **R-03** | Circularity of the synthetic evaluation set (templates both generate and are judged) | 4 | 4 | **16** | Mitigate + declare | Template-generated ground truth, controlled perturbations, a blind human-labelled sample, and an out-of-distribution probe set | Inter-rater agreement on the blind sample below 0.70 | **Pre-registered degradation**: drop the absolute accuracy claim and report only the paired relative change between generations; declare the limitation in the final report | R4 |
| **R-04** | API overspend | 3 | 3 | **9** | Mitigate | Cheap model for high-volume triage, stronger model only for drafting, response cache, running counter on the cost panel | Cumulative spend reaches A$100 | Automatic cut-off; system continues in offline replay mode | R1 |
| **R-05** | Personal information exposed to the model provider | 2 | 5 | **10** | Avoid + mitigate | 100% synthetic corpus; single gateway chokepoint with deterministic redaction; a planted canary token; a CI test that forbids direct SDK imports anywhere else | Canary token appears in an outbound payload in CI | Freeze the affected flow; the send path fails closed rather than degrading | R5 |
| **R-06** | Scope creep | 4 | 3 | **12** | Mitigate | MoSCoW with a written "Won't" row; layer-2 backlog declared out of scope with reasons; feature freeze at M6 | Any board item that cannot be traced to a WBS package | Record as a divergence with a dated decision record; do not implement | R1 |
| **R-07** | Single point of failure — no peer reviewer | 3 | 4 | **12** | Mitigate | Role separation enforced by artefact; CI as a mechanical reviewer; weekly mentor meeting as external review; cross-role checklist signed before each gate | Any deliverable reaching its gate without a cross-role checklist entry | A dedicated, dated quality session before the gate; request facilitator or peer review of the affected artefact | R1 |
| **R-08** | Undocumented divergence from the baseline | 3 | 3 | **9** | Avoid | Repository rule: a change to a frozen-core artefact without a decision record **blocks the merge** — a repository hook, not a memory aid | A merge request touching a frozen-core file with no decision-record reference | Decision-record audit before every submission; retrospective record written the same day | R2 |
| **R-09** | Ambiguity in the assessment specification (two official sources disagreeing) | 4 | 3 | **12** | Mitigate | Deliverables written to satisfy both readings; open questions submitted to the facilitator in one consolidated list (Section 15) | Two official sources found to disagree on the same requirement | Adopt the stricter reading, declare the interpretation in writing, and proceed | R1 |
| **R-10** | Silent regression when a prompt generation is promoted | 3 | 4 | **12** | Mitigate | Promotion gate requires a paired significance test on the selection split **and** a green negative battery; neither alone is sufficient | Battery not green, or the paired interval crosses zero | Roll back to the previous generation using the lineage record; publish the minimum detectable effect instead of a change | R4 |
| **R-11** | Loss of work — repository, environment or database | 2 | 5 | **10** | Avoid | Remote repository from day one; every artefact committed the day it is produced; migrations and seed scripts are the source of truth, not a local database; CI retains build artefacts | Any project artefact existing only locally for more than 24 hours | Rebuild from the last remote tag; re-apply migrations and re-seed | R3 |
| **R-12** | Provider API change, deprecation or access revocation | 2 | 4 | **8** | Mitigate | All calls behind one gateway; model identifier recorded in every ledger row; response cache; replay mode independent of the network | Deprecation notice, or a non-transient authorisation error from the provider | Switch the model identifier at the gateway; demonstrate from replay; record the change as a decision record and a declared divergence | R5 |
| **R-13** | Unavailability of the single practitioner (illness, work, administrative) | 3 | 5 | **15** | Mitigate | Fixed weekly cadence; work committed daily; every deliverable kept in a submittable state so that "submit now" is always possible | Any five-day period with no commit and no status record | Request alternative arrangements **in writing at least seven days before** any live event; submit the current version rather than an improved one | R1 |
| **R-14** | Prototype not demonstrable on the scheduled demonstration day | 3 | 5 | **15** | Mitigate + fallback | Vertical slice prioritised above everything in the quality lane; complete rehearsal recorded by 28 Aug; three-layer fallback (local offline · recorded run · code walkthrough against the stories) | Slice not running end to end on the local machine by 18:00, Tue 25 Aug | **All quality-engine work freezes until the slice runs.** On the day, demonstrate what is implemented and state aloud what is partial | R3 |
| **R-15** | **The reduced-capacity window (C-08) overruns, or the concurrent commitment consumes more than the weeks 9–11 window declared for it** | 3 | 3 | **9** | Mitigate + declare | The window is drawn on the schedule (Section 8.2) rather than absorbed silently; **no *Must*-class build work on the critical path is scheduled inside it**, and the two critical-path packages that do fall inside it — 5.6 Packaging and 5.7b Final reporting, beginning in W11 and running past the freeze — are named in C-08 and in Section 8.2 rather than left on the chart, and are outside the M6 definition of "built"; the demonstrable slice is complete at M4, three weeks earlier; the quality-lane packages converging on the far edge of the window (4.6, 5.3, 5.4, 5.5) are exactly the ones the degradation ladder reduces first | Any week between 14 Sep and 4 Oct closing with no commit and no status record, **or** the concurrent commitment still consuming project hours on 5 Oct | Execute the degradation ladder (Section 10.7) in its declared order immediately rather than at the freeze: drop *Could* items, reduce the improvement engine to two compared generations, reduce accessibility to the automated CI gate plus a documented manual pass, hold the user-experience evaluation at the minimum three participants of NFR-Q10. **Because 5.6 and 5.7b are on the critical path to M7 and M7 cannot move, they are protected ahead of every *Should*-class item in W11**: if the window bites in that week, the quality lane concedes first and packaging and reporting keep their hours. The ledger, the negative battery and the integration test suite are not conceded. Record each concession as a dated decision record on the day it is made | R1 |

## 9.3 Risk heat map

**Figure 1 — Probability × impact heat map** (cell contents are risk IDs)

```
              IMPACT →
              1        2        3        4              5
        ┌────────┬────────┬────────┬─────────────┬─────────────────┐
   5    │        │        │        │             │                 │
        ├────────┼────────┼────────┼─────────────┼─────────────────┤
   4    │        │        │  R-06  │    R-03     │      R-02       │
P       │        │        │  R-09  │             │                 │
R       ├────────┼────────┼────────┼─────────────┼─────────────────┤
O  3    │        │        │  R-04  │    R-07     │  R-01  R-13     │
B       │        │        │  R-08  │    R-10     │  R-14           │
        │        │        │  R-15  │             │                 │
        ├────────┼────────┼────────┼─────────────┼─────────────────┤
↓  2    │        │        │        │    R-12     │  R-05  R-11     │
        ├────────┼────────┼────────┼─────────────┼─────────────────┤
   1    │        │        │        │             │                 │
        └────────┴────────┴────────┴─────────────┴─────────────────┘

  Exposure bands (probability x impact), not column labels:
  LOW 1-6  ·  MEDIUM 8-12  ·  HIGH 15-25
```

**Concentration and what it means.** **Five risks sit in the high band**, that is, at an exposure of 15 or more: **R-02 (20), R-03 (16), R-01 (15), R-13 (15) and R-14 (15)** — five risks in three cells of the heat map, since R-01, R-13 and R-14 share one probability-impact position. Four of them (R-01, R-02, R-13, R-14) share one characteristic: their impact is felt at a **live, unrepeatable event**. R-03 sits at the boundary of that pattern, since what it damages is a published quality claim rather than an event, and its mitigation is correspondingly a pre-registered degradation rather than a rehearsal. That is why the plan front-loads the recorded rehearsal, the two-attempt rule and the written request for alternative arrangements — the mitigations for the highest-exposure risks are all *scheduled before the event*, not improvised at it.

## 9.4 Risk review cadence

The register is reviewed weekly against the board, and formally re-scored at M2, M4 and M6. Any new risk is added with its trigger at the moment it is identified, not at the next review. Closed risks are struck and annotated in place rather than deleted, so that the register shows the project's history and not only its present.

---

# 10. Quality considerations

## 10.1 Quality management approach

Four quality management principles are adopted explicitly, and each has a mechanism rather than an intention:

| Principle | Mechanism in this project |
|---|---|
| **Prevention over inspection** | Constraints are enforced where they cannot be forgotten: human approval is a database constraint, append-only is a database grant plus a trigger, and the module boundary is a CI check |
| **Quality built into the process** | Every push runs the full suite; the story–test report and the traceability matrix are *generated*, never hand-written |
| **Continuous improvement with measurement** | A plan–do–check–act loop over prompt generations: propose a change, evaluate on the selection split, gate on a paired test plus a green battery, promote or roll back |
| **Independence of the verification function** | The evaluation firewall *is* that independence, implemented in code: the improvement engine cannot consult the data the published numbers come from |

## 10.2 Quality planning, assurance and control

**Table 16 — Quality management plan**

| Layer | Activity | Artefact produced | Frequency | Responsible role |
|---|---|---|---|---|
| **Planning** | Define quality attributes and thresholds against the ISO/IEC 25010:2023 characteristics | Non-functional requirements set (Table 12) | Once at baseline; amended by decision record | R1 / R4 |
| **Planning** | Define acceptance criteria per user story | Story set with testable criteria | At story creation | R1 |
| **Planning** | Declare the degradation ladder in advance | Written order in which scope is conceded (Section 10.7) | Once at baseline | R1 |
| **Assurance** | Continuous integration on every push: build, unit, integration, boundary and dependency checks | Green or red pipeline, publicly visible in the repository | Every push | R4 |
| **Assurance** | One documented integration test per implemented story | Generated story–test report | Every push | R4 |
| **Assurance** | Threat model with one test per threat row | Threat table with test names and results | At each security package increment | R5 |
| **Assurance** | Accessibility checks on three principal flows | CI accessibility report plus manual verification record | Weekly from M3 | R6 |
| **Assurance** | Cross-role review checklist before every gate | Signed and dated checklist entry | Before each milestone | R1 |
| **Control** | Sealed evaluation splits with committed hash and counted query budget | `splits` manifest, query counter on the dashboard | Before the first evaluation run; counter continuous | R4 |
| **Control** | Promotion gate: paired significance test **and** green negative battery | Lineage record with Δ, interval, n, split hash | At every generation promotion | R4 (holds **veto**, independently of R3) |
| **Control** | Defect register with a regression test per fixed defect | Defect table: id, severity, date, fix, regression test | Continuous | R4 |
| **Control** | Divergence and decision-record audit against the sealed baseline | Change log with superseding references | Before every submission | R2 |
| **Control** | Metered pilot converting asserted non-functional figures to measured ones | Pilot report with real cost, latency and dates | Once, at M5 | R4 |

## 10.3 Product quality model

The non-functional requirements are not invented and then justified; they are **derived from the nine characteristics** of the current product quality model — functional suitability, performance efficiency, compatibility, interaction capability, reliability, security, maintainability, flexibility and safety (ISO/IEC 2023). Table 12 shows the mapping requirement by requirement. Two consequences of using the 2023 edition rather than its predecessor are worth naming, because they are where marks are usually left on the table: **accessibility acquires a formal home** as the *inclusivity* sub-characteristic of interaction capability, and **safety becomes a first-class characteristic** under which non-bypassable human approval and fail-closed abort are classified rather than described as good practice.

## 10.4 The evaluation firewall as the quality control mechanism

This is the quality mechanism the project is built around, so it is specified rather than named. The reason a gated improvement loop is not optional is documented rather than assumed: the published study of emergent risks in self-evolving agents reports self-evolution degrading its own safety — a 45% drop in refusal rate for a coding agent built on Qwen3-Coder-480B, and, on top-tier models, over 76% of self-generated tools carrying vulnerabilities and roughly 93% acceptance of malicious external tools (Shao *et al.* 2026, p. 3). LedgerDesk's evolvable layer is far narrower than those systems', and the firewall below is what keeps its improvement loop from grading its own homework.

| Control | What it does | How it is verified |
|---|---|---|
| Three-way partition | Splits the evaluation corpus into `selection`, `report` and out-of-distribution probes | Manifest committed by hash before generation 2 exists |
| Sealing | Commits partition membership by hash, with the partition salt withheld until close | Seal test: replacing the manifest, not merely editing it, is detected |
| Out-of-process guard | Holds the reserved split outside the process being evaluated, with its own database schema and grants | Isolation tests; the residual (shared operating-system principal) is declared, not hidden |
| Query budget | Caps and counts the evaluations charged against the reporting split for the whole project | Counter rendered on the Model Quality screen; budget recomputed from the chained ledger so it survives restarts |
| Append-only ledger with a hash chain | Makes truncation detectable and every published figure reconstructable | Chain-verification test; truncation flips it to false |
| Negative battery | A suite designed to **fail if the mechanism is broken**, rather than to pass if it works: null-operator false-positive rate, no-leak world, non-regression per generation, anti-leak of the reporting split, and a domain-specific prompt-injection family | Battery version, round and date recorded; acceptance is recorded as "passes the battery in force", with its date and round number |
| Promotion gate | Adopts a new generation only if it wins a paired test on the selection split **and** the battery is green | Lineage record; failing either, the previous generation stands |

**The honest scope sentence, used verbatim wherever this claim appears:** *the firewall prevents accidental violation and detects deliberate violation; it is not a security boundary against an in-process adversary.* The declared threat model is a non-adversarial but optimising improvement loop, plus a practitioner with an incentive to report a good result. Every known attack route is closed by a control with a failing test; the routes that remain open are enumerated as declared limitations, not hidden.

## 10.5 Metrics and how a null result is handled

Quality is reported on four axes: **correctness** (accuracy and escalation recall on the sealed reporting split, always with n and an interval), **efficiency** (p95 latency, cost per ticket), **safety** (zero unapproved sends, 100% escalation on the injection corpus, zero personal-information egress), and **maintainability** (one integration test per story, zero merges without a decision record).

**A null result is a deliverable, not a failure.** If no prompt generation improves significantly, the project publishes the **minimum detectable effect** given the sample size instead of a change, and the demonstration shows the mechanism working correctly on a flat curve. This is pre-committed here, in the proposal, precisely so that it cannot later look like an excuse: an evaluation design that can only report success is not an evaluation design.

## 10.6 Why the ledger records the input path

The ledger's unusual field — the path of the input consumed by each decision — is not a design flourish. It exists because of a measurement failure **in my own prior research work**, before this project began. A computation was reviewed and its input directory was not where the script expected it; the reasonable conclusion, and the one initially drawn, was that the measurement was irreproducible. It was not: the data existed in a different directory tree, and the two copies of the script were byte-identical. There was no data loss. There was a **placement** problem, and nothing on record connected the computation to the location of its input.

The lesson generalises in one line: *"it is not in this folder" is not the same as "it does not exist."* A record that captures seed, split, hash **and input path** would have made the wrong conclusion impossible, because the record itself would have said where to look. That is the requirement the product inherits, and it is why LedgerDesk logs the input to every automated decision and not only its output.

## 10.7 Declared degradation ladder

The order in which scope is conceded is written in advance rather than decided under pressure:

1. **Could** items are dropped first (CSV export, per-team cost panel).
2. **Should** items degrade in scope but not in kind — for example, two prompt generations compared instead of a full curve.
3. The **Must** slice is never reduced below end-to-end demonstrability.
4. **The ledger and the negative tests are never conceded, under any circumstance.** They are the evidence base for every quality claim the project makes; conceding them would leave the claims standing without the mechanism that justifies them.

Any concession is recorded as a dated decision record on the day it is made — which is also what neutralises the penalty for undocumented divergence from the baseline.

---

# 11. Team structure, roles and responsibilities matrix

## 11.1 The delivery model

This project is delivered under a **single-executor delivery model with functional role separation**. Six named roles are defined, each with a responsibility set, decision rights and a hand-off artefact. All six are held by one practitioner. **Separation is enforced by artefact, not by headcount.**

This is stated as a delivery model rather than as an exception, and the reason is that it is verifiable. What makes the separation real rather than cosmetic is that each role's output is a dated, version-controlled artefact that the next role's gate depends on: the Quality and Evaluation Engineer's promotion veto is exercised against a split manifest sealed by hash **before** the evaluation ran, with continuous integration as the mechanical gate and dated decision records as the audit trail. One practitioner holds all six roles and has filesystem access to everything; the control is therefore **evidential — seals, timestamps, CI gates and decision records — not physical.** That distinction is stated plainly rather than glossed over, because a control described more strongly than it is implemented is worse than a weaker control described accurately.

The model also has a genuine assessment advantage that is worth naming once: in a single-executor delivery, **100% of the evidence is attributable**, and the distinction of individual work is satisfied by construction rather than by argument.

## 11.2 Organisation chart

**Figure 2 — Functional organisation**

```
        +-------------------------------------------+
        |  PROJECT FACILITATOR / UNIT COORDINATOR   |
        |  academic sponsor · approval, mentoring   |
        +---------------------+---------------------+
                              | approval · weekly 15-minute review
        +---------------------+---------------------+
        |  R1 · PROJECT MANAGER / BUSINESS ANALYST  |
        |  decision right: scope and dates          |
        +---------------------+---------------------+
                              |
        +---------------+-----+---------+---------------+
        |               |               |               |
+-------+--------+ +----+-----------+   |   +-----------+----------+
| R2 · SOLUTION  | | R3 · SOFTWARE  |   |   | R6 · UX &            |
|      ARCHITECT |>|     DEVELOPER  |   |   |  ACCESSIBILITY LEAD  |
| decision right:| | decision right:|   |   | decision right:      |
| structural     | | implementation |   |   | interface acceptance |
| technical      | |                |   |   |                      |
+----------------+ +----+-----------+   |   +----------------------+
                        | build output  |
        +---------------+------+  +-----+-----------------+
        | R4 · QUALITY &       |  | R5 · SECURITY,        |
        |  EVALUATION ENGINEER |  |  PRIVACY & ETHICS     |
        | decision right:      |  |  OFFICER              |
        | PROMOTION VETO       |  | decision right:       |
        | (independent of R3)  |  | flow-release veto     |
        +----------------------+  +-----------------------+

  Reporting line: all six roles report to R1 on scope and dates.
  Gate line (R3 > R4, R3 > R5): the building role hands over an artefact and
  the certifying role accepts it or vetoes it. R4 and R5 exercise their vetoes
  independently of R3; the hand-off artefacts in Table 17 are what evidence
  that independence.
```

## 11.3 Role definitions

**Table 17 — Functional roles.** Competency codes are those of SFIA version 9 (The SFIA Foundation 2024).

| Role | Responsibilities | Deliverables owned | Decision right | Hand-off artefact that proves the separation | SFIA competency |
|---|---|---|---|---|---|
| **R1 · Project Manager / Business Analyst** | Business case, baseline, schedule, board, minutes, risk register, stakeholder analysis, requirements | This proposal, schedule, risk register, weekly status, progress reports | **Scope and dates** | Sealed `baseline-v1.0` tag; weekly status record | REQM, PROG (planning), CFMG |
| **R2 · Solution Architect** | Domain model, state machine, architecture, decision records, algorithm specification | Decision records, entity model, state machine, algorithm spec | **Structural technical decisions** | Dated decision record with the discarded alternative stated | SWDN, DTAN, DBDS |
| **R3 · Software Developer** | Application, prompt roles, gateway, improvement engine | Source code, migrations, seed data | **Implementation** | Commit referencing a board item; green pipeline | PROG, SINT, CFMG |
| **R4 · Quality & Evaluation Engineer** | Test suite, sealed splits, firewall, negative battery, performance and cost harness | Story–test report, split manifest, evaluation reports, pilot report | **Promotion veto — exercised independently of R3** | Split manifest sealed by hash **before** the run it certifies | TEST, RSCH |
| **R5 · Security, Privacy & Ethics Officer** | Threat model, row-level security, redaction, dependency and secret audits, ethical register | Threat table with tests, security reports, ethics section | **Flow-release veto** | Threat row with a named passing test | SCTY, AIDE |
| **R6 · UX & Accessibility Lead** | Heuristic walkthrough, participant evaluation, WCAG 2.2 AA verification | Evaluation findings → decision records, accessibility report | **Interface acceptance** | Findings traced into a dated decision record | USEV, HSIN |

## 11.4 Responsibility assignment matrix

**Table 18 — RACI by work package** (R = responsible · A = accountable · C = consulted · I = informed)

| WBS | Work package | R1 | R2 | R3 | R4 | R5 | R6 |
|---|---|---|---|---|---|---|---|
| 1.1 | Baseline and schedule | **A/R** | C | I | I | I | I |
| 1.2 | Tracking and reporting | **A/R** | I | I | I | I | I |
| 1.3 | Risk, change, configuration | **A** | **R** | C | C | C | I |
| 2.1 | Stakeholder analysis | **A/R** | C | I | I | C | C |
| 2.2 | Requirements specification | **A/R** | C | C | C | C | C |
| 2.3 | User stories | **A/R** | C | C | **R** | I | C |
| 2.4 | Domain model | C | **A/R** | C | I | C | I |
| 2.5 | Architecture | C | **A/R** | C | C | C | I |
| 2.6 | Best-practice review | **A/R** | C | I | C | C | I |
| 3.1 | Platform skeleton | I | **A** | **R** | I | **C** | I |
| 3.2 | Customer portal | I | C | **A/R** | I | C | **C** |
| 3.3 | Agent console | I | C | **A/R** | I | I | **C** |
| 3.4 | Supervisor dashboard | C | C | **A/R** | **C** | I | C |
| 3.5 | Data seeding | I | C | **A/R** | C | **C** | I |
| 4.1 | Model gateway | I | C | **R** | I | **A** | I |
| 4.2 | Prompt roles | I | C | **A/R** | C | C | I |
| 4.3 | Deterministic algorithms | I | **A/R** | C | **C** | I | I |
| 4.4 | Decision ledger | I | C | **R** | **A** | C | I |
| 4.5 | Evaluation firewall | I | C | I | **A/R** | C | I |
| 4.6 | Improvement engine | I | C | **R** | **A** | C | I |
| 5.1 | Test suite | I | I | C | **A/R** | C | I |
| 5.2 | Non-functional harness | C | I | C | **A/R** | I | I |
| 5.3 | Accessibility | I | I | C | C | I | **A/R** |
| 5.4 | Security and privacy | I | C | C | C | **A/R** | I |
| 5.5 | UX evaluation | I | I | C | I | I | **A/R** |
| 5.6 | Packaging | C | C | **A/R** | C | C | C |
| 5.7 | Demonstration and reporting | **A/R** | C | C | C | C | C |

**Two structural properties of this matrix are deliberate.** First, **R4 is accountable for the ledger, the firewall and the improvement engine while R3 is responsible for building them** — the builder cannot certify their own work. Second, **R5 is accountable for the model gateway** even though R3 writes it, because the gateway is where the privacy guarantee lives and it should be owned by the role whose veto protects it.

## 11.5 Managing the model's principal risk

The single-executor model concentrates review in one person. That is risk R-07, and it is managed by four named controls rather than by good intentions: (1) **continuous integration as a mechanical reviewer** that cannot be persuaded; (2) a **cross-role checklist** signed and dated before every gate, in which the reviewing role signs against the artefact rather than against a memory; (3) the **weekly 15-minute mentor meeting** as scheduled external review, with minutes and at least one action item carrying an owner and a date, closed by a commit; and (4) **artefact ordering** — seals created before the runs they certify, so that the sequence itself is evidence.

## 11.6 Professional conduct and collaboration readiness

This project is run so that collaboration remains possible at any point, and the single-executor arrangement is a delivery model adopted for this term rather than a working preference. Concretely: **every artefact is committed to a shared repository holding the full change history from M1 · 17 Aug 2026** — owner R1, work packages 1.1 and 1.3 — so that from that date a second contributor could be onboarded without a handover meeting. That repository is a dated commitment on exactly the same footing as the commitments listed in Section 4.6, not evidence that exists on the date of this proposal, and it is written that way here for the same reason it is written that way there: it becomes evidence at the first Progress Report, and until then it is a promise with an owner and a date. Alongside it, work items are on a public board with acceptance criteria written before implementation; decision records state the discarded alternative, so that a newcomer can see *why* and not only *what*; and the practitioner attends the weekly mentor session, responds to feedback in writing, and will integrate into a group if the facilitator forms one — in which case the role matrix in Table 17 maps directly onto people, since it was written as a role structure rather than as a description of one person. A handover pack — README, migrations, seed, environment lockfile, and a five-command install — is a deliverable of work package 5.6 for exactly this reason.

---

# 12. Task leads for major deliverables

**Table 19 — Task leads**

| # | Major deliverable | Task lead | Supporting roles | Target date | Acceptance evidence |
|---|---|---|---|---|---|
| D-1 | Project Proposal (this document) and Learning Plan | **R1** — Project Manager / Business Analyst | R2, R4 | 15 Aug 2026 | Submitted; sealed as `baseline-v1.0` on approval |
| D-2 | Progress Report 1 | **R1** | all | 17 Aug 2026 | Uploaded before the deadline |
| D-3 | Domain model, state machine and architecture decision records | **R2** — Solution Architect | R3, R4 | 23 Aug 2026 | Entity model, state machine and decision records committed with dates |
| D-4 | Deterministic priority and escalation algorithms | **R2** | R4 | 30 Aug 2026 | Named edge-case tests green, enumerated in the algorithm specification; weight-sensitivity table published |
| D-5 | Decision ledger with hash chain | **R4** — Quality & Evaluation Engineer | R3 | 30 Aug 2026 | Append-only and truncation-detection tests green **before** any prompt role writes a row |
| D-6 | Model gateway with redaction and canary | **R5** — Security, Privacy & Ethics Officer | R3 | 30 Aug 2026 | Redaction test with a network fake; no-direct-SDK-import test green |
| D-7 | End-to-end vertical slice | **R3** — Software Developer | R2, R6 | 30 Aug 2026 | Slice runs end to end on the local machine; rehearsal recorded |
| D-8 | Week 7 prototype demonstration | **R1** (presenting) with **R3** (system) | R4, R6 | Week of 31 Aug – 4 Sep 2026 | Demonstration delivered; `demo-w7` tag created before presenting; dated screenshots archived |
| D-9 | Sealed splits, firewall and Model Quality surface | **R4** | R3 | 14 Sep 2026 | Split manifest sealed by hash; accuracy rendered with n, interval and hash |
| D-10 | Metered pilot and Progress Report 2 | **R4** (pilot) · **R1** (report) | R3 | 14 Sep 2026 | Pilot report with real cost and latency; report uploaded |
| D-11 | Improvement engine, promotion gate and negative battery | **R4** | R3 | 4 Oct 2026 | Lineage record with Δ, interval and n; battery green with round and date |
| D-12 | Security threat model and privacy controls | **R5** | R3 | 4 Oct 2026 | One passing test per threat row; injection corpus green in CI |
| D-13 | Accessibility and user-experience evaluation | **R6** — UX & Accessibility Lead | R3 | 4 Oct 2026 | CI accessibility report plus manual verification; participant findings traced to decision records |
| D-14 | Integration test suite and traceability matrix | **R4** | R3 | Continuous; complete at 4 Oct 2026 | One documented integration test per implemented story, generated report, generated matrix |
| D-15 | Packaged, reproducible application | **R3** | R4 | 4 Oct 2026 | Timed install from a clean clone in ≤ 5 commands; offline replay verified |
| D-16 | Final project report | **R1** | all | 12 Oct 2026 | Uploaded with a link to the repository containing the full change history |
| D-17 | Final presentation with live demonstration | **R1** (presenting) with **R3** (system) | R4 | 12–13 Oct 2026 | Presentation file, working application and repository link submitted |

**Note on task leads under this delivery model.** Each deliverable above is led by a named functional role with a defined decision right and a hand-off artefact, and the lead role is the one whose veto or acceptance gates that deliverable. All roles are held by Fabián Andrés Roberto Guzmán.

---

# 13. Required tools and resources

## 13.1 Development stack

| Layer | Technology | Rationale | Discarded alternative and why |
|---|---|---|---|
| Application framework | **Next.js 16 + TypeScript + Tailwind CSS** (App Router, Server Actions) | One deployment, one authentication configuration, server-side mutations with role re-checks | A separate single-page app plus API: two deployments, two auth configurations, more failure surface during a live demonstration |
| Data platform | **Supabase / PostgreSQL** — tickets, roles, knowledge base, ledger, splits | Declarative **row-level security** per role and tenant; full-text search; a single store for both the application and the evidence | SQLite (no row-level security); a document store (no SQL, no declarative row-level security, no full-text indexing) |
| Retrieval | PostgreSQL full-text search as the deterministic primary; vector search as a *Should* layer with cached embeddings | Determinism on the demonstration path | Pure vector search: a second provider and non-determinism where it hurts most |
| Model access | **Commercial LLM API** — a low-cost model for high-volume triage, a stronger model for drafting; **frozen weights** | No training infrastructure, no GPU line item, per-role cost contrast measurable | Fine-tuning: cost, MLOps burden, and irreproducibility in a demonstration |
| Statistics | Python 3.12 as a sidecar emitting JSON | Paired tests and intervals in a mature library | Reimplementing statistics in TypeScript: more code, less trust |

## 13.2 Quality and process toolchain

| Purpose | Tool | Evidence it produces |
|---|---|---|
| Source control | Git with a remote repository, containing the **history of all changes** | Dated commit history; tags `baseline-v1.0`, `demo-w7`, freeze tag |
| Continuous integration | Pipeline on every push: build, unit and integration tests, module-boundary check, dependency audit, secret scanning, accessibility checks | Green or red pipeline; generated story–test report and traceability matrix |
| Accessibility testing | Automated accessibility engine in CI on three flows, plus manual keyboard, focus and contrast verification | Accessibility report artefact |
| Security | Dependency audit, secret scanning, prompt-injection corpus in CI. Agent-level threats are enumerated against the agentic-application risk catalogue (OWASP Foundation 2025); model-level risks are reviewed against the current edition of the language-model risk list (OWASP Foundation 2026), **cited for scope only — no individual item identifier is quoted, as the 2026 item list has not been verified against the published source** | Threat table with a named passing test per row |
| Project tracking | Board with columns and visible weekly flow | Weekly board snapshot; every commit references a board item |
| Meeting records | The unit's official minutes template (date, opening time, chair, attendees, topics, action items, closing time) | Minutes filed within 24 hours, with at least one action item closed by a commit |
| Documentation | Markdown in-repository, exported for submission; append-only decision-record and defect logs | Decision records, defect register, divergence log |

## 13.3 Human and institutional resources

| Resource | Availability | Purpose |
|---|---|---|
| One practitioner, six functional roles | Full term | Delivery (Section 11) |
| Project facilitator / Unit Coordinator | Weekly 15-minute mentor meeting | Approval, external review, escalation of open questions |
| User-experience evaluation participants | 3–5 people, one session each; recruited from fellow students and professional contacts, unpaid and voluntary (see the note below) | NFR-Q10; findings traced to decision records |
| Personal computer for development and demonstration | Full term | The demonstration must run on a laboratory, personal or mobile device (C-07) |

**Where the evaluation participants come from, and on what basis they take part.** The three to five participants required by **NFR-Q10** are recruited from fellow students on this programme and from professional contacts. They are not customers or employees of the case organisation, because MidCo is hypothetical and has none. Participation is voluntary and unpaid, and a decision not to take part carries no consequence of any kind. Each session opens with a stated purpose, an explicit statement that **the system is being evaluated and the participant is not**, and the participant's verbal consent to proceed and to have their observations written into the evaluation record — recorded in the dated session note before the session begins. No personal information is collected beyond a participant code; sessions are not recorded in audio or video; the prototype holds only synthetic data (C-04), so nothing a participant does exposes anyone's information; and findings are reported by code in the evaluation report and in any decision record they produce. On that basis the sessions are usability evaluation of a synthetic-data prototype rather than human-subject research, and are treated as such; if the facilitator reads the requirement differently, the sessions are held only after that direction is given in writing. The heuristic walkthrough of 5.5.1 proceeds either way, and any shortfall against the three-participant threshold of NFR-Q10 is recorded as a dated divergence with its decision record rather than absorbed silently.

## 13.4 Budget — declared as a constraint, not as an estimate

**Table 20 — Resource budget**

| Item | Amount | Nature |
|---|---|---|
| **Model API spend, whole term** | **A$120 hard cap, automatic cut-off at A$100** | **Constraint (C-02)** — enforced by a circuit breaker with a test, not by monitoring |
| Target unit cost | **≤ A$0.04 per processed ticket** (NFR-Q05) | Requirement — *asserted*, to be confirmed by the metered pilot at M5 |
| Platform services (database, authentication, hosting) | Free tier | Assumption A-06 |
| Continuous integration minutes | Free tier | Assumption A-06 |
| Compute for training | **A$0 — none required** | Consequence of the frozen-weights decision |

**Explicitly out of scope, and declared as such:** any extended statistical campaign over many evolution generations, whose cost would run to orders of magnitude above the term budget. That work is excluded by design rather than deferred silently, and the ceiling is declared here so that it governs the plan from the start rather than being discovered at the end of the term.

---

# 14. Declarations

## 14.1 Individual contribution declaration

This project is delivered under a single-executor delivery model. **All work described in this proposal — business analysis, requirements, architecture, implementation, quality engineering, security and privacy design, user-experience evaluation, documentation, demonstration and reporting — is contributed by Fabián Andrés Roberto Guzmán: 100%.** No other student has contributed to, or will contribute to, any deliverable of this project unless the facilitator forms a group, in which case this declaration will be reissued with the revised allocation before the next submission.

Signed: **Fabián Andrés Roberto Guzmán** — 19 August 2026.

## 14.2 Ethics, privacy and professional responsibility

The project handles **no real personal information**. The evaluation corpus is 100% synthetic and generated from deterministic templates (AS-10, C-04). Where the architecture nevertheless touches personal-information handling patterns, the controls are mapped to the specific obligations they address under the *Privacy Act 1988* (Cth) and its Australian Privacy Principles — in particular **APP 8** (cross-border disclosure), which is why every outbound call passes through a single redaction chokepoint with a planted canary token before reaching an overseas model provider, and **APP 11** (security of personal information), which is why row-level security, append-only audit logging and an executable retention-and-purge job are requirements (FR-A14, NFR-Q13, NFR-Q14) rather than aspirations.

Three further positions are stated rather than assumed. **The customer is always told an AI is assisting** and can always reach a human (FR-A13). **The system makes no automated decision about a person**: it classifies and drafts, and a human approves every customer-facing action, enforced at the database (FR-A09, NFR-Q23). And **the classifier is audited for disparate impact** across cohorts, with the result reported as an interval rather than a point estimate (NFR-Q26). The open limit is declared with the same directness: the model provider receives whatever the scaffolding sends it, and this is stated as an unresolved boundary of the prototype rather than presented as controlled.

---

# 15. Approval request and open questions

Approval is requested for: (a) the project as **listed project #4, modified** as described in Section 4.5; and (b) the **single-executor delivery model** described in Section 11.

The following questions affect the shape of the work and are submitted for the facilitator's guidance. None of them blocks the plan — each has a default position that the project will follow unless directed otherwise.

| # | Question | Default position if unanswered |
|---|---|---|
| Q-1 | Is the single-executor delivery model approved, or should the project be integrated into a group? | Proceed as described in Section 11; the role matrix maps onto people without redesign if a group is formed |
| Q-2 | Is the modification of listed project #4 (Section 4.5) approved? | Proceed and describe the project as "listed project #4, modified" in all subsequent documents |
| Q-3 | Is there a required length or template for this proposal? | Present the twelve components in full, with no assessable content in appendices |
| Q-4 | What is the exact date and time of the Week 7 demonstration class? | Plan against the earliest possible session; a later confirmed date can only bring work forward |
| Q-5 | What is the allocated time limit for the final presentation? | Prepare a modular script that can be delivered in 5 to 20 minutes without restructuring |
| Q-6 | Which record constitutes the official attendance and weekly-update channel? | Submit weekly status through the formal channel *and* record it in the repository |

---

# 16. References

Blum, A. and Hardt, M. (2015) 'The Ladder: a reliable leaderboard for machine learning competitions', *Proceedings of the 32nd International Conference on Machine Learning*, PMLR 37:1006–1014. Available at: https://proceedings.mlr.press/v37/blum15.html [Accessed 19 August 2026].

Cemri, M. et al. (2025) 'Why do multi-agent LLM systems fail?', *Advances in Neural Information Processing Systems 38 (NeurIPS 2025), Track on Datasets and Benchmarks*. Available at: https://github.com/multi-agent-systems-failure-taxonomy/MAST [Accessed 15 August 2026].

Dwork, C., Feldman, V., Hardt, M., Pitassi, T., Reingold, O. and Roth, A. (2015) 'Generalization in adaptive data analysis and holdout reuse', *Advances in Neural Information Processing Systems 28 (NIPS 2015)*, Montreal, Canada.

Erol, M.H., El, B., Suzgun, M., Yüksekgönül, M. and Zou, J. (2026) 'Cost-of-Pass: an economic framework for evaluating language models', *International Conference on Learning Representations (ICLR 2026)*.

IEEE Computer Society (2024) *SWEBOK Guide to the Software Engineering Body of Knowledge, Version 4.0*. IEEE Computer Society. Published 15 October 2024.

International Organization for Standardization and International Electrotechnical Commission (2023) *ISO/IEC 25010:2023 Systems and software engineering — Systems and software Quality Requirements and Evaluation (SQuaRE) — Product quality model*. 2nd edn. Geneva: ISO. (Cancels and replaces ISO/IEC 25010:2011.)

International Organization for Standardization and International Electrotechnical Commission (2025) *ISO/IEC 40500:2025 Information technology — W3C Web Content Accessibility Guidelines (WCAG) 2.2*. Geneva: ISO. (Adopted 21 October 2025.)

OWASP Foundation (2025) *OWASP Top 10 for Agentic Applications 2026*. Open Worldwide Application Security Project. Published 9 December 2025.

OWASP Foundation (2026) *OWASP Top 10 for Large Language Model Applications, 2026 edition*. Open Worldwide Application Security Project. Published 4 August 2026. (Cited for scope only; no individual item identifier is quoted, as the 2026 item list has not yet been verified against the published source.)

*Privacy Act 1988* (Cth), Schedule 1 — Australian Privacy Principles. Canberra: Commonwealth of Australia.

Roelofs, R. et al. (2019) 'A meta-analysis of overfitting in machine learning', *Advances in Neural Information Processing Systems 32*, Vancouver, Canada.

The SFIA Foundation (2024) *SFIA 9: the global skills and competency framework for the digital world*. Version 9, October 2024. The SFIA Foundation. Available at: https://sfia-online.org/en/sfia-9 [Accessed 19 August 2026].

Shao, S. et al. (2026) 'Your agent may misevolve: emergent risks in self-evolving LLM agents', *Proceedings of the 14th International Conference on Learning Representations (ICLR 2026)*, poster, arXiv:2509.26354.

World Wide Web Consortium (2024) *Web Content Accessibility Guidelines (WCAG) 2.2*. W3C Recommendation, 12 December 2024. Campbell, A., Adams, C., Bradley Montgomery, R., Cooper, M. and Kirkpatrick, A. (eds). World Wide Web Consortium. (Adopted as ISO/IEC 40500:2025.) Available at: https://www.w3.org/TR/2024/REC-WCAG22-20241212/ [Accessed 19 August 2026].

Yao, S., Shinn, N., Razavi, P. and Narasimhan, K. (2025) 'τ-bench: a benchmark for tool-agent-user interaction in real-world domains', *Proceedings of the 13th International Conference on Learning Representations (ICLR 2025)*. Available at: https://github.com/sierra-research/tau-bench [Accessed 15 August 2026].

Zela, A., Elsken, T., Saikia, T., Marrakchi, Y., Brox, T. and Hutter, F. (2020) 'Understanding and robustifying differentiable architecture search', *International Conference on Learning Representations (ICLR 2020)*, arXiv:1909.09656. Available at: https://arxiv.org/abs/1909.09656 [Accessed 19 August 2026].

Zhang, J. et al. (2026) 'Darwin Gödel Machine: open-ended evolution of self-improving agents', *International Conference on Learning Representations (ICLR 2026)*, poster. Available at: https://openreview.net/forum?id=pUpzQZTvGY [Accessed 19 August 2026].

Zhu, Y. et al. (2025) 'Establishing best practices in building rigorous agentic benchmarks', *Advances in Neural Information Processing Systems 38 (NeurIPS 2025), Datasets and Benchmarks Track*. Available at: https://proceedings.neurips.cc/paper_files/paper/2025/hash/f316275b44ee2de533102913828a8107-Abstract-Datasets_and_Benchmarks_Track.html [Accessed 15 August 2026].
