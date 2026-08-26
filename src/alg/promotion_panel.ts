/**
 * The promotion gate as a screen can state it: the reconciliation of an attempt against its opening,
 * and the view model of the panel that renders one.
 *
 * **Pure, and importing nothing outside `src/alg/`.** That is what lets it be loaded by
 * `node --experimental-strip-types` with no bundler and no `node_modules`, which is what puts its
 * tests in the fastest CI job — the one with no database. The alphabets it needs live in the agent
 * layer, so they are TRANSCRIBED here and compared against their owner by a test, exactly as
 * `RESULT_CHANNEL_MAX_BYTES` is transcribed in `src/alg/channels.ts:67` and compared by
 * `ci/seam_check.mjs:241-250`. A transcription nobody compares is a transcription that drifts.
 *
 * ## What the screen is allowed to say
 *
 * The map's vocabulary rule is binding: no state is described in words outside the alphabet the
 * instrument publishes — `PASS | FAIL | UNEVALUABLE, with its reason`, the six names
 * `failing_conjunct` may carry, the three terminals, the three interpretations. *"Almost green" does
 * not exist.* A cosmetic rename would turn the panel into a translation and stop it being evidence of
 * the row. So the builder below THROWS rather than degrades: a fifth verdict, a seventh failing
 * conjunct, a reason that is missing, a set of conjuncts that is not the four published names — each
 * of them is a refusal to render, never a dash on a screen. The ORDER is re-established at render
 * rather than demanded of the row, and `conjunctsOf` carries the measurement that forces that.
 *
 * ## The division between the screen and the person
 *
 * The screen shows FACTS: the four verdicts with their reasons, the terminal, the named failing
 * conjunct, the reconciliation, and the dated deliverable that will make each unevaluable conjunct
 * evaluable. The presenter says the INTERPRETATION. The signed wording of that spoken line is
 * deliberately **not** in this file and must never be: the demonstration script marks it `[SAY]` and
 * its `[SCREEN]` list does not contain it, so a panel that painted it would duplicate a signed
 * sentence into two artefacts that can then disagree.
 *
 * What the screen DOES carry, and what makes the beat survivable, is `FAIL_CLOSED_STATEMENT`. It
 * answers the one question that can derail the beat — *if nothing has been run, why underpowered?* —
 * and it exists **only inside the `filed` branch**, so it is structurally unreachable from a panel
 * with no row. That is the same discipline the map states for the presenter (GN-12: the P1 wording
 * presumes the row and is illegitimate without it); if the screen could paint it empty, the screen
 * would be committing the offence the rule forbids the presenter.
 *
 * ## Three branches, and why the third one is not a loosening
 *
 * The brief names two: a panel with no attempt, and a panel with one. A third is added for the row
 * that fails verification, because the same brief requires that such a row produce **a named failure
 * and never a checklist** — and the only way to make that structural rather than remembered is for
 * the checklist not to exist on that branch. Folding it into either named branch would leave a
 * checklist reachable from a row whose digest does not match its contents, and a panel that prints
 * `output` without recomputing `row_hash` paints a tampered row exactly as green as a sound one.
 */

/* ------------------------------------------------------------------------------------------------
 * 1 · The transcribed alphabets
 * ---------------------------------------------------------------------------------------------- */

/** Transcribed from `agents/ledger/promotion_row.ts`; compared against it by a test. */
export const CONJUNCT_NAMES = [
  'paired_significant_at_alpha',
  'delta_positive',
  'battery_in_force_green',
  'query_index_within_cmax',
] as const;

/** Transcribed. `02_SPEC.md:1261`: *"each: PASS | FAIL | UNEVALUABLE, with its reason"*. */
export const CONJUNCT_VERDICTS = ['PASS', 'FAIL', 'UNEVALUABLE'] as const;

/** Transcribed. The closed alphabet of `02_SPEC.md:1835`, ∪ `null` under `PROMOTED`. */
export const FAILING_CONJUNCTS = [
  ...CONJUNCT_NAMES,
  'precondition_underpowered',
  'aborted_before_evaluation',
] as const;

