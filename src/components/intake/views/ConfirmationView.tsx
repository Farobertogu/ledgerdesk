'use client';

import type {ConfirmationViewProps} from '../view_model';
import {COPY} from './copy';
import {Notices, Observations, ReferenceDetails} from './shared';
import {InspectionBlocks} from './InspectionBlocks';
import {useViewBack, useViewFocus} from './focus';
import styles from './intake.module.css';

/** Retain the review form's explicit confirmation without its editorial authority. */
export function ConfirmationView(props: ConfirmationViewProps) {
  const {preferences, outcome} = props;
  const t = COPY[preferences.language];
  const back = useViewBack(props.onBack);
  const heading = useViewFocus<HTMLHeadingElement>(JSON.stringify(['confirm', props.item.key, props.proposal]));
  return <section className={styles.view} data-theme={preferences.theme} lang={preferences.language} aria-label={t.confirmTitle}>
    <button type="button" className={styles.back} onClick={back}>{t.cancel}</button>
    <h2 ref={heading} tabIndex={-1}>{t.confirmTitle}</h2><p className={styles.literal}>{props.item.name}</p>
    <Notices notices={props.notices}/>
    <section className={styles.section}><h3>{t.proposal}</h3><ReferenceDetails reference={props.proposal} preferences={preferences}/></section>
    <section className={styles.section}><h3>{t.preparation}</h3><ReferenceDetails reference={props.preparation} preferences={preferences}/></section>
    <InspectionBlocks blocks={props.blocks} preferences={preferences}/>
    <Observations observations={props.observations} preferences={preferences}/>
    <section className={styles.section}><h3>{t.differences}</h3>
      {props.differences.length ? <InspectionBlocks blocks={props.differences} preferences={preferences}/>
        : <p className={styles.muted}>{t.noDifferences}</p>}
    </section>
    <p>{t.confirmationNote}</p>
    {outcome && <section className={styles.section} role="status"><h3>{t.result}: {t[outcome.kind]}</h3>
      <p className={styles.literal}>{outcome.detail}</p>
      {outcome.reference && <ReferenceDetails reference={outcome.reference} preferences={preferences}/>}
    </section>}
    <div className={styles.actions}>
      {props.confirmOffered && <button type="button" className={styles.primary} disabled={props.busy} onClick={props.onConfirm}>{t.confirm}</button>}
      {props.item.actions.includes('reconcile') && <button type="button" disabled={props.busy} onClick={props.onReconcile}>{t.reconcile}</button>}
      <button type="button" onClick={back}>{t.cancel}</button>
    </div>
    {props.busy && <p role="status">{t.busy}</p>}
  </section>;
}
