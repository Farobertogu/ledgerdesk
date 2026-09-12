import { spawn } from 'node:child_process';

// Both trial runners use these actual data listeners. Tests feed these listeners
// explicitly: child writes do not establish the parent's stream chunk boundaries.
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

export async function runProcess(executable, args, { cwd, outputBytes, timeoutMs, diagnosticBytes = 8192 }) {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? '', WINDIR: process.env.WINDIR ?? '', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const collector = collectProcessOutput(child.stdout, child.stderr, { outputBytes, diagnosticBytes, stop: () => child.kill() });
    const timer = setTimeout(() => collector.terminate('worker_timeout'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, ...collector.finish(), milliseconds: performance.now() - start, pid: child.pid, executable, args });
    });
  });
}
