'use client';

import type {ClassificationDraft, ExaminationOutcome, PreparationEditorViewProps} from '../view_model';
import {COPY, TERMS} from './copy';
import {Field, Notices, Observations, ReferenceDetails} from './shared';
import {InspectionBlocks} from './InspectionBlocks';
import {useViewBack, useViewFocus} from './focus';
import styles from './intake.module.css';

const AXES = {
  function: ['definitional', 'normative', 'operational', 'factual'],
  basis: ['domain_adoption', 'applicable_external_authority', 'verifiable_attestation', 'non_authoritative_reference'],
  scope: ['reusable_with_conditions', 'situated'],
} as const;
const OUTCOMES: readonly ExaminationOutcome[] = ['classifiable', 'divide', 'transform', 'block', 'reject'];

/** Labelled editor layout retained; the owner supplies every business draft value. */
export function PreparationEditorView(props: PreparationEditorViewProps) {
  const {draft, preferences, onEdit, busy} = props;
  const t = COPY[preferences.language], terms = TERMS[preferences.language];
  const back = useViewBack(props.onBack);
  const heading = useViewFocus<HTMLHeadingElement>(JSON.stringify(['preparation', props.item.key, props.antecedents]));
  const unresolvedMissing = Object.values(draft.classification).some(axis => axis.value === null && !/\S/u.test(axis.reason));
  return <section className={styles.view} data-theme={preferences.theme} lang={preferences.language} aria-label={t.preparation}>
    <button type="button" className={styles.back} onClick={back}>{t.cancel}</button>
    <h2 ref={heading} tabIndex={-1}>{t.preparation}</h2><p className={styles.literal}>{props.item.name}</p>
    <Notices notices={props.notices}/>
    <details className={styles.disclosure}><summary>{t.antecedents}</summary>
      {props.antecedents.map(reference => <ReferenceDetails key={`${reference.id}:${reference.revision}:${reference.sha256}`}
        reference={reference} preferences={preferences}/>)}
    </details>
    <fieldset className={styles.fieldset} disabled={busy}><legend>{t.selection}</legend>
      {props.elements.map(element => {
        const hasCorrection = Object.hasOwn(draft.corrections, element.id);
        return <section key={element.id} className={styles.section} data-element-id={element.id}>
          <label className={styles.check}><input type="checkbox" checked={draft.selected.includes(element.id)}
            onChange={event => onEdit({kind: 'selection', elementId: element.id, selected: event.target.checked})}/>
            <span className={styles.literal}>{element.label}</span></label>
          <dl className={styles.facts}><div><dt>{t.coordinates}</dt><dd>{element.coordinates}</dd></div></dl>
          <details className={styles.disclosure}><summary>{t.original}</summary>
            <ReferenceDetails reference={element.source} preferences={preferences}/>
            <InspectionBlocks blocks={[element.inspection]} preferences={preferences}/>
          </details>
          {element.correctionOffered && element.kind === 'text' && <>
            <p className={styles.muted}>{t.correctionNote}</p>
            {hasCorrection ? <>
              <Field label={t.correction}>{id => <textarea id={id} rows={6} value={draft.corrections[element.id]}
                onChange={event => onEdit({kind: 'correction', elementId: element.id, text: event.target.value})}/>}</Field>
              <button type="button" onClick={() => onEdit({kind: 'correction', elementId: element.id, text: null})}>{t.removeCorrection}</button>
            </> : <button type="button" onClick={() => onEdit({kind: 'correction', elementId: element.id,
              text: element.inspection.kind === 'text' ? element.inspection.text : ''})}>{t.correct}</button>}
          </>}
        </section>;
      })}
    </fieldset>
    <fieldset className={styles.fieldset} disabled={busy}><legend>{t.classification}</legend>
      {(Object.keys(AXES) as (keyof ClassificationDraft)[]).map(axis => <section key={axis}>
        <Field label={axis === 'scope' ? t.scopeAxis : t[axis]}>{id => <select id={id} value={draft.classification[axis].value ?? ''}
          onChange={event => {
            const value = event.target.value || null;
            onEdit({kind: 'classification', value: {...draft.classification,
              [axis]: {...draft.classification[axis], value}} as ClassificationDraft});
          }}>
          <option value="">{t.unresolved}</option>
          {AXES[axis].map(value => <option key={value} value={value}>{terms[value]}</option>)}
        </select>}</Field>
        <Field label={draft.classification[axis].value === null ? t.unresolvedReason : t.reason}>{id => <textarea id={id}
          value={draft.classification[axis].reason} onChange={event => onEdit({kind: 'classification', value: {...draft.classification,
            [axis]: {...draft.classification[axis], reason: event.target.value}}})}/>}</Field>
      </section>)}
    </fieldset>
    <fieldset className={styles.fieldset} disabled={busy}><legend>{t.conditions}</legend>
      {draft.conditions.map(condition => <section key={condition.id} className={styles.section}>
        <p className={styles.literal}>{condition.id}</p>
        <Field label={t.conditionText}>{id => <textarea id={id} value={condition.text}
          onChange={event => onEdit({kind: 'condition', value: {...condition, text: event.target.value}})}/>}</Field>
        <Field label={t.conditionScope}>{id => <input id={id} value={condition.scope}
          onChange={event => onEdit({kind: 'condition', value: {...condition, scope: event.target.value}})}/>}</Field>
        <button type="button" onClick={() => onEdit({kind: 'remove_condition', id: condition.id})}>{t.remove}</button>
      </section>)}
      <button type="button" onClick={() => onEdit({kind: 'add_condition'})}>{t.addCondition}</button>
    </fieldset>
    <fieldset className={styles.fieldset} disabled={busy}><legend>{t.dependencies}</legend>
      {draft.dependencies.map(dependency => <section key={dependency.id} className={styles.section}>
        <p className={styles.literal}>{dependency.id}</p>
        <div className={styles.split}>
          <Field label={t.from}>{id => <input id={id} value={dependency.from}
            onChange={event => onEdit({kind: 'dependency', value: {...dependency, from: event.target.value}})}/>}</Field>
          <Field label={t.to}>{id => <input id={id} value={dependency.to}
            onChange={event => onEdit({kind: 'dependency', value: {...dependency, to: event.target.value}})}/>}</Field>
        </div>
        <label className={styles.check}><input type="checkbox" checked={dependency.required}
          onChange={event => onEdit({kind: 'dependency', value: {...dependency, required: event.target.checked}})}/>{t.required}</label>
        <button type="button" onClick={() => onEdit({kind: 'remove_dependency', id: dependency.id})}>{t.remove}</button>
      </section>)}
      <button type="button" onClick={() => onEdit({kind: 'add_dependency'})}>{t.addDependency}</button>
    </fieldset>
    <fieldset className={styles.fieldset} disabled={busy}><legend>{t.examination}</legend>
      <Field label={t.examinationOutcome}>{id => <select id={id} value={draft.examination.outcome ?? ''}
        onChange={event => onEdit({kind: 'examination', value: {...draft.examination, outcome: (event.target.value || null) as ExaminationOutcome | null}})}>
        <option value="">{t.unresolved}</option>{OUTCOMES.map(outcome => <option key={outcome} value={outcome}>{terms[outcome]}</option>)}
      </select>}</Field>
      <Field label={t.reason}>{id => <textarea id={id} value={draft.examination.reason}
        onChange={event => onEdit({kind: 'examination', value: {...draft.examination, reason: event.target.value}})}/>}</Field>
      <label className={styles.check}><input type="checkbox" checked={draft.coverage.completeSourceClaim}
        onChange={event => onEdit({kind: 'coverage', value: {...draft.coverage, completeSourceClaim: event.target.checked}})}/>{t.coverageClaim}</label>
      <Field label={t.coverageReason}>{id => <textarea id={id} value={draft.coverage.reason}
        onChange={event => onEdit({kind: 'coverage', value: {...draft.coverage, reason: event.target.value}})}/>}</Field>
      <Field label={t.changeReason}>{id => <textarea id={id} value={draft.changeReason}
        onChange={event => onEdit({kind: 'change_reason', value: event.target.value})}/>}</Field>
    </fieldset>
    <Observations observations={props.observations} preferences={preferences}/>
    <div className={styles.actions}>
      {props.saveOffered && <button type="button" className={styles.primary} disabled={busy || unresolvedMissing} onClick={props.onSave}>{t.save}</button>}
      <button type="button" onClick={back}>{t.cancel}</button>
      {props.item.actions.includes('discard') && <button type="button" disabled={busy} onClick={props.onDiscardLocal}>{t.discard}</button>}
    </div>
    {busy && <p role="status">{t.busy}</p>}
  </section>;
}
