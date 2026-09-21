import type {ItemView} from '../view_model';

/** Binary size labels retained from the intake demo; null is not zero. */
export function byteLabel(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function workspaceRows(items: readonly ItemView[], query: string, selectedKey: string | null) {
  const term = query.toLowerCase();
  const rows = items.filter(item => `${item.name}\n${item.key}`.toLowerCase().includes(term));
  const selected = items.find(item => item.key === selectedKey) ?? null;
  return {rows, selected, outsideFilter: selected !== null && !rows.some(item => item.key === selected.key)};
}
