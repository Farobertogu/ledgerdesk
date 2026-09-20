'use client';

import {useId, type ReactNode} from 'react';
import type {ArtifactReference, ComponentObservation, ContextView, ExactReference, Notice, ViewPreferences} from '../view_model';
import {COPY, TERMS} from './copy';
import styles from './intake.module.css';

export function Field({label, help, children}: {
  label: string; help?: string; children: (id: string) => ReactNode;
}) {
  const id = useId();
  return <div className={styles.field}>
    <label htmlFor={id}>{label}</label>
    {help && <p className={styles.muted}>{help}</p>}
    {children(id)}
  </div>;
}

export function Notices({notices}: {notices: readonly Notice[]}) {
  return <div className={styles.notices}>{notices.map(notice =>
    <p key={notice.id} data-tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>)}</div>;
}

export function ReferenceDetails({reference, preferences}: {
  reference: ExactReference | ArtifactReference; preferences: ViewPreferences;
}) {
  const t = COPY[preferences.language];
  return <dl className={styles.facts}>
    <div><dt>ID</dt><dd>{reference.id}</dd></div>
    {'revision' in reference
      ? <div><dt>{t.revision}</dt><dd>{reference.revision}</dd></div>
      : <><div><dt>{t.generation}</dt><dd>{reference.generation}</dd></div><div><dt>{t.bytes}</dt><dd>{reference.bytes}</dd></div></>}
    <div><dt>{t.hash}</dt><dd>{reference.sha256}</dd></div>
  </dl>;
}

export function ContextDetails({context, preferences}: {context: ContextView | null; preferences: ViewPreferences}) {
  const t = COPY[preferences.language];
  if (!context) return <p className={styles.muted}>{t.noContext}</p>;
  return <details className={styles.disclosure}>
    <summary>{t.context}</summary>
    <dl className={styles.facts}><div><dt>{t.scope}</dt><dd>{context.scopeId}</dd></div>
      <div><dt>{t.purpose}</dt><dd>{context.purposeId}</dd></div></dl>
    <h3>{t.treatment}</h3><ReferenceDetails reference={context.treatment} preferences={preferences}/>
  </details>;
}

export function Observations({observations, preferences}: {
  observations: readonly ComponentObservation[]; preferences: ViewPreferences;
}) {
  const t = COPY[preferences.language], terms = TERMS[preferences.language];
  return <section className={styles.section} aria-label={t.observations}>
    <h3>{t.observations}</h3>
    {!observations.length && <p className={styles.muted}>{t.noObservations}</p>}
    {observations.map(observation => <div key={observation.id} className={styles.observation}>
      <h4>{observation.id}</h4>
      <dl className={styles.facts}>
        <div><dt>{t.execution}</dt><dd>{terms[observation.execution]}</dd></div>
        <div><dt>{t.coverage}</dt><dd>{terms[observation.coverage]}</dd></div>
        <div><dt>{t.fidelity}</dt><dd>{terms[observation.fidelity]}</dd></div>
      </dl>
      {observation.limitations.length > 0 && <><h4>{t.limitations}</h4><ul>{observation.limitations.map((text, index) => <li key={index} className={styles.literal}>{text}</li>)}</ul></>}
      {observation.incidents.length > 0 && <><h4>{t.incidents}</h4><ul>{observation.incidents.map(incident => <li key={incident.id}>
        <span className={styles.literal}>{incident.id}: {incident.cause}</span>
        {incident.detail !== null && <pre className={styles.original}>{incident.detail}</pre>}
      </li>)}</ul></>}
    </div>)}
  </section>;
}
