import Link from 'next/link';

import { Notice, PageHeading, Panel } from '@/components/Panel';
import { milestoneState, promotionPanelView } from '@/alg/promotion_panel';
import { attemptRowsFor } from '@/server/promotion';
import { claimsFor, currentIdentity } from '@/server/session';

export const dynamic = 'force-dynamic';

/**
 * The promotion gate, in whatever state the chain actually holds it.
 *
 * **Read-only, and it says so on the screen.** There is no control here that opens an attempt,
 * retries one or promotes anything, and the absence is explained rather than left to be noticed: a
 * button invites an examiner to ask for it to be pressed, and what would answer is not built. The
 * presenter says out loud, in the same ten minutes, that the evolution loop running live is one of
 * three things deliberately not demonstrated.
 *
 * **The type scale is declared, because this is projected.** The scale the chain table uses is built
 * for somebody sitting half a metre from a laptop; at eleven pixels on a projector
 * `precondition_underpowered` stops being evidence and becomes a smudge the presenter has to read
 * aloud, which is a rescue. The three constants below are what a check in `ci/check.sh` inspects.
 */

/** The terminal of the attempt. Large enough to read from the back of a room. */
const OUTCOME_SCALE = 'text-2xl font-semibold tracking-tight';

/** The named failing conjunct — the single most important string on this screen. */
const FAILING_CONJUNCT_SCALE = 'text-xl font-semibold tracking-tight break-all';

/** The four verdicts of the checklist. */
const VERDICT_SCALE = 'text-base font-semibold tracking-tight';

