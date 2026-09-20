'use client';

import type {InspectorViewProps, ProposalDraft} from '../view_model';
import {COPY} from './copy';
import {Field, Notices, Observations, ReferenceDetails} from './shared';
import {InspectionBlocks} from './InspectionBlocks';
import {useViewBack, useViewFocus} from './focus';
import styles from './intake.module.css';

export function InspectorView(props: InspectorViewProps) {
  const {preferences, proposal, busy} = props;
  const t = COPY[preferences.language];
  const back = useViewBack(props.onBack);
  const title = props.subject === 'original' ? t.original : props.subject === 'extraction' ? t.extraction : t.preparation;
  const heading = useViewFocus<HTMLHeadingElement>(JSON.stringify(['inspect', props.item.key, props.subject, props.reference]));
  const target = proposal?.draft.target;
  function changeTarget(kind: ProposalDraft['target']['kind']) {
    if (!proposal) return;
    const current = proposal.draft.target;
    props.onProposalDraft({...proposal.draft, target: kind === 'new'
      ? {kind, declaration: current.declaration}
      : current.kind !== 'new' ? {...current, kind}
        : {kind, unitId: '', version: {id: '', revision: 0, sha256: ''}, declaration: current.declaration}});
  }
  return <section className={styles.view} data-theme={preferences.theme} lang={preferences.language} aria-label={title}>
    <button type="button" className={styles.back} onClick={back}>{t.cancel}</button>
    <h2 ref={heading} tabIndex={-1}>{title}</h2><p className={styles.literal}>{props.item.name}</p>
    <Notices notices={props.notices}/>
    <details className={styles.disclosure}><summary>{t.reference}</summary><ReferenceDetails reference={props.reference} preferences={preferences}/></details>
    {props.originalDownloadOffered && <button type="button" disabled={busy} onClick={props.onDownloadOriginal}>{t.downloadOriginal}</button>}
    <InspectionBlocks blocks={props.blocks} preferences={preferences} busy={busy} onDownloadResource={props.onDownloadResource}/>
    <Observations observations={props.observations} preferences={preferences}/>
    <section className={styles.section}><h3>{t.differences}</h3>
      {props.differences.length ? <InspectionBlocks blocks={props.differences} preferences={preferences} busy={busy} onDownloadResource={props.onDownloadResource}/>
        : <p className={styles.muted}>{t.noDifferences}</p>}
    </section>
    {proposal && target && <fieldset className={styles.fieldset} disabled={busy}><legend>{t.proposal}</legend>
      <Field label={t.unit}>{id => <select id={id} value={proposal.selectedUnit ?? ''} onChange={event => { if (event.target.value) props.onProposalUnit(event.target.value); }}>
        <option value="" disabled>{t.chooseUnit}</option>{proposal.units.map(unit => <option key={unit} value={unit}>{unit}</option>)}
      </select>}</Field>
      <Field label={t.target}>{id => <select id={id} value={target.kind} onChange={event => changeTarget(event.target.value as ProposalDraft['target']['kind'])}>
        <option value="new">{t.new}</option><option value="successor">{t.successor}</option><option value="relationship">{t.relationship}</option>
      </select>}</Field>
      {target.kind !== 'new' && <>
        <Field label={t.unitId}>{id => <input id={id} value={target.unitId} onChange={event => props.onProposalDraft({...proposal.draft,
          target: {...target, unitId: event.target.value}})}/>}</Field>
        <Field label={t.versionId}>{id => <input id={id} value={target.version.id} onChange={event => props.onProposalDraft({...proposal.draft,
          target: {...target, version: {...target.version, id: event.target.value}}})}/>}</Field>
        <Field label={t.revision}>{id => <input id={id} type="number" step="1" min="1" value={target.version.revision || ''}
          onChange={event => props.onProposalDraft({...proposal.draft, target: {...target,
            version: {...target.version, revision: event.target.value === '' ? 0 : Number(event.target.value)}}})}/>}</Field>
        <Field label={t.hash}>{id => <input id={id} value={target.version.sha256} onChange={event => props.onProposalDraft({...proposal.draft,
          target: {...target, version: {...target.version, sha256: event.target.value}}})}/>}</Field>
      </>}
      <Field label={t.declaration}>{id => <textarea id={id} value={target.declaration}
        onChange={event => props.onProposalDraft({...proposal.draft, target: {...target, declaration: event.target.value}})}/>}</Field>
      <Field label={t.judgment}>{id => <select id={id} value={proposal.draft.judgment.kind}
        onChange={event => props.onProposalDraft({...proposal.draft, judgment: {...proposal.draft.judgment, kind: event.target.value as ProposalDraft['judgment']['kind']}})}>
        <option value="distinct">{t.distinct}</option><option value="same_version">{t.same_version}</option><option value="possible_duplicate">{t.possible_duplicate}</option>
      </select>}</Field>
      <Field label={t.reason}>{id => <textarea id={id} value={proposal.draft.judgment.reason}
        onChange={event => props.onProposalDraft({...proposal.draft, judgment: {...proposal.draft.judgment, reason: event.target.value}})}/>}</Field>
      {target.kind !== 'new' && <label className={styles.check}><input type="checkbox" checked={!!proposal.draft.judgment.evidence}
        onChange={event => {
          const {evidence: _previous, ...judgment} = proposal.draft.judgment;
          props.onProposalDraft({...proposal.draft, judgment: {...judgment, ...(event.target.checked ? {evidence: {...target.version}} : {})}});
        }}/>{t.comparisonEvidence}</label>}
      {proposal.draft.judgment.evidence && <ReferenceDetails reference={proposal.draft.judgment.evidence} preferences={preferences}/>}
      <button type="button" className={styles.primary} disabled={proposal.selectedUnit === null} onClick={props.onPropose}>{t.propose}</button>
    </fieldset>}
    <div className={styles.actions}><button type="button" onClick={back}>{t.cancel}</button></div>
  </section>;
}