/** Transcribed. The three terminals of an attempt. */
export const OUTCOMES = ['PROMOTED', 'REJECTED', 'ABORTED'] as const;

/** Transcribed. Closed, and with no member meaning "not evaluated". */
export const INTERPRETATIONS = ['UNDERPOWERED', 'INFORMATIVE-NULL', 'POWERED-CONCLUSIVE'] as const;

export type ConjunctName = (typeof CONJUNCT_NAMES)[number];
export type ConjunctVerdict = (typeof CONJUNCT_VERDICTS)[number];

/* ------------------------------------------------------------------------------------------------
 * 2 · The dated milestones
 * ---------------------------------------------------------------------------------------------- */

export type Milestone = {
  id: string;
  title: string;
  /** ISO, so `milestoneState` can compare it without parsing prose. */
  date: string;
  /** Exactly as Table 19 of `docs/PROPOSAL.md` prints it; compared byte for byte by a test. */
  published_date: string;
};

/**
 * The two deliverables that make the four conjuncts evaluable, with their dates.
 *
 * Sources, all three read rather than remembered: `docs/PROPOSAL.md` Table 19 rows D-9 and D-11 give
 * the identifier, the title and the date; `docs/LEARNING_PLAN.md:37` writes the same pairing as
 * *"M6 · 4 Oct 2026 (Part A, Table 19, D-11; the sealed-split accuracy surface is rendered earlier,
 * at M5 · 14 Sep, D-9)"*; and the map's rung P2 says which conjuncts each one unlocks.
 *
 * **The clash with `02_SPEC.md:1251` is declared rather than left quiet.** That line says *"pending
 * M6, with a date"*, and M6 is 4 October, which is D-11. The two are the same commitment written in
 * two vocabularies. The panel prints the Table 19 identifiers because they are the ones the reader
 * can look up in the document beside it.
 *
 * **Where the staleness of a date is checked, and why not in the build.** A promise whose date has
 * gone by is the failure worth catching: the panel would keep printing *pending, with a date* for a
 * date already behind it, and the reader would take the promise at face value. The first design
 * asserted freshness in `check`, guarded by a second field — but that field was a literal nothing in
 * the tree produced, so the guard was constant and the rule collapsed to *red on the passing of a
 * date*: `main` is protected by `check`, so on 15 September every merge in this repository would
 * have been blocked by the calendar, with no change of code and nothing a committer could do about
 * it. A gate that fires on something the committer cannot act on is not a gate; it is an outage.
 *
 * So the staleness is **rendered, not enforced**: `milestoneState` reports it and the panel prints
 * it beside the row. The build asserts the properties that are always the code's own — the
 * identifiers are real, the dates parse, the printed form matches the machine form, every
 * unevaluable conjunct names the deliverable that unlocks it. Same discipline the rest of this
 * system uses: the surface declares its own state at the moment somebody reads it, rather than a
 * check remembering on its behalf at a moment nobody chose.
 */
export const PENDING_MILESTONES: readonly Milestone[] = [
  {
    id: 'D-9',
    title: 'Sealed splits, firewall and Model Quality surface',
    date: '2026-09-14',
    published_date: '14 Sep 2026',
  },
  {
    id: 'D-11',
    title: 'Improvement engine, promotion gate and negative battery',
    date: '2026-10-04',
    published_date: '4 Oct 2026',
  },
];

/**
 * Whether a milestone's published date is still ahead of the reader, computed when the panel is
 * read rather than remembered by a build.
 *
 * `now` is a parameter and not a call to the clock, so the value is a function of its inputs and a
 * test can pin every branch without waiting for a calendar. `'due'` is not an error state: it says
 * the published date has gone by, which is a fact the reader is entitled to before deciding what
 * the promise beside it is worth.
 */
