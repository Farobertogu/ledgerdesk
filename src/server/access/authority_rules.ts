/** Pure operational conditions, never external accreditation or a route grant. */
export function declarationDeadline(declaration: any, events: readonly any[]): number | null {
  const t = declaration?.termination;
  if (t?.kind === 'expires') return Number.isSafeInteger(t.at) ? t.at : null;
  if (t?.kind !== 'revalidate' || typeof t.eventRef !== 'string') return null;
  const matches = events.filter(e => e.id === t.eventRef && e.satisfied === true);
  if (matches.length !== 1) return null;
  const n = Number(matches[0].current_until);
  return Number.isSafeInteger(n) ? n : null;
}
export function independentPeople(people: readonly (string | null)[], required = 2): boolean {
  return Number.isSafeInteger(required) && required >= 2 && people.length >= required &&
    people.every(p => typeof p === 'string' && p.length > 0) && new Set(people).size === people.length;
}

/** Different maximum grades/purposes are not silently merged. Resolution is scoped. */
export function resolveDeclarations(current: readonly any[], resolutions: readonly any[], permission: string, scope: string): any[] {
  if (!current.length) return [];
  const signatures = new Set(current.map(i => JSON.stringify([i.declaration.purposeRef, i.declaration.maximumGradeRef])));
  if (signatures.size === 1) return [...current];
  const applicable = resolutions.filter(r => r.active && r.scope_ref === scope && r.permission_id === permission &&
    current.some(i => i.id === r.selected_id));
  const selected = new Set(applicable.map(r => r.selected_id));
  return selected.size === 1 ? current.filter(i => selected.has(i.id)) : [];
}
