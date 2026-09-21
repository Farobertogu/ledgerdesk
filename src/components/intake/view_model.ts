import type {ReactNode} from 'react';

/** Presentation boundary only. References select records; none grants authority. */
export type ExactReference = Readonly<{id: string; revision: number; sha256: string}>;
export type ArtifactReference = Readonly<{id: string; generation: number; bytes: number; sha256: string}>;
export type ViewPreferences = Readonly<{language: 'en' | 'es'; theme: 'dark' | 'light'}>;
export type ItemKey = string;
export type IntakeProfile = 'text-utf8/1' | 'markdown-inert/1' | 'csv-utf8/1' | 'xlsx-cells/1';
export type Notice = Readonly<{id: string; tone: 'info' | 'warning' | 'error'; text: string}>;
export type ContextView = Readonly<{scopeId: string; purposeId: string; treatment: ExactReference}>;
export type ProfileView = Readonly<{
  id: IntakeProfile; label: string; mediaType: string; maximumBytes: number;
  receptionAvailable: boolean; extractionAvailable: boolean;
}>;
export type ItemAction = 'receive' | 'refresh' | 'reconcile' | 'stop' | 'discard' |
  'inspect_original' | 'prepare' | 'continue_preparation' | 'inspect_preparation' | 'review_proposal';
export type ItemPhase = 'draft' | 'receiving' | 'received' | 'extracting' | 'extracted' |
  'preparing' | 'prepared' | 'proposed' | 'candidate' | 'relationship' | 'blocked' |
  'recorded' | 'uncertain' | 'unavailable' | 'failed' | 'stopped';
export type ComponentObservation = Readonly<{
  id: string; execution: 'completed' | 'failed' | 'not_attempted' | 'unknown';
  coverage: 'complete' | 'partial' | 'none' | 'unknown';
  fidelity: 'checked' | 'unchecked' | 'disputed';
  limitations: readonly string[];
  incidents: readonly Readonly<{id: string; cause: string; detail: string | null}>[];
}>;
export type ItemView = Readonly<{
  key: ItemKey; name: string; capture: 'file' | 'text' | 'recovered';
  profile: IntakeProfile | null; bytes: number | null; phase: ItemPhase;
  detail: string; actions: readonly ItemAction[]; observations: readonly ComponentObservation[];
  receipt: ExactReference | null; preparation: ExactReference | null; proposal: ExactReference | null;
}>;

/** The shell owns only presentation state. It must not retain removed protected rows. */
export type WorkspaceViewProps = Readonly<{
  phase: 'checking_session' | 'ready' | 'unavailable';
  context: ContextView | null; items: readonly ItemView[]; selectedKey: ItemKey | null;
  notices: readonly Notice[]; intakeOffered: boolean;
  onSelect: (key: ItemKey) => void; onOpenIntake: () => void; onRefresh: () => void;
  body: (preferences: ViewPreferences) => ReactNode;
}>;

export type TextDraft = Readonly<{name: string; text: string}>;
/** File/text business drafts live above the view; changing tabs never clears them. */
export type IntakeViewProps = Readonly<{
  preferences: ViewPreferences; context: ContextView | null; profiles: readonly ProfileView[];
  items: readonly ItemView[]; textDraft: TextDraft; busy: boolean; intakeOffered: boolean;
  notices: readonly Notice[];
  onFiles: (files: readonly File[]) => void;
  onProfile: (key: ItemKey, profile: IntakeProfile) => void;
  onTextDraft: (draft: TextDraft) => void;
  onCaptureText: () => void;
  onAction: (key: ItemKey, action: ItemAction) => void;
  onBack: () => void;
}>;

