import { exactReference, identifier, revision } from '../../contracts/intake.ts';
import type { ExactReference } from '../../contracts/intake_reception.ts';

export type IntakeRole = 'inc03_intake_runtime' | 'inc03_intake_reader';
export type IntakeConfig = Readonly<{
  profile: 'intake-runtime/1'; synthetic: true; enabled: true;
  connectionString: string; readerConnectionString: string; expectedPort: number;
  deployment: 'inc02-synthetic'; namespace: 'intake_trial' | 'intake_restore';
  controlSource: string; incarnation: string; generation: number;
  catalog: ExactReference; configuration: ExactReference; limits: ExactReference;
  brokerSocket: string; verifierSocket: string; digestKeyVersion: 1;
  extraction?: 'intake-execution/1';
}>;
export const RECEPTION_BOUNDS = Object.freeze({
  originalBytes: 1048576, commandBytes: 65536, chunkBytes: 65536,
  idleMs: 5000, transferMs: 10000, verifierMs: 10000, objectCallMs: 1000,
  receptions: 32, attempts: 3, storageBytes: 67108864, concurrentUploads: 1,
});
export function intakeConnection(value: string, role: IntakeRole, port: number): void {
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/inc02_synthetic' || url.username !== role || !url.password ||
      url.search || url.hash || Number(url.port) !== port) throw Error('INTAKE_DATABASE_IDENTITY');
}
/** Trusted launch configuration, never a route parameter or restored payload. */
export function intakeConfig(input: IntakeConfig): IntakeConfig {
  if (!input || Object.keys(input).filter(key=>key!=='extraction').sort().join(',') !==
      'brokerSocket,catalog,configuration,connectionString,controlSource,deployment,digestKeyVersion,enabled,expectedPort,generation,incarnation,limits,namespace,profile,readerConnectionString,synthetic,verifierSocket' ||
      input.profile !== 'intake-runtime/1' || input.synthetic !== true || input.enabled !== true ||
      (Object.hasOwn(input,'extraction')&&input.extraction!=='intake-execution/1') ||
      input.deployment !== 'inc02-synthetic' || !['intake_trial', 'intake_restore'].includes(input.namespace) ||
      !identifier(input.controlSource) || !identifier(input.incarnation) || !revision(input.generation) ||
      input.digestKeyVersion !== 1 || ![input.catalog, input.configuration, input.limits].every(exactReference) ||
      !Number.isInteger(input.expectedPort) || input.expectedPort < 1024 || input.expectedPort > 65535 ||
      input.brokerSocket !== '/run/intake-t02/objects/channel.sock' ||
      input.verifierSocket !== '/run/intake-t02/verifier/channel.sock') throw Error('INVALID_INTAKE_CONFIG');
  intakeConnection(input.connectionString, 'inc03_intake_runtime', input.expectedPort);
  intakeConnection(input.readerConnectionString, 'inc03_intake_reader', input.expectedPort);
  return Object.freeze({ ...input, catalog: Object.freeze({ ...input.catalog }),
    configuration: Object.freeze({ ...input.configuration }), limits: Object.freeze({ ...input.limits }) });
}
