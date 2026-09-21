import {array, artifactReference, choice, closed, digest, exactReference, identifier, record, text} from '../../contracts/intake.ts';

export const JOURNAL_KEY = 'ledgerdesk.intake.locators.v1';
export const JOURNAL_LIMITS = Object.freeze({entries: 128, bytes: 65536});
export type JournalEnvironment = Readonly<{deployment: string; uiOrigin: string; terminalOrigin: string}>;
export type JournalOperation = 'reserve_reception' | 'upload_original' | 'finalize_reception' | 'cancel_reception' |
  'reserve_preparation' | 'upload_preparation' | 'finalize_preparation' | 'propose' | 'constitute';
type Reference = {id: string; revision: number; sha256: string};
type Artifact = {id: string; generation: number; bytes: number; sha256: string};
export type JournalEntry = Readonly<{
  id: string; itemKey: string; operation: JournalOperation; profile: 'intake-reception/2' | 'intake-preparation/1';
  key: string | null; fingerprint: string;
  references: Readonly<{operationId?: string; receptionId?: string; attemptId?: string;
    original?: Artifact; document?: Artifact; preparation?: Reference; proposal?: Reference}>;
}>;
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
const environmentRule = closed({deployment: identifier, uiOrigin: text(256), terminalOrigin: text(256)});
const referencesRule = closed({}, {operationId: identifier, receptionId: identifier, attemptId: identifier,
  original: artifactReference, document: artifactReference, preparation: exactReference, proposal: exactReference});
const entryRule = closed({id: identifier, itemKey: identifier,
  operation: choice('reserve_reception', 'upload_original', 'finalize_reception', 'cancel_reception',
    'reserve_preparation', 'upload_preparation', 'finalize_preparation', 'propose', 'constitute'),
  profile: choice('intake-reception/2', 'intake-preparation/1'),
  key: value => value === null || identifier(value), fingerprint: digest, references: referencesRule});
const journalRule = closed({profile: choice('intake-journal/1'), environment: environmentRule,
  entries: array(entryRule, JOURNAL_LIMITS.entries)});
const equalEnvironment = (a: JournalEnvironment, b: JournalEnvironment) =>
  a.deployment === b.deployment && a.uiOrigin === b.uiOrigin && a.terminalOrigin === b.terminalOrigin;

/** A bounded locator, never credentials, payload retention, authority or a retry queue. */
export class IntakeJournal {
  readonly environment: JournalEnvironment;
  readonly storage: StoragePort;
  constructor(storage: StoragePort, environment: JournalEnvironment) {
    if (!environmentRule(environment)) throw Error('Invalid journal environment.');
    this.storage = storage; this.environment = Object.freeze({...environment});
  }
  read(): readonly JournalEntry[] {
    const raw = this.storage.getItem(JOURNAL_KEY);
    if (raw === null) return [];
    if (new TextEncoder().encode(raw).length > JOURNAL_LIMITS.bytes) throw Error('Recovery journal exceeds its limit.');
    let decoded: unknown; try {decoded = JSON.parse(raw);} catch {throw Error('Recovery journal cannot be read.');}
    if (!journalRule(decoded) || !record(decoded)) throw Error('Recovery journal has an unsupported shape.');
    const value = decoded as {environment: JournalEnvironment; entries: JournalEntry[]};
    if (!equalEnvironment(value.environment, this.environment)) throw Error('Recovery journal belongs to another environment.');
    if (new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) throw Error('Recovery journal contains duplicate locators.');
    return structuredClone(value.entries);
  }
  retain(entry: JournalEntry): void {
    if (!entryRule(entry)) throw Error('Invalid recovery locator.');
    const entries = [...this.read()], position = entries.findIndex(row => row.id === entry.id);
    if (position < 0) entries.push(structuredClone(entry));
    else {
      const prior = entries[position];
      if (prior.itemKey !== entry.itemKey || prior.operation !== entry.operation || prior.profile !== entry.profile ||
        prior.key !== entry.key || prior.fingerprint !== entry.fingerprint) throw Error('An existing intention cannot be replaced.');
      entries[position] = structuredClone(entry);
    }
    if (entries.length > JOURNAL_LIMITS.entries) throw Error('Recovery journal is full. Reconcile pending work first.');
    const body = JSON.stringify({profile: 'intake-journal/1', environment: this.environment, entries});
    if (new TextEncoder().encode(body).length > JOURNAL_LIMITS.bytes) throw Error('Recovery journal is full.');
    // Fail before dispatch when storage is denied or cannot retain the exact locator.
    this.storage.setItem(JOURNAL_KEY, body);
    if (this.storage.getItem(JOURNAL_KEY) !== body) throw Error('Recovery locator could not be retained. No new request was sent.');
  }
}
