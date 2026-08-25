# ADR-028 · A reopened ticket keeps its spent retries, and the way back is a person rather than a reset

**Status:** accepted · **Decision date:** 2026-08-25

**On the number.** 027 was the last index taken in this directory. This takes **028**. An unqualified `ADR-NNN` always means the file of that name in `adr/`.

## Context

Two published contracts meet and produce a behaviour nobody wrote on purpose.

The clause that escalates a ticket whose retry budget is spent is evaluated at the **record** stage of the algorithm — before any model is asked anything, because the criterion the precedence was signed under is to escalate at the earliest point that does not require asking a model. And the guard on reopening a ticket **preserves the retry counter**: the SLA clock restarts, the retries do not.

Composed, they mean that a ticket which exhausted its retries and is then reopened **escalates for ever without the model being called again**.

This looked, at first reading, like a defect to correct by making a reopen reset the counter — "which is what the word reopen means". Three things were then measured and none of them survives that reading.

**The preservation is signed twice.** The state-machine table and the edge-case table both state it — *`retries` preserved* — and both name the same test, which exists and asserts it in those terms: a reopen does not hand back a spent retry budget. Resetting would require amending frozen core in two places under its supersession discipline and rewriting a test written to pin exactly this.

**Nothing can execute the transition today.** The edge `CLOSED → REOPENED` is published in the machine with the named guard `reopen-window`, and that guard has no implementation: the console writes state without assignment and refuses that guard, and the one vehicle that could assign rejects `reopen-window` before it looks at anything else. A reset is therefore not a change to behaviour that exists; it is a change to behaviour that would have to be built first.

**And it inverts the failure mode.** Today the system fails **closed**: the budget runs out, a human is handed the ticket, and nothing further is spent. With an automatic reset it fails **open** — a ticket whose body breaks the envelope, reopened in a loop, is a full retry budget of paid calls **per reopen**, with nobody in the loop. A system whose entire claim is that no money moves and no reply ships without a person would have acquired a spending channel with no person in it.

## Decision

**The composition is intentional and stays. A reopened ticket keeps the retries it spent.**

The path for a ticket whose budget is exhausted is **a human**: it escalates, and a supervisor resolves it from the console. That is the same shape every other escalation edge has, and it is what the retry budget is for — a breaker whose open state means *stop calling*, not *call more carefully*.

**The door is sealed rather than left ajar.** The retry counter is an assignable column, so a future increment could write it. This decision reserves that lever: **writing it requires its own dated decision**, and this file is the thing that decision would supersede.

**And the legitimate half of the rejected option is named here as the extension it should be.** What is right about "a reopened ticket deserves a fresh attempt" is that *sometimes it does* — and the system already knows how to express that: **a person decides, with their name on it, and the chain records it.** The shape, if the reopening increment is ever built, is an explicit staff action that grants a new budget, written to the chain like any other human decision. Not an automatic reset; a half-open breaker operated by somebody who can be asked why.

## Consequences

**No code changes and no test changes.** This decision is a statement about what the tree already does, which is why it can be taken at all this close to a demonstration.

**The adversarial question becomes an answer.** *"What happens when a customer replies to a ticket that already burned its retries?"* is a question the system has a dated position on, rather than a behaviour discovered live.

**What is not bounded, and is not bounded by this.** The load on the human is limited only by how often a ticket can be reopened, which the `reopen-window` guard names and does not define. That window has no value in any document, and this decision does not invent one: it is a parameter of the increment that implements reopening, and specifying it now would be specifying a parameter of code nobody has written. **The honest statement is that the guard is declared and not implemented, not that it is unbounded** — the second would claim the feature exists.

**One thing would reopen this decision, and it is named so it is not missed.** The argument that re-calling is re-asking the same question holds because a reopened ticket carries the same body. If a future increment folds the customer's reply into the ticket as new content, the question is no longer the same one and the reasoning above weakens. That is the trigger for revisiting this, by the reserved lever above.
