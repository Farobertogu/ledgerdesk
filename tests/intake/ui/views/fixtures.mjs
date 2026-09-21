export const preferences = {language: 'en', theme: 'dark'};
export const exact = {id: 'exact-source', revision: 7, sha256: 'a'.repeat(64)};
export const artifact = {id: 'artifact', generation: 4, bytes: 10, sha256: 'b'.repeat(64)};
export const context = {scopeId: 'synthetic-scope', purposeId: 'synthetic-purpose', treatment: exact};
export const original = '  Original e\u0301\r\n<img src="https://invalid.example/leak">\n  001\t0  ';
export const item = {key: 'local-A', name: 'política-€-2026.md', capture: 'file', profile: 'markdown-inert/1', bytes: 0,
  phase: 'draft', detail: '  unchanged detail  ', actions: [], observations: [], receipt: null, preparation: null, proposal: null};
export const profiles = [{id: 'text-utf8/1', label: 'UTF-8 text', mediaType: 'text/plain', maximumBytes: 1048576,
  receptionAvailable: true, extractionAvailable: true}];
export const blocks = [
  {id: 'text-1', title: 'Exact source', reference: exact, kind: 'text', text: original, coordinates: 'lines 1–3'},
  {id: 'table-1', title: 'Positional values', reference: exact, kind: 'table', columns: ['same', 'same', ''],
    rows: [['001', '0', ''], ['=A1+1', '#DIV/0!', 'missing stored value']],
    notes: ['  Hidden sheet; condition retained  '], fields: [{name: 'Formula', value: '=A1+1'}, {name: 'Stored value', value: '0'}]},
  {id: 'resource-1', title: 'Resource descriptor', reference: null, kind: 'resource', resource: artifact,
    mediaType: 'image/png', downloadOffered: false},
];
export const observation = {id: 'component-A', execution: 'not_attempted', coverage: 'unknown', fidelity: 'unchecked',
  limitations: ['  inventory incomplete  '], incidents: [{id: 'incident-A', cause: 'interrupted', detail: '  no attempted extraction  '}]};
export const draft = {selected: ['element-A'], corrections: {'element-A': '  correction\n'},
  classification: {function: {value: null, reason: 'unresolved function'}, basis: {value: null, reason: 'unresolved basis'},
    scope: {value: null, reason: 'unresolved scope'}}, conditions: [{id: 'C1', text: '  condition  ', scope: 'unit'}],
  dependencies: [{id: 'D1', from: 'A', to: 'B', required: true}], examination: {outcome: null, reason: ''},
  coverage: {completeSourceClaim: false, reason: '  partial  '}, changeReason: '  edit  '};
export const noOp = () => {};
export const workspaceProps = {phase: 'ready', context, items: [item], selectedKey: null, notices: [], intakeOffered: true,
  onSelect: noOp, onOpenIntake: noOp, onRefresh: noOp, body: () => 'SAFE BODY'};
export const intakeProps = {preferences, context, profiles, items: [item], textDraft: {name: ' note.txt ', text: original}, busy: false,
  intakeOffered: true, notices: [], onFiles: noOp, onProfile: noOp, onTextDraft: noOp, onCaptureText: noOp, onAction: noOp, onBack: noOp};
export const editorProps = {preferences, item, antecedents: [exact],
  elements: [{id: 'element-A', label: 'Source A', kind: 'text', source: exact, coordinates: 'lines 1–3',
    inspection: blocks[0], correctionOffered: true}], observations: [observation], draft, busy: false, saveOffered: true,
  notices: [], onEdit: noOp, onSave: noOp, onBack: noOp, onDiscardLocal: noOp};
export const inspectorProps = {preferences, item, subject: 'preparation', reference: exact, blocks, observations: [observation],
  differences: [], notices: [], busy: false, originalDownloadOffered: false, proposal: null,
  onDownloadOriginal: noOp, onDownloadResource: noOp, onProposalDraft: noOp, onProposalUnit: noOp, onPropose: noOp, onBack: noOp};
export const confirmationProps = {preferences, item, proposal: {...exact, id: 'proposal'}, preparation: exact, blocks,
  observations: [observation], differences: [], notices: [], confirmOffered: false, busy: false, outcome: null,
  onConfirm: noOp, onReconcile: noOp, onBack: noOp};
