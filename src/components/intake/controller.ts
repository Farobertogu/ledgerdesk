import type {SessionTransport} from '../../contracts/access_transport.ts';
import {canonicalValue} from '../../contracts/access_canonical.ts';
import {BINDINGS} from '../../contracts/intake_bindings.ts';
import {INTAKE_ROUTES, INTAKE_LIMITS, canonicalIntake, intakePath, scalarText, type IntakeRoute} from '../../contracts/intake.ts';
import {RECEPTION_V2_ACCEPT} from '../../contracts/intake_extraction.ts';
import {RECEPTION_RESPONSE} from '../../contracts/intake_reception.ts';
import {RECEPTION_RESPONSE_V2, type ReceptionV2} from '../../contracts/intake_reception_v2.ts';
import {WORKSPACE_ACCEPT, WORKSPACE_PROFILE, validateWorkspaceResponse} from '../../contracts/intake_workspace.ts';
import {PREPARATION_BOUNDS, preparationCanonical, validatePreparationCommand, type PreparationRoute} from '../../contracts/intake_preparation.ts';
import {validatePreparationResponse} from '../../contracts/intake_preparation_response.ts';
import {StaleView} from '../access/view_lifecycle.ts';
import {IntakeClient, IntakeRequestFailure, capturedTextBytes, sha256} from './client.ts';
import {IntakeJournal, type JournalEntry, type JournalOperation} from './journal.ts';
import {componentObservations, elementChoices, emptyPreparationDraft, preparationDocument, preparedInspection, proposalInspection} from './preparation.ts';
import {receptionStatus, extractionStatus, recoveredPreparationStatus, rejectedReceptionStatus} from './status.ts';
import type {ArtifactReference, ExactReference, ContextView, ElementChoice, InspectionBlock, InspectorViewProps, ConfirmationViewProps, IntakeProfile, ItemAction, ItemKey, ItemView, Notice, PreparationDraft, PreparationEdit, ProfileView, ProposalDraft, TextDraft} from './view_model.ts';

type Wire = Record<string, any>;
type LocalItem = {view: ItemView; bytes: Uint8Array | null; media: string; digest: string | null; receipt: ReceptionV2 | null;
  extraction?: Wire; preparationDraft?: PreparationDraft; prepared?: Wire; proposalDraft?: ProposalDraft; proposalUnit?: string;
  proposalInspection?: Wire; staged?: Wire; outcome?: ConfirmationViewProps['outcome']};
