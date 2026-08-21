export function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-line bg-surface">
      <header className="border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function PageHeading({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">{lead}</p>
    </div>
  );
}

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-line bg-surface px-5 py-4 text-sm text-muted">
      {children}
    </div>
  );
}
