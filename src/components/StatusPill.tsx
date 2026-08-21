import type { TicketState } from '@/server/states';

// Written out per state rather than composed at runtime: Tailwind reads the source, so a class
// name that only exists once the code runs is a class name that never reaches the stylesheet.
const TONE: Record<TicketState, string> = {
  NEW: 'border-sky-200 bg-sky-50 text-sky-900',
  TRIAGED: 'border-indigo-200 bg-indigo-50 text-indigo-900',
  DRAFTED: 'border-violet-200 bg-violet-50 text-violet-900',
  AWAITING_AGENT: 'border-amber-200 bg-amber-50 text-amber-900',
  SENT: 'border-teal-200 bg-teal-50 text-teal-900',
  ESCALATED: 'border-rose-200 bg-rose-50 text-rose-900',
  RESOLVED: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  CLOSED: 'border-stone-300 bg-stone-100 text-stone-700',
  REOPENED: 'border-orange-200 bg-orange-50 text-orange-900',
  TRIAGE_FAILED: 'border-red-200 bg-red-50 text-red-900',
};

export function StatusPill({ status }: { status: TicketState }) {
  return (
    <span
      className={`inline-block rounded border px-2 py-0.5 font-mono text-[11px] leading-5 ${TONE[status]}`}
    >
      {status}
    </span>
  );
}
