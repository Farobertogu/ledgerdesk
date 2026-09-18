// Adopted from the pinned T01 collector; the producer-process wrapper is not reused.
// Source SHA-256: 9e9bc35490000ebadc44512021d0df6aaa7365af2a6a55f4eee814a01646e6f9.
export function collectProcessOutput(stdout, stderr, { outputBytes, diagnosticBytes = 8192, stop = () => {} }) {
  const out = []; const err = [];
  let received = 0; let retained = 0; let diagnosticReceived = 0; let diagnosticRetained = 0; let reason;
  const terminate = cause => {
    if (reason === undefined) { reason = cause; stop(); }
  };
  stdout.on('data', chunk => {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Collector requires undecoded byte chunks');
    received += chunk.length;
    const keep = Math.min(chunk.length, Math.max(0, outputBytes - retained));
    if (keep) { out.push(Buffer.from(chunk.subarray(0, keep))); retained += keep; }
    if (received > outputBytes) terminate('output_limit');
  });
  stderr.on('data', chunk => {
    if (!Buffer.isBuffer(chunk)) throw new TypeError('Collector requires undecoded byte chunks');
    diagnosticReceived += chunk.length;
    const keep = Math.min(chunk.length, Math.max(0, diagnosticBytes - diagnosticRetained));
    if (keep) { err.push(Buffer.from(chunk.subarray(0, keep))); diagnosticRetained += keep; }
  });
  return {
    terminate,
    retainedStdout() { return Buffer.concat(out, retained); },
    finish() {
      let text = ''; let diagnostic = ''; let stdoutEncodingError = false; let stderrEncodingError = false;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(out, retained)); }
      catch { stdoutEncodingError = true; if (reason === undefined) reason = 'invalid_output_utf8'; }
      try { diagnostic = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(err, diagnosticRetained)); }
      catch { stderrEncodingError = true; }
      return { reason, stdout: text, stderr: diagnostic, stdoutBytes: received, stdoutRetainedBytes: retained,
        stderrBytes: diagnosticReceived, stderrRetainedBytes: diagnosticRetained,
        stderrTruncated: diagnosticReceived > diagnosticRetained, stdoutEncodingError, stderrEncodingError };
    }
  };
}
