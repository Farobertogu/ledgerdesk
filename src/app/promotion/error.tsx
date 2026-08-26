'use client';

/**
 * The named screen for a row this panel refuses to render.
 *
 * The panel's rule is that an attempt it cannot trust is a refusal to render and never a dash on a
 * screen — a row whose failing conjunct falls outside the closed alphabet, or whose shape the view
 * cannot reconcile, must not be quietly softened into a blank cell. That rule was implemented as an
 * exception thrown inside a server component, and with no error boundary in this segment the reader
 * got a framework 500 and an empty page: the refusal was correct and its presentation was not.
 *
 * A 500 is the one outcome a demonstration surface cannot afford, because it looks identical to the
 * system being broken. This boundary turns the same refusal into what it always meant: a screen that
 * says the row was rejected, and by what rule, so the failure reads as the gate working rather than
 * as the gate falling over. No row the writer produces can reach it — the writer refuses out-of-
 * alphabet values before the database sees them — which is exactly why it is defence in depth.
 */
export default function PromotionPanelError({ error }: { error: Error & { digest?: string } }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-lg font-semibold">This attempt was refused, not rendered</h1>
      <p className="mt-3 text-sm leading-relaxed">
        The promotion panel will not draw an attempt row it cannot vouch for. Rather than soften the
        row into a blank field, it refuses the whole render and says so here. The gate is working:
        what failed is one row&apos;s right to be shown, not the check it records.
      </p>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        The rule that refused it: <span className="font-mono text-[13px]">{error.message}</span>
        {error.digest ? <span className="ml-2 font-mono text-[11px]">· {error.digest}</span> : null}
      </p>
      <p className="mt-4 text-sm text-muted">
        Every row this system&apos;s own writer files satisfies the rule before the database is asked
        to accept it, so a row that reaches this screen was written by something else.
      </p>
    </main>
  );
}