export function milestoneState(entry: Milestone, now: Date): 'ahead' | 'due' {
  return entry.date >= now.toISOString().slice(0, 10) ? 'ahead' : 'due';
}

/**
 * Which deliverable makes each conjunct evaluable.
 *
 * The date drops to ROW level for a reason: *"when will this be green?"* is the second safe question
 * an examiner asks, and answered once, aloud, for four rows at a time it is a promise. Answered per
 * row, on the screen, with a dated deliverable, it is a fact the reader can check.
 */
export const CONJUNCT_MILESTONE: Readonly<Record<ConjunctName, string>> = {
  paired_significant_at_alpha: 'D-9',
  delta_positive: 'D-11',
  battery_in_force_green: 'D-11',
  query_index_within_cmax: 'D-9',
};

export function milestone(id: string): Milestone {
  const found = PENDING_MILESTONES.find((entry) => entry.id === id);
  if (!found) throw new Error(`promotion panel: no milestone is published under ${id}`);
  return found;
}

/* ------------------------------------------------------------------------------------------------
 * 3 · The published sentences
 * ---------------------------------------------------------------------------------------------- */

/**
 * The floor: what the panel says when no attempt has been filed.
 *
 * Byte-exact with the signed wording of rung P0 of the beat map and of the demonstration script.
 * The worst possible failure of the second act is a blank panel with a presenter improvising;
 * painting this turns that failure into a beat that is already written and already signed.
 */
export const NO_ATTEMPT_FILED =
  'No promotion attempt has been filed yet. The gate exists as a signed contract in the schema: a ' +
  'rejection that does not name its failing conjunct cannot be written at all — the database ' +
  'refuses it. What I can show today is that contract, and the count of attempts, which is zero ' +
  'and honest.';

/**
 * The screen's answer to the only question that can derail the beat: if nothing has been run, why
 * underpowered?
 *
 * `interpretation` is a closed alphabet with no member meaning "not evaluated", so the row is obliged
 * to say `UNDERPOWERED` — and `UNDERPOWERED` on its own reads as *"we measured and came up short of
 * power"*, which is false here. This sentence is what separates the two readings, and it is rendered
 * whenever, and only whenever, the failing conjunct is `precondition_underpowered`.
 */
export const FAIL_CLOSED_STATEMENT =
  'An unevaluable conjunct produces a typed no-promotion: never a default promotion, never a silent ' +
  'skip, never an operator judgement. The precondition of the gate is MDE_clan-aware ≤ MDI, and it ' +
  'could not be evaluated here because neither quantity is derived — the minimum detectable effect ' +
  'needs a sealed report split and a scored run, and the minimum difference of interest is a ' +
  'pre-registered convention that has not been declared yet. UNDERPOWERED therefore says that ' +
  'nothing was measured, not that a measurement came out small.';

/**
 * What this surface is and what it is not.
 *
 * It is the one place in this module allowed to name the two deliverables it does not substitute,
 * and a lint keeps those two names out of every other string the panel can print: a panel that
 * called itself the quality surface would claim on screen a cell that is paid for in a later phase.
 */
export const SURFACE_SCOPE =
  'This screen brings forward the floor of the second act: the promotion gate in its filed state. It ' +
  'does not stand in for the Model Quality surface of D-9, which is where accuracy and its interval ' +
  'are published, nor for the reconciliation line inside the Decision Audit Log. Both are dated ' +
  'deliverables and both are listed below.';

/** What a figure that has not been derived is called. Never a zero, never a bare dash. */
export const NOT_DERIVED = 'not derived';

/** The scope of the reconciliation line, in the form this repository already uses for a count. */
export const RECONCILIATION_SCOPE =
  'Counted over exactly the rows this session may see, so the total is a tenant total and not a ' +
  'system total.';

/** Why the attempt opens a run of its own, said in one line beside the chain coordinates. */
export const OWN_RUN_STATEMENT =
  'The attempt opens a run of its own: not the ticket’s run, not the run of the first act. A ' +
  'promotion attempt is not a customer’s run, so it does not extend that chain, and neither row ' +
  'carries a ticket.';

