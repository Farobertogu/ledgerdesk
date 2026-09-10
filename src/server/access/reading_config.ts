export type AuthenticatedReadingConfig = Readonly<{
  connectionString: string; expectedPort: number; generation: string;
  cursorSeconds: number; cursorLimit: number; pageSize: number;
}>;
export function authenticatedReadingConfig(value: AuthenticatedReadingConfig): AuthenticatedReadingConfig {
  if (!value || Object.keys(value).sort().join(',') !== 'connectionString,cursorLimit,cursorSeconds,expectedPort,generation,pageSize') throw new Error('READING_CONFIG');
  const u = new URL(value.connectionString);
  if (u.protocol !== 'postgresql:' || u.hostname !== '127.0.0.1' || u.username !== 'inc02_reader' ||
      u.pathname !== '/inc02_synthetic' || !u.password || u.search || u.hash ||
      !Number.isInteger(value.expectedPort) || value.expectedPort < 1024 || value.expectedPort > 65535 ||
      Number(u.port) !== value.expectedPort || !/^[A-Za-z0-9_-]{16,128}$/.test(value.generation) ||
      !Number.isInteger(value.cursorSeconds) || value.cursorSeconds < 1 || value.cursorSeconds > 300 ||
      !Number.isInteger(value.cursorLimit) || value.cursorLimit < 1 || value.cursorLimit > 100 ||
      !Number.isInteger(value.pageSize) || value.pageSize < 1 || value.pageSize > 100) throw new Error('READING_CONFIG');
  return Object.freeze({ ...value });
}
