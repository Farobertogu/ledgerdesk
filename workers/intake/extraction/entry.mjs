import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  EXTRACTION_BOUNDS, WORKER_PROTOCOL, readWorkerRequest, readWorkerReply,
} from '../../../src/contracts/intake_extraction.ts';
import { extract } from './adapter.mjs';

const formats = Object.freeze({
  'text-utf8/1': 'text', 'markdown-inert/1': 'text',
  'csv-utf8/1': 'csv', 'xlsx-cells/1': 'xlsx',
});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Request bytes are collected before strict decoding, including split multibyte characters.
export async function readCommand(stream) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => stream.destroy(Object.assign(new Error('request_timeout'), { code: 'request_timeout' })), EXTRACTION_BOUNDS.wallMs);
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) fail('request_not_bytes');
      size += chunk.length;
      if (size > EXTRACTION_BOUNDS.commandBytes) fail('request_limit');
      chunks.push(chunk);
    }
    return readWorkerRequest(Buffer.concat(chunks, size));
  } finally { clearTimeout(timer); }
}

// This is the only original-file path. Neither the request nor the environment selects it.
async function originalBytes(binding) {
  const handle = await fs.open('/input/original', constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== binding.original.bytes) fail('input_identity_mismatch');
    const buffer = Buffer.alloc(binding.original.bytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const bytes = buffer.subarray(0, size);
    if (size !== binding.original.bytes || digest(bytes) !== binding.original.sha256) fail('input_identity_mismatch');
    return bytes;
  } finally { await handle.close(); }
}

export function producerCode(error) {
  // Never return a parser message, stack, filename, content or arbitrary exception object.
  // Unrecognized structured codes remain unrecognized; no diagnosis is inferred from them.
  return typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code) ? error.code : 'unknown';
}

export function encodeReply(binding, outcome) {
  const reply = { profile: WORKER_PROTOCOL, kind: 'result', binding, outcome };
  let bytes = Buffer.from(JSON.stringify(reply) + '\n');
  if (bytes.length > EXTRACTION_BOUNDS.stdoutBytes) {
    reply.outcome = { kind: 'failed', producer_code: 'output_limit' };
    bytes = Buffer.from(JSON.stringify(reply) + '\n');
  }
  if (bytes.length > EXTRACTION_BOUNDS.stdoutBytes) fail('reply_limit');
  readWorkerReply(bytes);
  return bytes;
}

export async function main() {
  if (process.version !== 'v22.16.0' || process.argv.length !== 2) {
    process.stderr.write('worker_invocation_rejected\n');
    process.exitCode = 2;
    return;
  }
  let request;
  try { request = await readCommand(process.stdin); }
  catch {
    process.stderr.write('worker_request_rejected\n');
    process.exitCode = 2;
    return;
  }
  let outcome;
  try {
    const bytes = await originalBytes(request.binding);
    const observation = await extract(bytes, formats[request.binding.format_profile]);
    outcome = { kind: 'produced', observation };
  } catch (error) { outcome = { kind: 'failed', producer_code: producerCode(error) }; }
  try {
    const reply = encodeReply(request.binding, outcome);
    await new Promise((resolve, reject) => process.stdout.write(reply, error => error ? reject(error) : resolve()));
  } catch {
    process.stderr.write('worker_reply_failed\n');
    process.exitCode = 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
