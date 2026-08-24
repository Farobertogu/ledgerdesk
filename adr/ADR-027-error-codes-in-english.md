# ADR-027 · Every error code the system raises is spelled in English, and the claim that nothing else changed is checked rather than asserted

**Status:** accepted · **Decision date:** 2026-08-25

**On the number.** 026 was the last index taken in this directory. This takes **027**. As ADR-026 established, an unqualified `ADR-NNN` always means the file of that name in `adr/`.

## Context

Thirty-eight of the error codes this system raises were spelled in Spanish. They were not spelled that way for a reason anybody had argued: the design documents this project is specified from are written in Spanish, the codes were coined while writing them, and the repository cited them as though they were quotations from a source it did not own.

That framing was checked and it does not hold. The published specification names twenty-six codes; **three** of the thirty-eight are among them. The remaining thirty-five were coined in this repository, in Spanish, by the same hands that then treated their spelling as fixed. Thirteen further Spanish codes the specification names have never existed here at all — they belong to increments not yet built — so they are unaffected by anything decided here.

The repository is English throughout: documentation, code, comments, commit messages, branch names, tests. A reader meets a Spanish symbol only when something is refused, and the surface that reports a refusal prints the code itself, so the one moment a code is read by a person is the one moment the inconsistency shows.

**The reason this was not done earlier was cost, and cost was mistaken for principle.** Renaming a code raised inside a function requires replacing that function, because migrations are forward-only and an applied file is not edited. That is a real constraint on *how*, and it was allowed to argue *whether*.

## Decision

**Every error code is spelled in English. There is no exempt name.**

The nine functions that raise a renamed code are replaced in this migration with `create or replace`, and **never with `drop` followed by `create`**. The distinction is not stylistic: `create or replace` preserves the access control list, while `drop` returns a function to the language default, which grants `EXECUTE` to `PUBLIC` — the precise hole that migration 0010 closed for every callable privileged function in this schema. Four of the nine are trigger functions with triggers attached, where dropping would also destroy the triggers.

**Nothing else changes.** No table, column, index, policy, trigger, constraint, type or privilege.

### The claim is checked, and that is the substance of this decision

"Only the identifiers changed" is the kind of claim that is easy to make and expensive to be wrong about, because the functions being rewritten include the ones that carry this schema's tenant isolation. Asserting it would have been worthless. It is established instead by a property that can be recomputed by anybody:

**The regenerated schema is byte-identical to the previous schema with the identifiers substituted.**

That check is stronger than reading a diff, and it is stronger for a reason worth stating: the schema dump carries the *full text of every function body*, comments included, as the database stores it. Proving the dump is a pure substitution therefore proves the bodies are — measured through the database rather than through the file that was typed. Anything else that had moved, anywhere in the schema, would break the equality.

The same property was applied file by file across the change: with every code token masked, the modified files are byte-identical to their previous versions. Two are not, and both are prose that had to change because it described the exemption this decision removes.

## Consequences

**The published specification's code index diverges for three entries until it is superseded.** The specification is a project document with its own dated-amendment discipline; it is amended, not silently followed. Three entries is the whole of the divergence, and no other repository reference to a renamed code survives.

**Rows already written keep the spelling they were written with.** The ledger and the audit trail are append-only by design and nothing rewrites a row — that property is worth more than orthographic consistency in historical data. A demonstration corpus is rebuilt from empty rather than migrated, so no reader meets a mixed spelling in a live system.

**A comment that referenced its own file by section number had to be corrected, and the correction generalises.** The paragraph explaining why the closure ties the caller's organisation pointed at "§2 of this file" — true where it was written, false once the function moved here, and it travels into the database and out into the schema dump. It now names the function instead. **A cross-reference by position is true only in the file it was written in; one by name survives the move.** Nothing else in this migration references a position.

**Two privileged functions ship here without a revocation, and that is unchanged rather than new.** Seven `security definer` definitions are shipped and five are revoked; the two that are not are trigger functions, which are not callable — invoking one directly raises an error — so their `EXECUTE` privilege grants nobody anything. Section 10 of the migration states this and the migrations README states it separately.

**What this does not buy.** A refusal still reaches the screen as a bare code with no sentence beside it. That is a product gap, not a language gap, and it is unchanged by this decision — an English code with no explanation is as opaque to a reader as a Spanish one. Giving each code a human sentence at the surface that reports it is named here as the work this decision leaves undone.
