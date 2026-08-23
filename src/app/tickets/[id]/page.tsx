import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DraftButton } from '@/components/DraftButton';
import { formatInstant } from '@/components/format';
import { GapControls } from '@/components/GapControls';
import { Notice, PageHeading, Panel } from '@/components/Panel';
import { StatusPill } from '@/components/StatusPill';
import { TriageButton } from '@/components/TriageButton';
import { NO_MATCH_STATEMENT } from '@/alg/retrieval';
import { evidenceFor } from '@/server/evidence';
import { GAP_COMMITMENTS } from '@/server/kb/commitment';
import { claimsFor, currentIdentity } from '@/server/session';
import { getTicket } from '@/server/tickets';

export const dynamic = 'force-dynamic';

/**
 * One ticket, and the evidence of what was done to it.
 *
 * **Read-only, and the missing controls are the point.** There is no edit, no approve, no send.
 * Their absence is safe because `0009` made those states unreachable from here — a trigger refuses
 * `SENT` without an approver and a sent instant, and a restrictive policy refuses any update of
 * `response` from a session with no subject — and not because the buttons have not been drawn yet.
 * A panel whose safety rested on which controls somebody had got round to adding would be a panel
 * that becomes unsafe the day somebody adds one.
 *
 * **What it shows, and why each piece is on the same screen.** The draft as it was written; each
 * citation with its identifier, its title and the snapshot it was read under; the verdict with the
 * claims the validator would not support; the rows of the chain for this ticket, with the state
 * they were written under and whether they cost anything. That last column is what makes the
 * demonstration's closing act legible: two rows, two `state_hash` values, one chain.
 *
 * And when a knowledge gap has been recorded and closed against this ticket, it is shown **beside**
 * the escalation it produced rather than on a screen of its own. The whole cycle — the question
 * that could not be answered, the material admitted, the answer that followed — belongs in one
 * view, because a supervisor looking at an escalated ticket is exactly the person who needs to know
 * that the gap behind it has since been filled.
 */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await currentIdentity();

  if (!identity) {
    return (
      <>
        <PageHeading title="Ticket" lead="The record of one ticket and what the system did with it." />
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

  const claims = claimsFor(identity);
  const ticket = await getTicket(claims, id);
  // A row this session cannot see and a row that does not exist give the same answer, for the
  // reason the API gives it: distinguishing them would confirm another organisation's ticket to
  // somebody not allowed to know it exists.
  if (!ticket) notFound();

  const evidence = await evidenceFor(claims, id);
  const staff = identity.role === 'agent' || identity.role === 'supervisor';
  const current = evidence.drafts[0] ?? null;
  const superseded = evidence.drafts.slice(1);
  const emptyRetrieval = evidence.retrievals.find(
    (entry) => entry.retrieval_kind !== null && entry.result_count === 0,
  );
  // The standing commitment, shown beneath the two fields the record stores. It is looked up rather
  // than stored on the row on purpose: the record keeps the owner and the date it was opened under,
  // and the sentence is the artefact's — one copy, in the place it is authored.
  const commitment = GAP_COMMITMENTS.find((entry) => entry.org_id === identity.org_id) ?? null;

  return (
    <>
      <PageHeading
        title={ticket.subject}
        lead="Everything below is read from the database under this session's own claims. Nothing on this screen edits, approves or sends."
      />

      <div className="space-y-6">
        <Panel title="Ticket">
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-sm">
            <div>
              <StatusPill status={ticket.status} />
              {ticket.escalation_reason ? (
                <p className="mt-1 font-mono text-[11px] text-rose-800">
                  {ticket.escalation_reason}
                  <span className="ml-1 text-muted">· {ticket.escalation_clause ?? '—'}</span>
                </p>
              ) : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[11px] text-muted">
              <dt>category</dt>
              <dd>{ticket.category ?? '—'}</dd>
              <dt>severity</dt>
              <dd>{ticket.severity ?? '—'}</dd>
              <dt>sentiment</dt>
              <dd>{ticket.sentiment ?? '—'}</dd>
              <dt>confidence</dt>
              <dd>{ticket.confidence ?? '—'}</dd>
              <dt>priority</dt>
              <dd>{ticket.priority ?? '—'}</dd>
              <dt>first response due</dt>
              <dd>{formatInstant(ticket.sla_due_at)}</dd>
            </dl>
            {staff ? (
              <div className="space-y-2">
                <TriageButton ticketId={ticket.id} enabled={['NEW', 'REOPENED'].includes(ticket.status)} />
                <DraftButton ticketId={ticket.id} enabled={ticket.status === 'TRIAGED'} />
              </div>
            ) : null}
          </div>
        </Panel>

        {current ? (
          <Panel
            title="Draft"
            hint="The reply exactly as it was written, with the sources it stands on. It is not editable here and it has not been sent."
          >
            <p className="whitespace-pre-wrap text-sm">{current.draft}</p>

            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
              <dt>grounded</dt>
              <dd className={current.grounded ? 'text-emerald-800' : 'text-rose-800'}>
                {current.grounded === null ? '—' : String(current.grounded)}
              </dd>
              <dt>snapshot</dt>
              <dd>{current.kb_snapshot ?? '—'}</dd>
              <dt>validated</dt>
              <dd>{formatInstant(current.validated_at)}</dd>
              <dt>approved</dt>
              <dd>{current.approved_by ?? 'not approved'}</dd>
              <dt>sent</dt>
              <dd>{formatInstant(current.sent_at)}</dd>
            </dl>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Citations</h3>
            {current.citations.length === 0 ? (
              <p className="mt-1 text-sm text-muted">This draft cites nothing.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {current.citations.map((citation) => (
                  <li key={citation.kb_id} className="text-sm">
                    <span className="font-medium">{citation.title}</span>
                    <span className="ml-2 font-mono text-[11px] text-muted">
                      {citation.kb_id} · {citation.kb_snapshot}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {current.unsupported_claims.length > 0 ? (
              <>
                <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-rose-800">
                  Claims the validator would not support
                </h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-rose-800">
                  {current.unsupported_claims.map((claim) => (
                    <li key={claim}>{claim}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </Panel>
        ) : emptyRetrieval ? (
          <Panel title="Retrieval" hint="What the search of the knowledge base returned.">
            {/* The permitted sentence, published as a constant so that the screen and the record of
                the decision say the same thing — and so that neither of them says the other thing. */}
            <p className="text-sm">{NO_MATCH_STATEMENT}</p>
            <p className="mt-2 font-mono text-[11px] text-muted">
              {emptyRetrieval.retrieval_kind} · snapshot {emptyRetrieval.kb_snapshot ?? '—'} · no draft was
              written and no model was called
            </p>
          </Panel>
        ) : null}

        {superseded.length > 0 ? (
          <Panel
            title="Earlier drafts"
            hint="A re-draft inserts a new answer rather than replacing the one before it, so both halves of a corrected cycle stay readable."
          >
            <ul className="space-y-4">
              {superseded.map((draft) => (
                <li key={draft.id} className="border-l-2 border-line pl-4">
                  <p className="whitespace-pre-wrap text-sm text-muted">{draft.draft}</p>
                  <p className="mt-1 font-mono text-[11px] text-muted">
                    grounded {String(draft.grounded)} · snapshot {draft.kb_snapshot ?? '—'} ·{' '}
                    {formatInstant(draft.created_at)}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {evidence.gaps.length > 0 ? (
          <Panel
            title="Knowledge gaps"
            hint="Recorded against this ticket, and shown here rather than on a screen of their own: the gap and the escalation it produced are one story."
          >
            <ul className="space-y-5">
              {evidence.gaps.map((gap) => (
                <li key={gap.id} className="text-sm">
                  <span className="font-mono text-[11px]">{gap.state}</span>
                  <span className="ml-2 font-mono text-[11px] text-muted">
                    snapshot {gap.kb_snapshot} · zero match {String(gap.zero_match)}
                    {gap.closed_by_check_at ? ` · closed ${formatInstant(gap.closed_by_check_at)}` : ''}
                  </span>

                  {/* The commitment, which is what turns a record of a failure into a piece of work
                      somebody agreed to do. Both fields are the record's own; the sentence beneath
                      them is the standing commitment they were read from. */}
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
                    <dt>owner</dt>
                    <dd>
                      {gap.owner_id}
                      <span className="ml-1">· {gap.owner_role}</span>
                    </dd>
                    <dt>committed</dt>
                    <dd>{gap.committed_date}</dd>
                  </dl>
                  {commitment ? (
                    <>
                      <p className="mt-1 text-xs text-muted">{commitment.statement}</p>
                      {/* Who decided that, and when. An owner assigned by a document nobody signed
                          is an owner assigned by nobody, which is the failure the commitment exists
                          to prevent moved one level up. */}
                      <p className="mt-0.5 font-mono text-[11px] text-muted">
                        declared by {commitment.declared_by} on {commitment.declared_on} ·{' '}
                        {commitment.ref}
                      </p>
                    </>
                  ) : null}

                  <p className="mt-2 text-xs text-muted">{gap.null_rule}</p>
                  {gap.not_documentable_reason ? (
                    <p className="mt-1 text-xs text-muted">{gap.not_documentable_reason}</p>
                  ) : null}

                  <GapControls
                    gapId={gap.id}
                    state={gap.state}
                    role={identity.role}
                    admitted={evidence.admissions.some((entry) => entry.gap_id === gap.id)}
                  />
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {evidence.admissions.length > 0 ? (
          <Panel
            title="Admissions"
            hint="What was let into the corpus to answer a gap above, who let it in, and which snapshot the corpus moved from and to."
          >
            <ul className="space-y-3">
              {evidence.admissions.map((admission) => (
                <li key={admission.id} className="text-sm">
                  <span className="font-medium">{admission.title ?? admission.canonical_key ?? 'admitted document'}</span>
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
                    <dt>approved by</dt>
                    <dd>
                      {admission.approved_by}
                      <span className="ml-1">· {admission.approver_role}</span>
                    </dd>
                    <dt>snapshot</dt>
                    <dd>
                      {admission.snapshot_from} → {admission.snapshot_to}
                    </dd>
                    <dt>content</dt>
                    <dd title={admission.content_hash}>{admission.content_hash.slice(0, 12)}</dd>
                    <dt>source</dt>
                    <dd>{admission.provenance_source}</dd>
                    <dt>admitted</dt>
                    <dd>{formatInstant(admission.admitted_at)}</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        <Panel
          title="Chain"
          hint="Every row this ticket produced, in order. Two rows carrying different state values were written under different conditions and are not comparable — which is what makes a before-and-after readable."
        >
          {evidence.ledger.length === 0 ? (
            <p className="text-sm text-muted">
              No row has been written for this ticket. An escalation decided from the ticket&rsquo;s own
              record costs nothing and produces none.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] border-collapse text-left font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-line uppercase tracking-wide text-muted">
                    <th className="py-2 pr-4 font-medium">seq</th>
                    <th className="py-2 pr-4 font-medium">class</th>
                    <th className="py-2 pr-4 font-medium">agent</th>
                    <th className="py-2 pr-4 font-medium">model</th>
                    <th className="py-2 pr-4 font-medium">cost (AUD)</th>
                    <th className="py-2 pr-4 font-medium">cache</th>
                    <th className="py-2 pr-4 font-medium">state_hash</th>
                    <th className="py-2 font-medium">written</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.ledger.map((row) => (
                    <tr key={row.seq} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4 tabular-nums">{row.seq}</td>
                      {/* The class is on screen because the admission row is what makes the two
                          halves of a corrected cycle legible: the same question before and after,
                          in one chain, with the row that changed the corpus between them. */}
                      <td className="py-2 pr-4">{row.class}</td>
                      <td className="py-2 pr-4">{row.agent}</td>
                      <td className="py-2 pr-4">{row.model_requested ?? '—'}</td>
                      <td className="py-2 pr-4 tabular-nums">{row.cost_aud}</td>
                      <td className="py-2 pr-4">{row.cache_hit ? 'hit' : 'miss'}</td>
                      <td className="py-2 pr-4" title={row.state_hash}>
                        {row.state_hash.slice(0, 12)}
                      </td>
                      <td className="py-2">{formatInstant(row.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
