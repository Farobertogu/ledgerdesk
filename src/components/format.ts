// One timestamp format across the consoles, pinned to a timezone rather than the server's.
// A queue where two rows are rendered in different zones is a queue nobody can sort by eye.
const INSTANT = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Sydney',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatInstant(iso: string | null): string {
  if (!iso) return '—';
  return INSTANT.format(new Date(iso));
}