export default async function PromotionPage() {
  const identity = await currentIdentity();

  if (!identity) {
    return (
      <>
        <PageHeading title="Promotion gate" lead="The gate, in the state the chain holds it." />
        <Notice>
          No session is selected.{' '}
          <Link href="/session" className="text-accent underline-offset-4 hover:underline">
            Choose one
          </Link>{' '}
          to continue.
        </Notice>
      </>
    );
  }

  if (identity.role !== 'supervisor') {
    return (
      <>
        <PageHeading title="Promotion gate" lead="The gate, in the state the chain holds it." />
        <Notice>
          This console belongs to the supervisor role; the session in force is{' '}
          <span className="font-medium">{identity.role}</span>.{' '}
          <Link href="/session" className="text-accent underline-offset-4 hover:underline">
            Change session
          </Link>
          .
        </Notice>
      </>
    );
  }

  const rows = await attemptRowsFor(claimsFor(identity));
  const view = promotionPanelView(rows);
  const line = view.reconciliation;

  return (
    <>
      <PageHeading
        title="Promotion gate"
        lead={`${identity.org_name}: the four-conjunct checklist, read from the attempt row itself. ${view.scope}`}
      />

      {view.kind === 'not_filed' ? (
        <Panel title="No attempt has been filed" hint="The floor, stated in full.">
          <p className="text-sm leading-relaxed">{view.statement}</p>
          <p className="mt-4 text-sm">
            Attempts filed: <span className="font-semibold tabular-nums">{view.attempts}</span>
          </p>
        </Panel>
      ) : null}

      {view.kind === 'not_verifiable' ? (
        <Panel title="This attempt is not renderable" hint="A named failure, and no checklist.">
          <p className="text-sm leading-relaxed">{view.failure}</p>
        </Panel>
      ) : null}

      {view.kind === 'filed' ? (
        <>
          <Panel
            title="The attempt, as the chain holds it"
            hint="Every value below is read from the row; nothing on this screen is composed by the page."
          >
            <div className="flex flex-wrap gap-x-12 gap-y-6">
              <div>
                <p className="text-sm text-muted">outcome</p>
                <p className={OUTCOME_SCALE}>{view.outcome}</p>
              </div>
              <div>
                <p className="text-sm text-muted">interpretation</p>
                <p className={OUTCOME_SCALE}>{view.interpretation}</p>
              </div>
              <div>
                <p className="text-sm text-muted">failing conjunct</p>
                <p className={FAILING_CONJUNCT_SCALE}>{view.failing_conjunct ?? 'null'}</p>
                <p className="mt-1 text-sm text-muted">
                  one of: {view.failing_conjunct_alphabet.join(' · ')} · null
                </p>
              </div>
            </div>

            {view.fail_closed_statement ? (
              <p className="mt-6 max-w-3xl text-sm leading-relaxed">{view.fail_closed_statement}</p>
            ) : null}
          </Panel>

          <div className="mt-6">
            <Panel
              title="The four conjuncts"
              hint="PASS · FAIL · UNEVALUABLE, with its reason. The alphabet is the published one and the order is the published order."
            >
              <ul className="divide-y divide-line">
                {view.conjuncts.map((conjunct) => (
                  <li key={conjunct.name} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline gap-x-4">
                      <span className="font-mono text-sm">{conjunct.name}</span>
                      <span className={VERDICT_SCALE}>{conjunct.verdict}</span>
                    </div>
                    <p className="mt-1 max-w-3xl text-sm text-muted">{conjunct.reason}</p>
                    {conjunct.milestone ? (
                      <p className="mt-1 text-sm">
                        pending{' '}
                        <span className="font-medium">{conjunct.milestone.id}</span> ·{' '}
                        {conjunct.milestone.title} ·{' '}
                        <span className="font-medium">{conjunct.milestone.published_date}</span>
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <div className="mt-6">
            <Panel
              title={`Power · ${view.power.kind === 'derived' ? 'derived' : 'not derived'}`}
              hint="An interval is published with its unit and with both endpoints, or it is not published."
            >
              {view.power.kind === 'not_derived' ? (
                <>
                  <ul className="flex flex-wrap gap-x-10 gap-y-4">
                    {view.power.cells.map((cell) => (
                      <li key={cell.label} className="min-w-40">
                        <p className="text-sm text-muted">{cell.label}</p>
                        <p className="text-base font-medium">{cell.value}</p>
                        <p className="mt-1 max-w-64 text-sm text-muted">{cell.reason}</p>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-4 text-sm text-muted">
                    Interval unit, declared in advance:{' '}
                    <span className="font-medium">{view.power.ci_unit}</span>. Open question:{' '}
                    <span className="font-medium">{view.power.open_question}</span>.
                  </p>
                </>
              ) : (
                <p className="text-sm">
                  delta {view.power.delta} · interval [{view.power.ci_low}, {view.power.ci_high}] per{' '}
                  {view.power.ci_unit} · MDE_n {view.power.mde_n} · MDI {view.power.mdi}
                </p>
              )}
            </Panel>
          </div>

          <div className="mt-6">
            <Panel title="Where the two rows sit in the chain" hint={view.own_run}>
              <dl className="grid gap-x-10 gap-y-3 sm:grid-cols-2">
                <div>
                  <dt className="text-sm text-muted">run</dt>
                  <dd className="font-mono text-sm">{view.run_id.slice(0, 8)}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">attempt</dt>
                  <dd className="font-mono text-sm break-all">{view.attempt_id}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">seq of the start row</dt>
                  <dd className="font-mono text-sm tabular-nums">{view.start_seq}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">seq of the terminal row</dt>
                  <dd className="font-mono text-sm tabular-nums">{view.terminal_seq ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">ticket</dt>
                  <dd className="font-mono text-sm">{view.ticket_id ?? 'null on both rows'}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted">candidate · incumbent</dt>
                  <dd className="font-mono text-sm break-all">
                    {view.candidate_prompt_version_id === view.incumbent_prompt_version_id
                      ? `${view.incumbent_prompt_version_id} (both sides)`
                      : `${view.candidate_prompt_version_id} · ${view.incumbent_prompt_version_id}`}
                  </dd>
                </div>
              </dl>
            </Panel>
          </div>
        </>
      ) : null}

      <div className="mt-6">
        <Panel title="starts == terminals" hint={RECONCILIATION_HINT}>
          <p className="text-base">
            <span className="font-semibold tabular-nums">{line.starts}</span> start
            {line.starts === 1 ? '' : 's'} ·{' '}
            <span className="font-semibold tabular-nums">{line.terminals}</span> terminal
            {line.terminals === 1 ? '' : 's'} ·{' '}
            <span className="font-semibold">{line.verdict}</span>
          </p>
          {line.dangling.length > 0 ? (
            <p className="mt-2 text-sm">
              opened and never terminated: {line.dangling.join(', ')}
            </p>
          ) : null}
          {line.orphan.length > 0 ? (
            <p className="mt-2 text-sm">terminated and never opened: {line.orphan.join(', ')}</p>
          ) : null}
          {line.invalid.length > 0 ? (
            <p className="mt-2 text-sm">
              terminal outside the three published outcomes: {line.invalid.join(', ')}
            </p>
          ) : null}
        </Panel>
      </div>

      {view.kind === 'not_verifiable' ? null : (
        <div className="mt-6">
          <Panel
            title="Pending, with a date"
            hint="Each identifier below is a row of Table 19 of the proposal, with the date that table publishes."
          >
            <ul className="space-y-2">
              {view.milestones.map((entry) => (
                <li key={entry.id} className="text-sm">
                  <span className="font-medium">{entry.id}</span> · {entry.title} ·{' '}
                  <span className="font-medium">{entry.published_date}</span>
                  {milestoneState(entry, new Date()) === 'due' ? (
                    <span className="ml-2 text-muted">
                      — this published date has gone by; the deliverable is not on this surface yet
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {view.kind === 'filed' ? (
              <p className="mt-4 max-w-3xl text-sm text-muted">{view.read_only}</p>
            ) : null}
          </Panel>
        </div>
      )}
    </>
  );
}

/** The scope of the count, in the form this repository already uses for one. */
const RECONCILIATION_HINT =
  'Set equality by attempt identifier, anti-joined in both directions — never two counts. Counted ' +
  'over exactly the rows this session may see, so the total is a tenant total and not a system total.';
