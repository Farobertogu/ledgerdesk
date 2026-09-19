import {IntakeFailure} from '../protocol.ts';
import type {IntakeStore} from '../postgres/store.ts';
import type {Production} from './producer.ts';
import {byteDigest, same, verifyPreparation, type PreparedRecord, type Row} from './records.ts';
import {readPreparationPayload, type Exact} from '../../../contracts/intake_preparation.ts';

/** The caller owns current admission and the transaction; this module never commits. */
export async function persistPreparation(db: IntakeStore, attempt: Row, produced: Production) {
  const {record, bytes, resources} = produced, descriptor = record.descriptor;
  if (!verifyPreparation(record, bytes) || record.reference.id !== attempt.preparation_id ||
    record.reference.revision !== attempt.revision || descriptor.payload.id !== attempt.artifact_id)
    throw new IntakeFailure(503);
  await db.query(`INSERT INTO $INTAKE.preparation
    (id,revision,attempt_id,principal,context,sha256,descriptor,artifact_id,generation,bytes,payload_sha256,payload,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [record.reference.id, record.reference.revision, attempt.id, attempt.principal, attempt.context, record.reference.sha256,
      descriptor, descriptor.payload.id, descriptor.payload.generation, bytes.length, descriptor.payload.sha256, bytes, descriptor.recorded_at]);
  for (const resource of resources) {
    const r = resource.artifact;
    if (resource.bytes.length !== r.bytes || byteDigest(resource.bytes) !== r.sha256) throw new IntakeFailure(503);
    const retained = (await db.query('SELECT id,generation,bytes,sha256 FROM $INTAKE.preparation_resource WHERE id=$1 AND generation=$2', [r.id, r.generation])).rows[0];
    if (retained && !same(retained, r)) throw new IntakeFailure(409);
    if (!retained) await db.query('INSERT INTO $INTAKE.preparation_resource VALUES($1,$2,$3,$4,$5)', [r.id, r.generation, r.bytes, r.sha256, resource.bytes]);
  }
  for (const association of record.payload.resource_associations) {
    const r = association.artifact;
    await db.query('INSERT INTO $INTAKE.preparation_resource_association VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [record.reference.id, record.reference.revision, association.local_id, association.element_id, r.id, r.generation, r.bytes, r.sha256]);
  }
  for (const difference of record.differences) await db.query('INSERT INTO $INTAKE.preparation_difference VALUES($1,$2,$3,$4,$5,$6)',
    [difference.reference.id, difference.reference.revision, difference.reference.sha256, record.reference.id, record.reference.revision, difference.body]);
  await db.query("SELECT $INTAKE.advance_preparation_attempt($1,'staged','finalized')", [attempt.id]);
}

/** Control metadata only. No payload, difference body or selected resource is read here. */
export async function preparationMetadata(db: IntakeStore, id: string, revision: number) {
  return (await db.query(`SELECT p.id,p.revision,p.principal,p.context,p.sha256,p.artifact_id,p.generation,p.bytes,p.payload_sha256,
    EXISTS(SELECT 1 FROM $INTAKE.preparation_difference d WHERE d.preparation_id=p.id AND d.preparation_revision=p.revision) AS has_differences
    FROM $INTAKE.preparation p WHERE p.id=$1 AND p.revision=$2`, [id, revision])).rows[0] ?? null;
}

/** Requires a fresh admitted read and its durable evidence before invocation. */
export async function materializePreparation(db: IntakeStore, expected: Exact): Promise<{record: PreparedRecord; bytes: Buffer}> {
  const row = (await db.query('SELECT * FROM $INTAKE.preparation WHERE id=$1 AND revision=$2 AND sha256=$3',
    [expected.id, expected.revision, expected.sha256])).rows[0];
  if (!row) throw new IntakeFailure(404);
  const bytes = Buffer.from(row.payload), payload = readPreparationPayload(bytes);
  const differences = (await db.query('SELECT id,revision,sha256,body FROM $INTAKE.preparation_difference WHERE preparation_id=$1 AND preparation_revision=$2',
    [expected.id, expected.revision])).rows.map(d => ({reference: {id: d.id, revision: d.revision, sha256: d.sha256}, body: d.body}));
  const ordered = row.descriptor.differences.map((reference: Exact) => differences.find(d => same(d.reference, reference)));
  if (ordered.some((d: unknown) => !d) || ordered.length !== differences.length) throw new IntakeFailure(503);
  const record: PreparedRecord = {profile: 'prepared-material/2', reference: expected, descriptor: row.descriptor, payload, differences: ordered};
  if (!verifyPreparation(record, bytes) || !same(row.descriptor.payload,
    {id: row.artifact_id, generation: row.generation, bytes: row.bytes, sha256: row.payload_sha256})) throw new IntakeFailure(503);
  const associations = (await db.query(`SELECT local_id,element_id,resource_id,resource_generation,resource_bytes,resource_sha256
    FROM $INTAKE.preparation_resource_association WHERE preparation_id=$1 AND preparation_revision=$2`, [expected.id, expected.revision])).rows;
  if (associations.length !== payload.resource_associations.length || associations.some(a => !payload.resource_associations.some((x: Row) =>
    x.local_id === a.local_id && x.element_id === a.element_id && same(x.artifact,
      {id: a.resource_id, generation: a.resource_generation, bytes: a.resource_bytes, sha256: a.resource_sha256})))) throw new IntakeFailure(503);
  return {record, bytes};
}