/** The absence of controls, declared rather than merely true. */
export const READ_ONLY_STATEMENT =
  'This screen is read-only and files nothing. The evolution loop running live is a declared omission ' +
  'of this demonstration; its payer is the improvement-engine card of D-11.';

/* ------------------------------------------------------------------------------------------------
 * 4 · Reconciliation: set equality by attempt, never two counts
 * ---------------------------------------------------------------------------------------------- */

/** One row of the two classes an attempt is made of, as a reader hands it over. */
export type AttemptLedgerRow = {
  kind: 'start' | 'terminal';
  attempt_id: string;
  run_id: string;
  seq: number;
  ticket_id: string | null;
  /** The row's `output`, whole. */
  output: Record<string, unknown>;
  /** Whether the reader recomputed `row_hash` over the row and got the stored one back. */
  verified: boolean;
};

export type Reconciliation = {
  /**
   * Three values, and the third one is why.
   *
   * The invariant names two — reconciled or not — but an empty set satisfies `0 = 0`, and a panel
   * that painted the empty case green would be reporting a conservation law over nothing. The zero
   * state has a name of its own so that it cannot be read as a pass.
   */
  verdict: 'reconciled' | 'not reconciled' | 'nothing filed';
  starts: number;
  terminals: number;
  /** Attempts that opened and never terminated: the exact signature of peek-and-abort. */
  dangling: string[];
  /** Terminals whose opening is not here. */
  orphan: string[];
  /** Rows that claim to be terminals and carry an outcome outside the three published ones. */
  invalid: string[];
};

/**
 * Set equality by `attempt_id`, anti-joined in both directions.
 *
 * **Two counts are not enough, and the failure is cheap to produce.** Nothing ties a terminal to its
 * opening: the two unique indexes are independent, there is no foreign key between them — measured,
 * twelve constraints on the table and none of them is one — so `start(A)` plus `terminal(B)` passes a
 * count comparison while the run holds one attempt that never ended and one that never began.
 *
 * **A row whose `outcome` is outside the three terminals is NOT a terminal.** Counting it would turn
 * an invalid row into evidence of conservation: the line would read green because of the very row
 * that should have turned it red.
 *
 * The function is pure over the rows it is given, and the SCOPE is the caller's decision. There are
 * two callers with two published scopes: the screen counts what the session may see, which is a
 * tenant total and says so; the `db` job counts the run, because that is what the invariant's own
 * text publishes.
 */
export function reconcileAttempts(rows: readonly AttemptLedgerRow[]): Reconciliation {
  const starts = new Set<string>();
  const terminals = new Set<string>();
  const invalid = new Set<string>();

  for (const row of rows) {
    if (row.kind === 'start') {
      starts.add(row.attempt_id);
      continue;
    }
    const outcome = row.output.outcome;
    if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) {
      invalid.add(row.attempt_id);
      continue;
    }
    terminals.add(row.attempt_id);
  }

  const dangling = [...starts].filter((id) => !terminals.has(id)).sort();
  const orphan = [...terminals].filter((id) => !starts.has(id)).sort();
  const invalidIds = [...invalid].sort();

  let verdict: Reconciliation['verdict'];
  if (starts.size === 0 && terminals.size === 0 && invalidIds.length === 0) {
    verdict = 'nothing filed';
  } else if (dangling.length === 0 && orphan.length === 0 && invalidIds.length === 0) {
    verdict = 'reconciled';
  } else {
    verdict = 'not reconciled';
  }

  return {
    verdict,
    starts: starts.size,
    terminals: terminals.size,
    dangling,
    orphan,
    invalid: invalidIds,
  };
}

/* ------------------------------------------------------------------------------------------------
 * 5 · The view model
 * ---------------------------------------------------------------------------------------------- */