/** These are already-authorized display values, not a second parsing pipeline. */
export type InspectionField = Readonly<{name: string; value: string}>;
export type InspectionBlock = Readonly<{
  id: string; title: string; reference: ExactReference | ArtifactReference | null;
}> & (
  | Readonly<{kind: 'text'; text: string; coordinates: string}>
  | Readonly<{kind: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[];
      notes: readonly string[]; fields: readonly InspectionField[]}>
  | Readonly<{kind: 'resource'; resource: ArtifactReference; mediaType: string; downloadOffered: boolean}>
  | Readonly<{kind: 'facts'; fields: readonly InspectionField[]}>
);
export type ElementChoice = Readonly<{
  id: string; label: string; kind: 'text' | 'table' | 'resource';
  source: ExactReference; coordinates: string; inspection: InspectionBlock;
  correctionOffered: boolean;
}>;
export type ClassificationAxis<T extends string> = Readonly<{value: T | null; reason: string}>;
export type ClassificationDraft = Readonly<{
  function: ClassificationAxis<'definitional' | 'normative' | 'operational' | 'factual'>;
  basis: ClassificationAxis<'domain_adoption' | 'applicable_external_authority' |
    'verifiable_attestation' | 'non_authoritative_reference'>;
  scope: ClassificationAxis<'reusable_with_conditions' | 'situated'>;
}>;
export type ConditionDraft = Readonly<{id: string; text: string; scope: string}>;
export type DependencyDraft = Readonly<{id: string; from: string; to: string; required: boolean}>;
export type ExaminationOutcome = 'classifiable' | 'divide' | 'transform' | 'block' | 'reject';
export type PreparationDraft = Readonly<{
  selected: readonly string[];
  corrections: Readonly<Record<string, string>>;
  classification: ClassificationDraft;
  conditions: readonly ConditionDraft[];
  dependencies: readonly DependencyDraft[];
  examination: Readonly<{outcome: ExaminationOutcome | null; reason: string}>;
  coverage: Readonly<{completeSourceClaim: boolean; reason: string}>;
  changeReason: string;
}>;
export type PreparationEdit =
  | Readonly<{kind: 'selection'; elementId: string; selected: boolean}>
  | Readonly<{kind: 'correction'; elementId: string; text: string | null}>
  | Readonly<{kind: 'classification'; value: ClassificationDraft}>
  | Readonly<{kind: 'add_condition'}>
  | Readonly<{kind: 'condition'; value: ConditionDraft}>
  | Readonly<{kind: 'remove_condition'; id: string}>
  | Readonly<{kind: 'add_dependency'}>
  | Readonly<{kind: 'dependency'; value: DependencyDraft}>
  | Readonly<{kind: 'remove_dependency'; id: string}>
  | Readonly<{kind: 'examination'; value: PreparationDraft['examination']}>
  | Readonly<{kind: 'coverage'; value: PreparationDraft['coverage']}>
  | Readonly<{kind: 'change_reason'; value: string}>;
export type PreparationEditorViewProps = Readonly<{
  preferences: ViewPreferences; item: ItemView; antecedents: readonly ExactReference[];
  elements: readonly ElementChoice[]; observations: readonly ComponentObservation[];
  draft: PreparationDraft; busy: boolean; saveOffered: boolean; notices: readonly Notice[];
  onEdit: (edit: PreparationEdit) => void;
  onSave: () => void; onBack: () => void; onDiscardLocal: () => void;
}>;

export type ProposalDraft = Readonly<{
  target: Readonly<{kind: 'new'; declaration: string}> |
    Readonly<{kind: 'successor' | 'relationship'; unitId: string; version: ExactReference; declaration: string}>;
  judgment: Readonly<{kind: 'distinct' | 'same_version' | 'possible_duplicate'; reason: string; evidence?: ExactReference}>;
}>;
export type InspectorViewProps = Readonly<{
  preferences: ViewPreferences; item: ItemView;
  subject: 'original' | 'extraction' | 'preparation';
  reference: ExactReference | ArtifactReference;
  blocks: readonly InspectionBlock[]; observations: readonly ComponentObservation[];
  differences: readonly InspectionBlock[]; notices: readonly Notice[];
  busy: boolean; originalDownloadOffered: boolean;
  proposal: Readonly<{draft: ProposalDraft; units: readonly string[]; selectedUnit: string | null}> | null;
  onDownloadOriginal: () => void; onDownloadResource: (resource: ArtifactReference) => void;
  onProposalDraft: (draft: ProposalDraft) => void; onProposalUnit: (id: string) => void;
  onPropose: () => void; onBack: () => void;
}>;

/** Confirmation is constitution of this exact proposal, never approval/publication. */
export type ConfirmationViewProps = Readonly<{
  preferences: ViewPreferences; item: ItemView; proposal: ExactReference;
  preparation: ExactReference; blocks: readonly InspectionBlock[];
  observations: readonly ComponentObservation[]; differences: readonly InspectionBlock[];
  notices: readonly Notice[]; confirmOffered: boolean; busy: boolean;
  outcome: Readonly<{kind: 'candidate' | 'relationship' | 'blocked'; reference: ExactReference | null; detail: string}> | null;
  onConfirm: () => void; onReconcile: () => void; onBack: () => void;
}>;
