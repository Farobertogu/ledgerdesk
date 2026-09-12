import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const fail = code => { throw new Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
// Resource IDs occupy their own trial-local, case-sensitive string namespace.
// Do not trim, normalize, coerce or silently deduplicate opaque identities.
const validResourceId = id => typeof id === 'string' && id.length > 0 && id.isWellFormed() && !/[\u0000-\u0020\u007f]/u.test(id);
export async function consumeCandidate(envelope, readResource) {
  if (envelope.schema !== 'candidate-trial/1') fail('unsupported_schema');
  const { candidate, preparation, canonical } = envelope;
  if (!candidate || !preparation || !canonical || candidate.preparationId !== preparation.id || candidate.preparationRevision !== preparation.revision) fail('preparation_mismatch');
  if (candidate.canonicalSha256 !== hash(JSON.stringify(canonical))) fail('canonical_integrity');
  const ids = new Set(canonical.elements.map(e => e.id));
  if (ids.size !== canonical.elements.length) fail('duplicate_element');
  if (!Array.isArray(candidate.selected) || new Set(candidate.selected).size !== candidate.selected.length || candidate.selected.length !== ids.size || candidate.selected.some(id => !ids.has(id))) fail('selection_mismatch');
  for (const link of canonical.relations) {
    if (!ids.has(link.from) || !ids.has(link.to) || !link.scope || !link.basis || link.preparationRevision !== preparation.revision) fail('unresolved_relation');
  }
  if (!Array.isArray(canonical.resources)) fail('invalid_resource_catalog');
  const resourceIds = new Set();
  for (const resource of canonical.resources) {
    if (!resource || !validResourceId(resource.id)) fail('invalid_resource_id');
    if (resourceIds.has(resource.id)) fail('duplicate_resource');
    resourceIds.add(resource.id);
    if (!/^[A-Za-z0-9_.-]+$/.test(resource.file)) fail('unsafe_resource_path');
  }
  for (const element of canonical.elements) {
    if (Object.hasOwn(element, 'resource') && (!validResourceId(element.resource) || !resourceIds.has(element.resource))) fail('missing_resource');
  }
  const resources = [];
  for (const resource of canonical.resources) {
    const bytes = await readResource(resource.file);
    if (bytes.length !== resource.bytes || hash(bytes) !== resource.sha256) fail('resource_integrity');
    resources.push({ id: resource.id, bytes: bytes.length, sha256: hash(bytes), content: bytes.toString('utf8') });
  }
  return { ok: true, processId: process.pid, unit: candidate.unit, version: candidate.version, preparationRevision: preparation.revision, elements: canonical.elements, relations: canonical.relations, resources };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [packagePath] = process.argv.slice(2);
    const envelope = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    const result = await consumeCandidate(envelope, file => fs.readFile(path.join(path.dirname(packagePath), file)));
    process.stdout.write(JSON.stringify(result));
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message })); }
}