/**
 * `power`, as a discriminated union.
 *
 * The `not_derived` branch **carries no figure at all**, which is the point: Δ, the two endpoints of
 * the interval, `MDE_n`, `MDI`, α and `C_max` are printed as `not derived` with their reason. Never
 * a zero — a zero in the Δ cell is a MEASURED zero to anybody reading it — and never an interval
 * with a unit and no endpoints, which is exactly what the `no_IC_sin_unidad` lint of `02_SPEC.md:1118`
 * says breaks a build.
 */
export type PowerView =
  | {
      kind: 'not_derived';
      /** A declared convention, so it is nameable where the endpoints are not. */
      ci_unit: string;
      cells: readonly { label: string; value: string; reason: string }[];
      open_question: string;
    }
  | {
      kind: 'derived';
      delta: number;
      ci_low: number;
      ci_high: number;
      ci_unit: string;
      mde_n: number;
      mdi: number;
    };

export type ConjunctView = {
  name: ConjunctName;
  verdict: ConjunctVerdict;
  reason: string;
  /** The dated deliverable that will make this conjunct evaluable, or null once it is. */
  milestone: Milestone | null;
};

export type PromotionPanelView =
  | {
      kind: 'not_filed';
      attempts: 0;
      statement: string;
      reconciliation: Reconciliation;
      milestones: readonly Milestone[];
      scope: string;
    }
  | {
      kind: 'not_verifiable';
      attempts: number;
      /** Which row failed and how. Never a checklist. */
      failure: string;
      reconciliation: Reconciliation;
      scope: string;
    }
  | {
      kind: 'filed';
      attempts: number;
      attempt_id: string;
      run_id: string;
      start_seq: number;
      terminal_seq: number | null;
      ticket_id: string | null;
      candidate_prompt_version_id: string;
      incumbent_prompt_version_id: string;
      conjuncts: readonly ConjunctView[];
      failing_conjunct: string | null;
      /** The whole closed alphabet, so a reader can see the field is not free text. */
      failing_conjunct_alphabet: readonly string[];
      outcome: string;
      interpretation: string;
      power: PowerView;
      /** Present when, and only when, the failing conjunct is `precondition_underpowered`. */
      fail_closed_statement: string | null;
      reconciliation: Reconciliation;
      milestones: readonly Milestone[];
      scope: string;
      own_run: string;
      read_only: string;
    };

function refuse(message: string): never {
  throw new Error(`promotion panel: ${message}`);
}

/**
 * The four conjuncts, as a list in the published order.
 *
 * **The SET is checked; the ORDER is re-established here rather than demanded of the row, and that
 * is forced by the storage rather than chosen.** `output` is a `jsonb` column and `jsonb` normalises
 * key order by length and then bytewise — measured: the four names come back as `delta_positive`,
 * `battery_in_force_green`, `query_index_within_cmax`, `paired_significant_at_alpha`, whatever order
 * they were written in. The canonical serialisation the row's digest was taken over sorts keys too
 * (`agents/canonical.ts:44`), so the published order never reaches the database in the first place.
 * A panel that demanded it on the way out would throw on every real row.
 *
 * So the order lives where it can: the writer checks it on the payload it is handed, before the
 * insert, and this maps over the published array so that what a reader SEES is always the sequence
 * the specification prints. A row with a fifth conjunct, a missing one, or a renamed one still
 * refuses to render.
 */
