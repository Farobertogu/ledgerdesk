import { hash, verify, parseOptions } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { TRIAL_PASSWORD_OPTIONS } from '../../contracts/access_security.ts';

export class PasswordBusy extends Error {}
/** Finite work admission, including the unknown-account path. No queue of passwords. */
export class PasswordVerifier {
  private active = 0;
  private decoy = '';
  async initialize() {
    this.decoy = await hash(
      randomBytes(32).toString('base64url'),
      TRIAL_PASSWORD_OPTIONS,
    );
  }
  valid(encoded: string): boolean {
    if (
      !/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(
        encoded,
      )
    )
      return false;
    try {
      const parsed = parseOptions(encoded);
      return Object.entries({ ...TRIAL_PASSWORD_OPTIONS, saltLen: 16 }).every(
        ([k, v]) => parsed[k as keyof typeof parsed] === v,
      );
    } catch {
      return false;
    }
  }
  private async work<T>(password: string, fn: () => Promise<T>): Promise<T> {
    if (
      !password ||
      [...password].length > 1024 ||
      Buffer.byteLength(password) > 4096
    )
      throw new Error('PASSWORD_BOUND');
    if (this.active >= 2) throw new PasswordBusy('PASSWORD_BUSY');
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
  async create(password: string) {
    return this.work(password, () => hash(password, TRIAL_PASSWORD_OPTIONS));
  }
  async matches(encoded: string | null, password: string): Promise<boolean> {
    if (!this.decoy) throw new Error('PASSWORD_NOT_READY');
    const supported = encoded !== null && this.valid(encoded);
    const matched = await this.work(password, () =>
      verify(supported ? encoded : this.decoy, password),
    );
    return supported && matched;
  }
}