type InspectionState = Pick<InspectorViewProps, 'subject'|'reference'|'blocks'|'observations'|'differences'|'originalDownloadOffered'|'proposal'>;
type ConfirmationState = Pick<ConfirmationViewProps, 'proposal'|'preparation'|'blocks'|'observations'|'differences'|'confirmOffered'|'outcome'>;
export type WorkspaceSnapshot = Readonly<{
  phase: 'checking_session' | 'ready' | 'unavailable'; context: ContextView | null;
  profiles: readonly ProfileView[]; items: readonly ItemView[]; selectedKey: ItemKey | null;
  notices: readonly Notice[]; textDraft: TextDraft; intakeOffered: boolean; busy: boolean;
  page: 'intake' | 'detail' | 'editor' | 'inspector' | 'confirmation';
  inspector: InspectionState | null; confirmation: ConfirmationState | null;
  editor: Readonly<{draft: PreparationDraft; elements: readonly ElementChoice[]; antecedent: Wire; saveOffered: boolean; discardOffered: boolean}> | null;
}>;
const formats: Record<IntakeProfile, {label: string; media: string}> = {
  'text-utf8/1': {label: 'UTF-8 text', media: 'text/plain'},
  'markdown-inert/1': {label: 'Inert Markdown', media: 'text/markdown'},
  'csv-utf8/1': {label: 'UTF-8 CSV', media: 'text/csv'},
  'xlsx-cells/1': {label: 'Bounded XLSX', media: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
};
const initial = (): WorkspaceSnapshot => ({phase: 'checking_session', context: null, profiles: [], items: [],
  selectedKey: null, notices: [], textDraft: {name: '', text: ''}, intakeOffered: false, busy: false, page: 'intake', editor: null, inspector: null, confirmation: null});
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

/** Sole business state owner. Views never read remote state or choose an authority. */
export class IntakeController {
  readonly client: IntakeClient;
  readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  private current: WorkspaceSnapshot = initial();
  private listeners = new Set<() => void>();
  private items = new Map<ItemKey, LocalItem>();
  private journal: IntakeJournal | null = null;
  private localEpoch = 0;
  private activityEpoch = 0;
  private pending = new Map<string, {entry: JournalEntry; body: string; parameters: Record<string, string>}>();
  constructor(transport: SessionTransport, storage: Pick<Storage, 'getItem' | 'setItem'>, fetcher: typeof fetch = fetch) {
    this.client = new IntakeClient(transport, fetcher); this.storage = storage;
  }
  snapshot = () => this.current;
  subscribe = (listener: () => void) => {this.listeners.add(listener); return () => {this.listeners.delete(listener);};};
  private publish(patch: Partial<WorkspaceSnapshot> = {}) {
    this.current = {...this.current, ...patch, items: [...this.items.values()].map(item => item.view)};
    for (const listener of this.listeners) listener();
  }
  private notice(text: string, tone: Notice['tone'] = 'info') {
    this.publish({notices: [{id: crypto.randomUUID(), text, tone}]});
  }
  private guard() {
    const epoch = this.localEpoch;
    return () => {if (epoch !== this.localEpoch) throw new DOMException('Context changed', 'AbortError');};
  }
  private changeContext() {
    this.localEpoch++; this.activityEpoch++; this.client.lifetime.reset();
    this.current = {...this.current, busy: false};
  }
  suspend = () => {
    this.changeContext(); this.client.suspend(); this.items.clear(); this.pending.clear(); this.journal = null;
    this.current = initial(); this.publish({phase: 'unavailable'});
  };
  private failure(error: unknown) {
    if (error instanceof StaleView) {this.suspend(); this.notice('The session changed. Refresh and explicitly reconcile retained operations.', 'warning');}
    else if (!isAbort(error)) this.notice(error instanceof Error ? error.message : 'The request could not be confirmed.', 'error');
  }
  start = async () => {
    const priorContext = this.current.context;
    this.changeContext(); const assertContext = this.guard(), activity = this.activityEpoch;
    this.publish({phase: 'checking_session', notices: [], intakeOffered: false, page: 'intake', editor: null, inspector: null, confirmation: null});
    try {
      if (!await this.client.session()) {this.suspend(); return;}
      assertContext();
      const result = await this.client.request({path: '/api/intake/profiles', accept: WORKSPACE_ACCEPT, maximum: 65536,
        assertContext, validate: value => validateWorkspaceResponse('context', value)});
      const body = result.value as Wire;
      const context: ContextView = {scopeId: body.context.scope_id, purposeId: body.context.purpose_id, treatment: body.context.treatment_revision};
      const journal = new IntakeJournal(this.storage, {deployment: body.deployment,
        uiOrigin: this.client.transport.uiOrigin, terminalOrigin: this.client.transport.terminalOrigin});
      const entries = journal.read(); this.journal = journal;
      // Refresh revalidates context, not each retained object's reading authority.
      // Keep only unsent local originals in the unchanged context; protected
      // projections return as locators requiring an explicit admitted query.
      const sameContext = priorContext === null || canonicalValue(priorContext) === canonicalValue(context);
      for (const [key, item] of this.items) if (item.view.phase !== 'draft' || !sameContext) this.items.delete(key);
      if (!sameContext) this.pending.clear();
      for (const entry of entries) if (!this.items.has(entry.itemKey)) this.items.set(entry.itemKey, {
        bytes: null, media: '', digest: null, receipt: null,
        view: {key: entry.itemKey, name: 'Recovered operation', capture: 'recovered', profile: null, bytes: null,
          phase: 'uncertain', detail: 'Only recovery locators survived. Reconcile under the current session before continuing.',
          actions: ['reconcile'], observations: [], receipt: null, preparation: null, proposal: null},
      });
      this.publish({phase: 'ready', context, selectedKey: null, ...(sameContext ? {} : {textDraft: {name: '', text: ''}}), intakeOffered: body.offers.includes('receive'),
        profiles: body.availability.profiles.map((row: Wire) => ({id: row.format_profile,
          label: formats[row.format_profile as IntakeProfile].label, mediaType: formats[row.format_profile as IntakeProfile].media,
          maximumBytes: row.original_bytes, receptionAvailable: row.reception_available, extractionAvailable: row.processing_available})),
        notices: entries.length ? [{id: 'recovery', tone: 'info', text: 'Recovered locators are not authority. No operation was repeated.'}] : []});
    } catch (error) {
      if (activity !== this.activityEpoch || isAbort(error)) return;
      this.suspend(); this.failure(error);
    }
  };
  select = (key: ItemKey) => {if (!this.items.has(key)) return; this.changeContext(); this.publish({selectedKey: key, page: 'detail', inspector: null, editor: null, confirmation: null});};
  openIntake = () => {this.changeContext(); this.publish({page: 'intake', inspector: null, editor: null, confirmation: null});};
  setTextDraft = (textDraft: TextDraft) => {this.publish({textDraft: {...textDraft}});};
  setProfile = (key: ItemKey, profile: IntakeProfile) => {
    const item = this.items.get(key);
    if (!item || !item.view.actions.includes('receive') || !this.current.profiles.some(p => p.id === profile && p.receptionAvailable)) return;
    item.view = {...item.view, profile}; item.media = formats[profile].media; this.publish();
  };
  private add(name: string, bytes: Uint8Array, capture: 'file' | 'text', profile: IntakeProfile | null, media: string) {
    if (!scalarText(name) || name.length > 256) throw Error('The original name exceeds its supported limit.');
    if (bytes.length > INTAKE_LIMITS.originalBytes) throw Error('The original exceeds the supported byte limit.');
    const key = crypto.randomUUID();
    this.items.set(key, {bytes, media, digest: null, receipt: null, view: {key, name, capture, profile, bytes: bytes.length,
      phase: 'draft', detail: capture === 'text' ? 'Exact UTF-8 bytes captured from this field; not the bytes of an earlier clipboard source.' : 'Original bytes retained in memory until reception.',
      actions: ['receive', 'discard'], observations: [], receipt: null, preparation: null, proposal: null}});
    this.publish({selectedKey: key});
  }
  addFiles = async (files: readonly File[]) => {
    if (!this.current.intakeOffered || this.current.busy) return;
    const assertContext = this.guard();
    for (const file of files) {
      try {
        if (file.size > INTAKE_LIMITS.originalBytes) throw Error(`The selected file exceeds ${INTAKE_LIMITS.originalBytes} bytes.`);
        const bytes = new Uint8Array(await file.arrayBuffer()); assertContext();
        const extension = file.name.split('.').at(-1)?.toLowerCase();
        const hint: IntakeProfile | null = ({txt: 'text-utf8/1', md: 'markdown-inert/1', csv: 'csv-utf8/1', xlsx: 'xlsx-cells/1'} as const)[extension as 'txt'] ?? null;
        const profile = hint && this.current.profiles.some(p => p.id === hint && p.receptionAvailable) ? hint : null;
        this.add(file.name, bytes, 'file', profile, profile ? formats[profile].media : file.type);
      } catch (error) {this.failure(error); if (isAbort(error)) break;}
    }
  };
  captureText = () => {
    if (!this.current.intakeOffered || this.current.busy) return;
    try {this.add(this.current.textDraft.name, capturedTextBytes(this.current.textDraft.text), 'text', 'text-utf8/1', 'text/plain');}
    catch (error) {this.failure(error);}
  };
  private update(key: ItemKey, patch: Partial<ItemView>) {
    const item = this.items.get(key); if (!item) return;
    item.view = {...item.view, ...patch}; this.publish();
  }
  private async receptionRequest(route: IntakeRoute, parameters: Record<string, string>, body: Wire | Uint8Array | null,
    assertContext: () => void, clientKey?: string) {
    const upload = route === 'upload_original';
    const result = await this.client.request({path: intakePath(route, parameters), method: INTAKE_ROUTES[route].method,
      accept: upload ? 'application/json' : RECEPTION_V2_ACCEPT, contentType: upload ? 'application/octet-stream' : 'application/json',
      ...(body === null ? {} : {body: body instanceof Uint8Array ? body : JSON.stringify(body)}), key: clientKey,
      maximum: 65536, assertContext, validate: value => upload ? RECEPTION_RESPONSE(value) : RECEPTION_RESPONSE_V2(value)});
    return result.value as ReceptionV2;
  }
  private async receptionEffect(key: ItemKey, operation: JournalOperation & IntakeRoute, parameters: Record<string, string>, body: Wire, assertContext: () => void) {
    if (!this.journal) throw Error('Recovery storage is unavailable. No new request was sent.');
    const signature = canonicalIntake(operation, parameters, body, canonicalValue), fingerprint = await sha256(capturedTextBytes(signature));
    assertContext();
    const slot = key + ':' + operation, pending = this.pending.get(slot);
    if (pending && pending.entry.fingerprint !== fingerprint) throw Error('An earlier request is unresolved. Reconcile it before changing its payload.');
    const frozen = pending ?? {entry: {id: crypto.randomUUID(), itemKey: key, operation, profile: 'intake-reception/2' as const,
      key: crypto.randomUUID(), fingerprint, references: parameters.id ? {receptionId: parameters.id} : {}}, body: JSON.stringify(body), parameters: {...parameters}};
    this.journal.retain(frozen.entry); this.pending.set(slot, frozen);
    const value = await this.receptionRequest(operation, frozen.parameters, JSON.parse(frozen.body), assertContext, frozen.entry.key!);
    const learned = {...frozen.entry, references: {...frozen.entry.references, operationId: value.operation_id, receptionId: value.reception_id, original: value.original}};
    this.journal.retain(learned); this.pending.delete(slot);
    return value;
  }
  private adoptReceipt(key: ItemKey, receipt: ReceptionV2) {
    const item = this.items.get(key); if (!item) return;
    item.receipt = receipt;
    this.update(key, {...receptionStatus(receipt),
      profile: receipt.format_profile, bytes: receipt.original.bytes, receipt: receipt.effect,
      actions: ['refresh', 'reconcile']});
  }
  private async refreshItem(key: ItemKey, assertContext: () => void) {
    const item = this.items.get(key);
    if (!item?.receipt) throw Error('Reconcile the receipt first.');
    const result = await this.client.request({path: '/api/intake/receptions/' + item.receipt.reception_id,
      accept: WORKSPACE_ACCEPT, maximum: 65536, assertContext, validate: value => validateWorkspaceResponse('reception', value)});
    const body = result.value as Wire; this.adoptReceipt(key, body.reception);
    const actions: ItemAction[] = ['refresh', 'reconcile', ...(body.offers.includes('inspect_original') ? ['inspect_original' as const] : []),
      ...(body.offers.includes('stop') ? ['stop' as const] : [])];
    this.update(key, {actions});
    if (body.offers.includes('inspect_extraction') && body.reception.work?.extraction?.state === 'accepted') {
      const query = await this.client.request({path: '/api/intake/extractions/' + body.reception.work.id,
        accept: WORKSPACE_ACCEPT, maximum: PREPARATION_BOUNDS.responseBytes, assertContext,
        validate: value => validateWorkspaceResponse('extraction', value)});
      const projected = query.value as Wire;
      item.extraction = projected.extraction;
      const content = item.extraction?.result?.content;
      this.update(key, {...extractionStatus(item.extraction!.view, content),
        observations: content ? componentObservations(content) : [],
        actions: [...actions, ...(projected.offers.includes('prepare') ? ['prepare' as const] : [])]});
    }
  }
  private async originalBytes(key: ItemKey, assertContext: () => void) {
    const item = this.items.get(key);
    if (!item?.receipt || !item.view.actions.includes('inspect_original')) throw Error('Original delivery is not currently offered.');
    const reference = item.receipt.original;
    const response = await this.client.request({path: '/api/intake/receptions/' + item.receipt.reception_id + '/original',
      accept: 'application/octet-stream', maximum: INTAKE_LIMITS.originalBytes, assertContext});
    const digest = await sha256(response.bytes); assertContext();
    if (response.bytes.length !== reference.bytes || digest !== reference.sha256) throw Error('The delivered original does not match the retained reference.');
    return {bytes: response.bytes, reference, item};
  }
  private async inspectOriginal(key: ItemKey, assertContext: () => void) {
    const {bytes, reference, item} = await this.originalBytes(key, assertContext);
    const blocks: InspectionBlock[] = [{id: 'original-facts', title: 'Exact original', reference, kind: 'facts', fields: [
      {name: 'Bytes', value: String(reference.bytes)}, {name: 'SHA-256', value: reference.sha256},
    ]}];
    if (item.view.profile !== 'xlsx-cells/1') {
      try {blocks.push({id: 'original-text', title: 'Original text', reference, kind: 'text',
        text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes), coordinates: `Original bytes 0..${bytes.length}`});}
      catch {blocks.push({id: 'original-encoding', title: 'Text representation unavailable', reference, kind: 'facts',
        fields: [{name: 'Encoding', value: 'The exact bytes are retained. They were not replaced by lossy decoded text.'}]});}
    }
    assertContext(); this.publish({selectedKey: key, page: 'inspector', inspector: {subject: 'original', reference, blocks,
      observations: [], differences: [], originalDownloadOffered: true, proposal: null}, editor: null, confirmation: null});
  }
  downloadOriginal = async () => {
    const key = this.current.selectedKey;
    if (!key || this.current.busy || !this.current.inspector?.originalDownloadOffered) return;
    const assertContext = this.guard(), activity = ++this.activityEpoch; this.publish({busy: true, notices: []});
    try {
      const {bytes, item} = await this.originalBytes(key, assertContext);
      // An opaque download, never an executable preview or a remote resource URL.
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer], {type: 'application/octet-stream'}));
      try {const link = document.createElement('a'); link.href = url; link.download = item.view.name; link.click();}
      finally {setTimeout(() => URL.revokeObjectURL(url), 0);}
    } catch (error) {if (activity === this.activityEpoch) this.failure(error);}
    finally {if (activity === this.activityEpoch) this.publish({busy: false});}
  };
  private openPreparation(key: ItemKey) {
    const item = this.items.get(key);
    if (!item?.extraction?.result?.content || !item.view.actions.includes('prepare')) throw Error('Preparation is not currently offered.');
    item.preparationDraft ??= emptyPreparationDraft(); this.changeContext();
    this.publish({selectedKey: key, page: 'editor', editor: {draft: item.preparationDraft,
      elements: elementChoices(item.extraction), antecedent: item.extraction.result.effect, saveOffered: true,
      discardOffered: !this.journal?.read().some(entry => entry.itemKey === key && entry.profile === 'intake-preparation/1')}});
  }
  editPreparation = (edit: PreparationEdit) => {
    const key = this.current.selectedKey, item = key ? this.items.get(key) : null;
    if (!item?.preparationDraft || this.current.busy || this.current.page !== 'editor') return;
    let draft = item.preparationDraft;
    if (edit.kind === 'selection') draft = {...draft, selected: edit.selected ? [...new Set([...draft.selected, edit.elementId])] : draft.selected.filter(id => id !== edit.elementId)};
    else if (edit.kind === 'correction') {
      const corrections = {...draft.corrections}; if (edit.text === null) delete corrections[edit.elementId]; else corrections[edit.elementId] = edit.text;
      draft = {...draft, corrections};
    } else if (edit.kind === 'classification') draft = {...draft, classification: edit.value};
    else if (edit.kind === 'add_condition') draft = {...draft, conditions: [...draft.conditions, {id: crypto.randomUUID(), text: '', scope: ''}]};
    else if (edit.kind === 'condition') draft = {...draft, conditions: draft.conditions.map(c => c.id === edit.value.id ? edit.value : c)};
    else if (edit.kind === 'remove_condition') draft = {...draft, conditions: draft.conditions.filter(c => c.id !== edit.id)};
    else if (edit.kind === 'add_dependency') draft = {...draft, dependencies: [...draft.dependencies, {id: crypto.randomUUID(), from: '', to: '', required: true}]};
    else if (edit.kind === 'dependency') draft = {...draft, dependencies: draft.dependencies.map(c => c.id === edit.value.id ? edit.value : c)};
    else if (edit.kind === 'remove_dependency') draft = {...draft, dependencies: draft.dependencies.filter(c => c.id !== edit.id)};
    else if (edit.kind === 'examination') draft = {...draft, examination: edit.value};
    else if (edit.kind === 'coverage') draft = {...draft, coverage: edit.value};
    else if (edit.kind === 'change_reason') draft = {...draft, changeReason: edit.value};
    item.preparationDraft = structuredClone(draft);
    this.publish({editor: {...this.current.editor!, draft: item.preparationDraft}});
  };
  discardPreparation = () => {
    const key = this.current.selectedKey, item = key ? this.items.get(key) : null;
    if (!item || this.current.busy) return;
    if (key && this.journal?.read().some(e => e.itemKey === key && e.profile === 'intake-preparation/1')) {
      this.notice('A preparation operation is retained. Reconcile it; discarding a draft cannot undo it.', 'warning'); return;
    }
    delete item.preparationDraft; this.changeContext(); this.publish({page: 'detail', editor: null});
  };
  private async preparationEffect(key: ItemKey, operation: 'reserve_preparation' | 'finalize_preparation' | 'propose' | 'constitute', parameters: Record<string, string>, body: Wire, assertContext: () => void) {
    if (!validatePreparationCommand(operation, body)) throw Error('Complete the exact preparation request before sending it.');
    if (!this.journal) throw Error('Recovery storage is unavailable.');
    const signature = preparationCanonical(operation, parameters, body, canonicalValue), fingerprint = await sha256(capturedTextBytes(signature));
    assertContext(); const slot = key + ':' + operation, existing = this.pending.get(slot);
    if (existing && existing.entry.fingerprint !== fingerprint) throw Error('Reconcile the retained preparation before changing its payload.');
    const frozen = existing ?? {entry: {id: crypto.randomUUID(), itemKey: key, operation, profile: 'intake-preparation/1' as const,
      key: crypto.randomUUID(), fingerprint, references: {}}, body: JSON.stringify(body), parameters: {...parameters}};
    this.journal.retain(frozen.entry); this.pending.set(slot, frozen);
    const response = await this.preparationRequest(operation, frozen.parameters, frozen.body, assertContext, frozen.entry.key!);
    const learned = {...frozen.entry, references: {...frozen.entry.references,
      ...(response.result.attempt_id ? {attemptId: response.result.attempt_id, document: response.result.document} : {}),
      ...(['prepared', 'proposed'].includes(response.result.state) ? {preparation: response.result.preparation} : {}),
      ...(response.result.state === 'proposed' ? {proposal: response.result.proposal} : {})}};
    this.journal.retain(learned); this.pending.delete(slot); return response;
  }
  private async preparationRequest(operation: PreparationRoute, parameters: Record<string, string>, body: string | Uint8Array, assertContext: () => void, key?: string) {
    const response = await this.client.request({path: intakePath(operation, parameters), method: INTAKE_ROUTES[operation].method,
      accept: 'application/vnd.ledgerdesk.intake-preparation+json', contentType: body instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
      ...(INTAKE_ROUTES[operation].method === 'POST' ? {body} : {}), key, maximum: PREPARATION_BOUNDS.responseBytes, assertContext,
      validate: (value, status) => validatePreparationResponse(operation, status, value)});
    return response.value as Wire;
  }
  savePreparation = async () => {
    const key = this.current.selectedKey, item = key ? this.items.get(key) : null, context = this.current.context;
    if (!key || !item?.extraction || !item.preparationDraft || !context || this.current.busy || !this.current.editor?.saveOffered) return;
    const assertContext = this.guard(), activity = ++this.activityEpoch; this.publish({busy: true, notices: []});
    let effectStarted = false;
    try {
      const built = preparationDocument(item.extraction, item.preparationDraft), bytes = capturedTextBytes(JSON.stringify(built.document));
      const hash = await sha256(bytes); assertContext();
      const declaration = {profile: 'intake/1', representation: 'intake-preparation/1',
        inputs: built.inputs, base: null, selection: built.selection, document: {bytes: bytes.length, sha256: hash},
        context: {scope_id: context.scopeId, purpose_id: context.purposeId, treatment_revision: context.treatment}};
      if (!validatePreparationCommand('reserve_preparation', declaration)) throw Error('Complete the preparation declaration before sending it.');
      effectStarted = true;
      const reserved = await this.preparationEffect(key, 'reserve_preparation', {}, declaration, assertContext);
      this.journal!.retain({id: crypto.randomUUID(), itemKey: key, operation: 'upload_preparation', profile: 'intake-preparation/1', key: null,
        fingerprint: hash, references: {attemptId: reserved.result.attempt_id, document: reserved.result.document}});
      const staged = await this.preparationRequest('upload_preparation', {id: reserved.result.attempt_id}, bytes, assertContext);
      const prepared = await this.preparationEffect(key, 'finalize_preparation', {id: reserved.result.attempt_id},
        {profile: 'intake/1', representation: 'intake-preparation/1', expected_revision: reserved.result.preparation.revision,
          document: staged.result.document, differences: []}, assertContext);
      this.update(key, {phase: 'prepared', preparation: prepared.result.preparation, actions: ['inspect_preparation', 'reconcile'],
        detail: 'Exact preparation retained. This does not constitute, approve or publish a candidate.'});
      this.publish({page: 'detail', editor: null});
    } catch (error) {
      if (activity !== this.activityEpoch) return;
      if (effectStarted && !(error instanceof StaleView) && !isAbort(error)) {
        this.update(key, {phase: 'uncertain', actions: ['reconcile'], detail: 'Preparation is not confirmed. Reconcile the retained operation before repeating an effect.'});
        this.publish({page: 'detail', editor: null});
      }
      this.failure(error);
    } finally {if (activity === this.activityEpoch) this.publish({busy: false});}
  };

  private async workspaceQuery(body: Wire, assertContext: () => void) {
    const result = await this.client.request({path: '/api/intake/operations/lookup', method: 'POST', accept: WORKSPACE_ACCEPT,
      body: JSON.stringify({profile: WORKSPACE_PROFILE, ...body}), maximum: PREPARATION_BOUNDS.responseBytes, assertContext,
      validate: value => validateWorkspaceResponse(body.kind, value)});
    return result.value as Wire;
  }
  private async inspectPrepared(key: ItemKey, assertContext: () => void) {
    const item = this.items.get(key); if (!item?.view.preparation) throw Error('No exact retained preparation is known.');
    const query = await this.workspaceQuery({kind: 'preparation_inspection', preparation: item.view.preparation}, assertContext);
    if (['id', 'revision', 'sha256'].some(field => query.preparation.reference[field] !== (item.view.preparation as Wire)[field]))
      throw Error('The inspected preparation differs from the requested reference.');
    item.prepared = query.preparation;
    item.proposalDraft ??= {target: {kind: 'new', declaration: ''}, judgment: {kind: 'distinct', reason: ''}};
    const inspected = preparedInspection(item.prepared!, query.resource_offers);
    assertContext(); this.publish({selectedKey: key, page: 'inspector', editor: null, confirmation: null,
      inspector: {subject: 'preparation', reference: item.view.preparation, ...inspected, originalDownloadOffered: false,
        proposal: query.offers.includes('propose') ? {draft: item.proposalDraft, units: item.prepared!.payload.units.map((u: Wire) => u.id),
          selectedUnit: item.proposalUnit ?? null} : null}});
  }
  setProposalDraft = (draft: ProposalDraft) => {
    const item = this.current.selectedKey ? this.items.get(this.current.selectedKey) : null;
    if (!item || this.current.busy || !this.current.inspector?.proposal) return;
    item.proposalDraft = structuredClone(draft);
    this.publish({inspector: {...this.current.inspector, proposal: {...this.current.inspector.proposal, draft: item.proposalDraft}}});
  };
  setProposalUnit = (id: string) => {
    const item = this.current.selectedKey ? this.items.get(this.current.selectedKey) : null;
    if (!item || this.current.busy || !this.current.inspector?.proposal?.units.includes(id)) return;
    item.proposalUnit = id;
    this.publish({inspector: {...this.current.inspector, proposal: {...this.current.inspector.proposal, selectedUnit: id}}});
  };
  private async inspectProposal(key: ItemKey, assertContext: () => void) {
    const item = this.items.get(key); if (!item?.view.proposal) throw Error('No exact retained proposal is known.');
    const query = await this.workspaceQuery({kind: 'proposal_inspection', proposal: item.view.proposal}, assertContext);
    const ref = query.proposal, expected = item.view.proposal;
    if (ref.id !== expected.id || ref.revision !== expected.revision || ref.sha256 !== expected.sha256)
      throw Error('The inspected proposal differs from the requested reference.');
    item.proposalInspection = query.inspection;
    const inspected = proposalInspection(query.inspection.preparation, query.inspection.proposal);
    assertContext(); this.publish({selectedKey: key, page: 'confirmation', inspector: null, editor: null,
      confirmation: {proposal: ref, preparation: query.inspection.preparation.reference, ...inspected,
        confirmOffered: query.offers.includes('constitute') && !item.outcome, outcome: item.outcome ?? null}});
  }
  private adoptEditorialResult(key: ItemKey, response: Wire) {
    const item = this.items.get(key); if (!item) return;
    const result = response.result;
    if (result.state === 'prepared') this.update(key, {phase: 'prepared', preparation: result.preparation,
      actions: ['inspect_preparation', 'reconcile'], detail: 'Exact preparation retained. No candidate was constituted.'});
    else if (result.state === 'proposed') this.update(key, {phase: 'proposed', preparation: result.preparation, proposal: result.proposal,
      actions: ['review_proposal', 'inspect_preparation', 'reconcile'], detail: 'Exact proposal retained. Review it before confirmation.'});
    else if (['constituted', 'relationship_recorded', 'blocked'].includes(result.outcome)) {
      const kind = result.outcome === 'constituted' ? 'candidate' : result.outcome === 'relationship_recorded' ? 'relationship' : 'blocked';
      const detail = kind === 'candidate' ? 'Candidate constituted. It is not approved or published.' :
        kind === 'relationship' ? 'Relationship recorded. No additional candidate was created.' :
          `Blocked: ${result.block_kind}. Separate adjudication is required; none is offered here.`;
      item.outcome = {kind, reference: kind === 'candidate' ? result.candidates[0] :
        kind === 'relationship' ? result.relationships[0].version : response.effect, detail};
      this.update(key, {phase: kind, actions: [...(item.view.proposal ? ['review_proposal' as const] : []), 'reconcile'], detail});
      if (this.current.confirmation && this.current.selectedKey === key)
        this.publish({confirmation: {...this.current.confirmation, confirmOffered: false, outcome: item.outcome}});
    }
  }
  propose = async () => {
    const key = this.current.selectedKey, item = key ? this.items.get(key) : null;
    if (!key || !item?.view.preparation || !item.proposalDraft || !item.proposalUnit || !this.current.inspector?.proposal || this.current.busy) return;
    const assertContext = this.guard(), activity = ++this.activityEpoch; this.publish({busy: true, notices: []});
    try {
      const target = item.proposalDraft.target;
      const response = await this.preparationEffect(key, 'propose', {id: item.view.preparation.id, revision: String(item.view.preparation.revision)},
        {profile: 'intake/1', representation: 'intake-preparation/1', unit: item.proposalUnit,
          target: target.kind === 'new' ? target : {kind: target.kind, unit_id: target.unitId, version: target.version, declaration: target.declaration},
          judgment: item.proposalDraft.judgment}, assertContext);
      this.adoptEditorialResult(key, response); await this.inspectProposal(key, assertContext);
    } catch (error) {
      if (activity !== this.activityEpoch) return;
      if (this.pending.has(key + ':propose') && this.current.inspector) {
        this.update(key, {phase: 'uncertain', actions: ['reconcile'], detail: 'The proposal result is not confirmed. Reconcile the retained operation.'});
        this.publish({inspector: {...this.current.inspector, proposal: null}});
      }
      this.failure(error);
    }
    finally {if (activity === this.activityEpoch) this.publish({busy: false});}
  };
  confirm = async () => {
    const key = this.current.selectedKey, confirmation = this.current.confirmation;
    if (!key || !confirmation?.confirmOffered || this.current.busy) return;
    const assertContext = this.guard(), activity = ++this.activityEpoch; this.publish({busy: true, notices: []});
    try {
      const response = await this.preparationEffect(key, 'constitute', {},
        {profile: 'intake/1', representation: 'intake-preparation/1', proposal: confirmation.proposal, mode: 'person'}, assertContext);
      this.adoptEditorialResult(key, response);
    } catch (error) {
      if (activity !== this.activityEpoch) return;
      if (this.pending.has(key + ':constitute') && this.current.confirmation) {
        this.update(key, {phase: 'uncertain', actions: ['review_proposal', 'reconcile'], detail: 'The constitution result is not confirmed. Reconcile the retained operation.'});
        this.publish({confirmation: {...this.current.confirmation, confirmOffered: false}});
      }
      this.failure(error);
    }
    finally {if (activity === this.activityEpoch) this.publish({busy: false});}
  };
  downloadResource = async (reference: ArtifactReference) => {
    const key = this.current.selectedKey, item = key ? this.items.get(key) : null, inspector = this.current.inspector;
    if (!key || !item?.prepared || !inspector || this.current.busy) return;
    const block = inspector.blocks.find(b => b.kind === 'resource' && b.downloadOffered && b.resource.id === reference.id &&
      b.resource.generation === reference.generation && b.resource.sha256 === reference.sha256 && b.resource.bytes === reference.bytes);
    if (!block) return;
    const association = item.prepared.payload.resource_associations.find((row: Wire) => row.element_id === block.id);
    if (!association) return;
    const assertContext = this.guard(), activity = ++this.activityEpoch; this.publish({busy: true, notices: []});
    try {
      const prep = item.prepared.reference;
      const response = await this.preparationRequest('resource', {id: prep.id, revision: String(prep.revision), resource_id: association.local_id}, '', assertContext);
      const artifact = response.artifact;
      if (artifact.id !== reference.id || artifact.generation !== reference.generation || artifact.sha256 !== reference.sha256 || artifact.bytes !== reference.bytes)
        throw Error('Resource association changed.');
      const bytes = Uint8Array.from(atob(response.data), character => character.charCodeAt(0));
      const hash = await sha256(bytes); assertContext();
      if (hash !== reference.sha256 || bytes.length !== reference.bytes) throw Error('Resource bytes differ from the exact reference.');
      const url = URL.createObjectURL(new Blob([bytes.buffer], {type: 'application/octet-stream'}));
      try {const link = document.createElement('a'); link.href = url; link.download = 'resource-' + association.local_id; link.click();}
      finally {setTimeout(() => URL.revokeObjectURL(url), 0);}
    } catch (error) {if (activity === this.activityEpoch) this.failure(error);}
    finally {if (activity === this.activityEpoch) this.publish({busy: false});}
  };
  private async receive(key: ItemKey, assertContext: () => void) {
    const item = this.items.get(key), context = this.current.context;
    if (!item || !item.bytes || !item.view.profile || !context || !this.current.intakeOffered) throw Error('Select an offered profile and receiving context first.');
    if (item.receipt) throw Error('A reception already exists. Reconcile it instead of submitting a new one.');
    this.update(key, {phase: 'receiving', actions: ['reconcile'], detail: 'Receiving the exact original.'});
    const hash = await sha256(item.bytes); assertContext(); item.digest = hash;
    const reserved = await this.receptionEffect(key, 'reserve_reception', {}, {profile: 'intake/1',
      original: {name: item.view.name, bytes: item.bytes.length, sha256: hash, declared_media_type: item.media},
      format_profile: item.view.profile, receiving_context: {scope_id: context.scopeId, purpose_id: context.purposeId, treatment_revision: context.treatment}}, assertContext);
    item.receipt = reserved;
    if (!this.journal) throw Error('Recovery storage is unavailable.');
    const upload: JournalEntry = {id: crypto.randomUUID(), itemKey: key, operation: 'upload_original', profile: 'intake-reception/2', key: null,
      fingerprint: hash, references: {receptionId: reserved.reception_id, original: reserved.original}};
    this.journal.retain(upload);
    await this.receptionRequest('upload_original', {id: reserved.reception_id, generation: String(reserved.original.generation)}, item.bytes, assertContext);
    // The binary continuation has the older response shape; get actual current v2 state before finalization.
    const staged = await this.receptionRequest('reception', {id: reserved.reception_id}, null, assertContext);
    const final = await this.receptionEffect(key, 'finalize_reception', {id: reserved.reception_id}, {
      profile: 'intake/1', expected_revision: staged.revision, original: staged.original, format_profile: item.view.profile,
    }, assertContext);
    this.adoptReceipt(key, final);
    await this.refreshItem(key, assertContext);
  }
  private async reconcile(key: ItemKey, assertContext: () => void) {
    if (!this.journal) throw Error('Recovery storage is unavailable.');
    const entries = this.journal.read().filter(entry => entry.itemKey === key);
    if (!entries.length) throw Error('No retained locator is available. No new request was sent.');
    const entry = entries.at(-1)!;
    if (entry.profile === 'intake-preparation/1') {
      const body = entry.operation === 'upload_preparation' ? {profile: WORKSPACE_PROFILE, kind: 'preparation_attempt',
        attempt_id: entry.references.attemptId, document: entry.references.document} :
        {profile: WORKSPACE_PROFILE, kind: 'preparation_effect', variant: entry.operation, client_key: entry.key};
      const result = await this.client.request({path: '/api/intake/operations/lookup', method: 'POST', accept: WORKSPACE_ACCEPT,
        body: JSON.stringify(body), maximum: 65536, assertContext, validate: value => validateWorkspaceResponse(body.kind as 'preparation_effect', value)});
      const value = result.value as Wire;
      if (value.kind === 'preparation_effect') this.pending.delete(key + ':' + entry.operation);
      if (value.kind === 'preparation_effect' && (['prepared', 'proposed'].includes(value.effect.result.state) || value.effect.result.outcome)) {
        this.adoptEditorialResult(key, value.effect);
        if (value.effect.result.state === 'proposed') await this.inspectProposal(key, assertContext);
        return;
      }
      const observed = value.kind === 'preparation_effect' ? value.effect.result.state ?? value.effect.result.outcome : value.state;
      if (value.kind === 'preparation_attempt' && value.state === 'staged') {
        this.items.get(key)!.staged = value;
        this.update(key, {...recoveredPreparationStatus(observed), actions: [
          ...(value.offers.includes('finalize_preparation') ? ['continue_preparation' as const] : []), 'reconcile']});
        return;
      }
      this.update(key, {...recoveredPreparationStatus(observed), actions: ['reconcile']});
      return;
    }
    let receipt: ReceptionV2;
    if (entry.references.receptionId) receipt = await this.receptionRequest('reception', {id: entry.references.receptionId}, null, assertContext);
    else {
      if (!entry.key) throw Error('The reception locator is incomplete.');
      receipt = await this.receptionRequest('lookup_operation', {}, {profile: 'intake/1', by: 'intention',
        act: BINDINGS[entry.operation].basis, variant: entry.operation, client_key: entry.key}, assertContext);
    }
    this.adoptReceipt(key, receipt); await this.refreshItem(key, assertContext);
  }
  action = async (key: ItemKey, action: ItemAction) => {
    const item = this.items.get(key); if (!item || !item.view.actions.includes(action) || this.current.busy && action !== 'stop') return;
    if (action === 'discard') {this.items.delete(key); this.publish({selectedKey: this.current.selectedKey === key ? null : this.current.selectedKey}); return;}
    if (action === 'stop') this.changeContext();
    const assertContext = this.guard(), activity = ++this.activityEpoch; this.publish({busy: true, notices: []});
    try {
      if (action === 'receive') await this.receive(key, assertContext);
      else if (action === 'stop' && item.receipt) {
        const response = await this.receptionEffect(key, 'cancel_reception', {id: item.receipt.reception_id},
          {profile: 'intake/1', expected_revision: item.receipt.revision}, assertContext);
        this.adoptReceipt(key, response); await this.refreshItem(key, assertContext);
      }
      else if (action === 'reconcile') await this.reconcile(key, assertContext);
      else if (action === 'refresh' && item.receipt) await this.refreshItem(key, assertContext);
      else if (action === 'prepare') this.openPreparation(key);
      else if (action === 'continue_preparation' && item.staged) {
        const staged = item.staged;
        const result = await this.preparationEffect(key, 'finalize_preparation', {id: staged.attempt_id},
          {profile: 'intake/1', representation: 'intake-preparation/1', expected_revision: staged.preparation.revision,
            document: staged.document, differences: []}, assertContext);
        this.adoptEditorialResult(key, result); delete item.staged;
      }
      else if (action === 'inspect_original') await this.inspectOriginal(key, assertContext);
      else if (action === 'inspect_preparation') await this.inspectPrepared(key, assertContext);
      else if (action === 'review_proposal') await this.inspectProposal(key, assertContext);
    } catch (error) {
      if (activity !== this.activityEpoch) return;
      if (this.items.has(key) && !isAbort(error) && !(error instanceof StaleView)) {
        if (action === 'receive' && error instanceof IntakeRequestFailure && [400, 413, 415, 422].includes(error.status))
          this.update(key, {...rejectedReceptionStatus(error.status), actions: ['reconcile']});
        else if (action === 'receive') this.update(key, {phase: 'uncertain', detail: 'The result is not confirmed. Reconcile before attempting another effect.', actions: ['reconcile']});
        else if (action === 'stop' && this.pending.has(key + ':cancel_reception'))
          this.update(key, {phase: 'uncertain', detail: 'The stop result is not confirmed. Retained history has not been erased; reconcile the operation.', actions: ['reconcile']});
        else if (action === 'continue_preparation' && this.pending.has(key + ':finalize_preparation'))
          this.update(key, {phase: 'uncertain', detail: 'Preparation is not confirmed. Reconcile the retained operation before repeating an effect.', actions: ['reconcile']});
        // A failed inspection/query is not evidence that a known receipt became uncertain.
      }
      this.failure(error);
    } finally {if (activity === this.activityEpoch) this.publish({busy: false});}
  };
}