function conjunctsOf(output: Record<string, unknown>): readonly ConjunctView[] {
  const raw = output.conjuncts;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    refuse('the row carries no conjuncts object');
  }
  const entries = raw as Record<string, unknown>;
  const present = Object.keys(entries);
  if (
    present.length !== CONJUNCT_NAMES.length ||
    !CONJUNCT_NAMES.every((name) => Object.prototype.hasOwnProperty.call(entries, name))
  ) {
    refuse(
      `the row names [${present.join(', ')}] where the published four are [${CONJUNCT_NAMES.join(', ')}]`,
    );
  }

  return CONJUNCT_NAMES.map((name) => {
    const entry = entries[name];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      refuse(`${name} is not an object with a verdict and a reason`);
    }
    const record = entry as Record<string, unknown>;
    const verdict = record.verdict;
    if (typeof verdict !== 'string' || !(CONJUNCT_VERDICTS as readonly string[]).includes(verdict)) {
      refuse(
        `${name} says '${String(verdict)}', which is outside {${CONJUNCT_VERDICTS.join(', ')}}`,
      );
    }
    const reason = record.reason;
    if (verdict !== 'PASS' && (typeof reason !== 'string' || reason.trim() === '')) {
      refuse(`${name} is ${verdict} and carries no reason`);
    }
    return {
      name,
      verdict: verdict as ConjunctVerdict,
      reason: typeof reason === 'string' ? reason : '',
      milestone: verdict === 'UNEVALUABLE' ? milestone(CONJUNCT_MILESTONE[name]) : null,
    };
  });
}

/**
 * The parameters of the gate that are neither in `power` nor derivable today.
 *
 * α and `C_max` are two of the twelve values `[OPEN-7]` still holds open, and the specification is
 * explicit that none of the twelve has a value today. They are printed as cells so that a reader sees
 * the gate's own parameters declared open rather than absent.
 */
const OPEN_PARAMETERS: readonly { label: string; reason: string }[] = [
  { label: 'alpha', reason: 'still open under OPEN-7, and not invented here' },
  { label: 'C_max', reason: 'still open under OPEN-7, and not invented here' },
];

function powerOf(output: Record<string, unknown>): PowerView {
  const raw = output.power;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    refuse('the row carries no power object');
  }
  const power = raw as Record<string, unknown>;
  const ciUnit = power.ci_unit;
  if (typeof ciUnit !== 'string' || ciUnit.trim() === '') {
    refuse('power carries no ci_unit, and an interval without its unit is not publishable');
  }

  const quantities = ['delta', 'ci_low', 'ci_high', 'mde_n', 'mdi'] as const;
  const derived = quantities.filter((key) => typeof power[key] === 'number');
  if (derived.length === quantities.length) {
    return {
      kind: 'derived',
      delta: power.delta as number,
      ci_low: power.ci_low as number,
      ci_high: power.ci_high as number,
      ci_unit: ciUnit,
      mde_n: power.mde_n as number,
      mdi: power.mdi as number,
    };
  }
  if (derived.length !== 0) {
    refuse(
      `power is partly derived: [${derived.join(', ')}] carry figures while the rest do not, and a half interval is not publishable`,
    );
  }

  return {
    kind: 'not_derived',
    ci_unit: ciUnit,
    cells: [
      { label: 'delta', value: NOT_DERIVED, reason: 'no scored run has been recorded' },
      { label: 'ci_low', value: NOT_DERIVED, reason: 'no scored run has been recorded' },
      { label: 'ci_high', value: NOT_DERIVED, reason: 'no scored run has been recorded' },
      { label: 'MDE_n', value: NOT_DERIVED, reason: 'no report split has been sealed' },
      {
        label: 'MDI',
        value: NOT_DERIVED,
        reason: 'a pre-registered convention, and the pre-registration document is not written',
      },
      ...OPEN_PARAMETERS.map((entry) => ({
        label: entry.label,
        value: NOT_DERIVED,
        reason: entry.reason,
      })),
    ],
    open_question: 'OPEN-7',
  };
}

/**
 * The panel, from the rows a reader could see.
 *
 * The rows are the caller's scope: the screen hands over what the session may see, and says so.
 * The attempt rendered is the one with the highest `seq` among the starts — with one attempt in
 * existence today that is the only one, and with more it is the newest, which is what a reader of a
 * ledger expects to be looking at.
 */
