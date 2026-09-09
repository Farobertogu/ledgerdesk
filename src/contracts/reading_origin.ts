/** Trial transport configuration only: never identity, policy or delivery authority. */
export function readLoopbackOrigin(value: string | undefined): string | null {
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) return null;
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  // Require canonical, explicit port spelling. No DNS, credentials or URL path is accepted.
  if (port < 1024 || port > 65535 || String(port) !== value.slice(value.lastIndexOf(':') + 1)) return null;
  return value;
}
