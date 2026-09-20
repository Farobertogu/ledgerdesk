/** One directed regression in the retained build copy, never the working tree. */
export function workspaceFaultCopy(relative, source, variant) {
  if (variant !== 'omit-post-response-session') throw Error('WORKSPACE_MUTATION_SCOPE');
  if (relative !== 'src/components/intake/client.ts') return source;
  const anchor = '    await verifySessionForView(this.transport.terminalOrigin, expected, scope.signal, assertContext, this.fetcher);';
  if (source.split(anchor).length !== 3) throw Error('WORKSPACE_POST_SESSION_ANCHOR');
  const position = source.lastIndexOf(anchor);
  return source.slice(0, position) + '    // Deliberate captured-copy removal of the post-response session check.' + source.slice(position + anchor.length);
}