export function promotionPanelView(rows: readonly AttemptLedgerRow[]): PromotionPanelView {
  const reconciliation = reconcileAttempts(rows);

  if (rows.length === 0) {
    return {
      kind: 'not_filed',
      attempts: 0,
      statement: NO_ATTEMPT_FILED,
      reconciliation,
      milestones: PENDING_MILESTONES,
      scope: SURFACE_SCOPE,
    };
  }

  const unverified = rows.find((row) => !row.verified);
  if (unverified) {
    return {
      kind: 'not_verifiable',
      attempts: reconciliation.starts,
      failure:
        `The ${unverified.kind} row of attempt ${unverified.attempt_id} at seq ${unverified.seq} does ` +
        'not hash to what it says it does. Nothing about this attempt is rendered: a panel that ' +
        'printed the payload anyway would paint a tampered row exactly as it paints a sound one.',
      reconciliation,
      scope: SURFACE_SCOPE,
    };
  }

  const starts = rows.filter((row) => row.kind === 'start').sort((a, b) => b.seq - a.seq);
  const newest = starts[0];
  if (!newest) {
    return {
      kind: 'not_verifiable',
      attempts: 0,
      failure:
        'A terminal is present and its start row is not. An attempt that terminated without ever ' +
        'having opened is not an attempt this panel can describe.',
      reconciliation,
      scope: SURFACE_SCOPE,
    };
  }

  const terminal = rows.find(
    (row) => row.kind === 'terminal' && row.attempt_id === newest.attempt_id,
  );
  if (!terminal) {
    return {
      kind: 'not_verifiable',
      attempts: reconciliation.starts,
      failure:
        `Attempt ${newest.attempt_id} opened at seq ${newest.seq} and has no terminal. A start ` +
        'without a terminal is the signature the conservation invariant exists to catch; it is ' +
        'named here rather than rendered as a gate that never ran.',
      reconciliation,
      scope: SURFACE_SCOPE,
    };
  }

  const output = terminal.output;
  const conjuncts = conjunctsOf(output);
  const power = powerOf(output);

  const outcome = output.outcome;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) {
    refuse(`the row terminates as '${String(outcome)}', which is not one of the three terminals`);
  }
  const interpretation = output.interpretation;
  if (
    typeof interpretation !== 'string' ||
    !(INTERPRETATIONS as readonly string[]).includes(interpretation)
  ) {
    refuse(`the row interprets itself as '${String(interpretation)}', which is outside the alphabet`);
  }

  const failing = output.failing_conjunct ?? null;
  if (failing !== null) {
    if (typeof failing !== 'string' || !(FAILING_CONJUNCTS as readonly string[]).includes(failing)) {
      refuse(`failing_conjunct is '${String(failing)}', which is outside the closed alphabet`);
    }
  }

  const candidate = output.candidate_prompt_version_id;
  const incumbent = output.incumbent_prompt_version_id;
  if (typeof candidate !== 'string' || typeof incumbent !== 'string') {
    refuse('the row does not name both sides of the comparison');
  }
  const c2 = conjuncts.find((entry) => entry.name === 'delta_positive');
  const declaresNoCandidate = c2 ? c2.reason.includes('no candidate generation has been proposed') : false;
  if (declaresNoCandidate && candidate !== incumbent) {
    refuse(
      'the second conjunct declares that no candidate has been proposed while the two identifiers differ',
    );
  }

  return {
    kind: 'filed',
    attempts: reconciliation.starts,
    attempt_id: newest.attempt_id,
    run_id: newest.run_id,
    start_seq: newest.seq,
    terminal_seq: terminal.seq,
    ticket_id: terminal.ticket_id,
    candidate_prompt_version_id: candidate,
    incumbent_prompt_version_id: incumbent,
    conjuncts,
    failing_conjunct: failing === null ? null : (failing as string),
    failing_conjunct_alphabet: FAILING_CONJUNCTS,
    outcome,
    interpretation,
    power,
    fail_closed_statement: failing === 'precondition_underpowered' ? FAIL_CLOSED_STATEMENT : null,
    reconciliation,
    milestones: PENDING_MILESTONES,
    scope: SURFACE_SCOPE,
    own_run: OWN_RUN_STATEMENT,
    read_only: READ_ONLY_STATEMENT,
  };
}
