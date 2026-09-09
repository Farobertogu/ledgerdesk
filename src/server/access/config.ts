import {
  accessSecurity,
  type AccessSecurity,
} from '../../contracts/access_security.ts';
import {
  sessionTransport,
  type SessionTransport,
} from '../../contracts/access_transport.ts';

export type AccessConfig = Readonly<{
  profile: 'access-runtime/1';
  synthetic: true;
  transport: SessionTransport;
  security: AccessSecurity;
  connectionString: string;
  expectedPort: number;
  digestKey: string;
}>;
export function accessConfig(input: AccessConfig): AccessConfig {
  if (
    !input ||
    input.profile !== 'access-runtime/1' ||
    input.synthetic !== true ||
    Object.keys(input).sort().join(',') !==
      'connectionString,digestKey,expectedPort,profile,security,synthetic,transport' ||
    !/^[a-f0-9]{64}$/.test(input.digestKey)
  )
    throw new Error('INVALID_ACCESS_CONFIG');
  const url = new URL(input.connectionString);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.username !== 'inc02_runtime' ||
    url.pathname !== '/inc02_synthetic' ||
    !url.password ||
    url.search ||
    url.hash ||
    !Number.isInteger(input.expectedPort) ||
    input.expectedPort < 1024 ||
    input.expectedPort > 65535 ||
    Number(url.port) !== input.expectedPort
  )
    throw new Error('INVALID_ACCESS_DATABASE');
  return Object.freeze({
    ...input,
    transport: sessionTransport(input.transport),
    security: accessSecurity(input.security),
  });
}
