import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Prepare only the owned, verified copy for the worker's single read-only file mount. */
export async function grantOriginalCopy(directory, expected) {
  const parent = await fs.lstat(directory), original = path.join(directory, 'original');
  const file = await fs.lstat(original);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !file.isFile() || file.isSymbolicLink())
    throw Error('EXTRACTION_COPY_TYPE');
  if (process.platform !== 'win32' && ((parent.mode & 0o777) !== 0o700 ||
    parent.uid !== process.getuid() || file.uid !== process.getuid())) throw Error('EXTRACTION_COPY_OWNER');
  const bytes = await fs.readFile(original);
  if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)
    throw Error('EXTRACTION_BRIDGE_ORIGINAL');
  // Host traversal remains owner-only (0700). The worker receives this file,
  // never the directory. Do not chmod the conserved original or any sibling.
  await fs.chmod(original, 0o444);
  return original;
}
