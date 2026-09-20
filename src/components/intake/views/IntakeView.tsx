'use client';

import {useEffect, useId, useRef, useState} from 'react';
import type {IntakeViewProps, IntakeProfile} from '../view_model';
import {ACTION, COPY, PHASE} from './copy';
import {byteLabel} from './presentation';
import {ContextDetails, Field, Notices, Observations} from './shared';
import {useViewBack, useViewFocus} from './focus';
import styles from './intake.module.css';

/** The intake demo's two routes share externally owned drafts, not local effects. */
export function IntakeView(props: IntakeViewProps) {
  const {preferences, textDraft} = props;
  const t = COPY[preferences.language];
  const [tab, setTab] = useState<'files' | 'text'>('files');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileButton = useViewFocus<HTMLButtonElement>(`intake-${tab}`);
  const textInput = useViewFocus<HTMLInputElement>(`intake-${tab}`);
  const inputId = useId();
  const back = useViewBack(props.onBack);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);
  const canReceive = props.intakeOffered && props.context !== null && !props.busy;
  const textAvailable = props.profiles.some(profile => profile.id === 'text-utf8/1' && profile.receptionAvailable);
  const acceptFiles = (files: readonly File[]) => { if (canReceive && files.length) props.onFiles(files); };
  return <section className={styles.view} data-theme={preferences.theme} lang={preferences.language} aria-label={t.newMaterial}>
    <button type="button" className={styles.back} onClick={back}>{t.cancel}</button>
    <h2>{t.newMaterial}</h2>
    <Notices notices={props.notices}/>
    <ContextDetails context={props.context} preferences={preferences}/>
    <details className={styles.disclosure}><summary>{t.formats}</summary>
      {props.profiles.map(profile => <section key={profile.id} className={styles.section}>
        <h3>{profile.label}</h3><dl className={styles.facts}>
          <div><dt>{t.profile}</dt><dd>{profile.id}</dd></div>
          <div><dt>{t.maximum}</dt><dd>{byteLabel(profile.maximumBytes)} ({profile.maximumBytes} B)</dd></div>
          <div><dt>{t.reception}</dt><dd>{profile.receptionAvailable ? t.available : t.notAvailable}</dd></div>
          <div><dt>{t.extraction}</dt><dd>{profile.extractionAvailable ? t.available : t.notAvailable}</dd></div>
        </dl>
      </section>)}
    </details>
    <div className={styles.tabs} aria-label={t.newMaterial}>
      <button type="button" aria-pressed={tab === 'files'} onClick={() => setTab('files')}>{t.files}</button>
      <button type="button" aria-pressed={tab === 'text'} onClick={() => setTab('text')}>{t.text}</button>
    </div>
    {tab === 'files' ? <div className={styles.drop} data-dragging={dragging}
      onDragOver={event => { event.preventDefault(); if (canReceive) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); acceptFiles(Array.from(event.dataTransfer.files)); }}>
      <p>{t.drop}</p>
      {props.intakeOffered && <>
        <input id={inputId} className={styles.visuallyHidden} type="file" multiple tabIndex={-1} ref={fileInput}
          aria-label={t.chooseFiles} disabled={!canReceive} onChange={event => {
            acceptFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '';
          }}/>
        <button type="button" ref={fileButton} disabled={!canReceive} onClick={() => fileInput.current?.click()}>{t.chooseFiles}</button>
      </>}
    </div> : <div>
      <Field label={t.fileName}>{id => <input id={id} ref={textInput} value={textDraft.name} disabled={props.busy}
        onChange={event => props.onTextDraft({...textDraft, name: event.target.value})}/>}</Field>
      <Field label={t.capturedText} help={t.captureNote}>{id => <textarea id={id} rows={8} value={textDraft.text} disabled={props.busy}
        onChange={event => props.onTextDraft({...textDraft, text: event.target.value})}/>}</Field>
      {props.intakeOffered && textAvailable && <button type="button" className={styles.primary} disabled={!canReceive}
        onClick={props.onCaptureText}>{t.capture}</button>}
    </div>}
    {props.busy && <p role="status">{t.busy}</p>}
    <section className={styles.section} aria-label={t.pending}><h3>{t.pending}</h3>
      {!props.items.length && <p className={styles.muted}>{t.empty}</p>}
      <ul className={styles.cards}>{props.items.map(item => <li key={item.key} className={styles.card} data-item-key={item.key}>
        <div className={styles.cardHeader}><h3>{item.name}</h3><span className={styles.badge}>{PHASE[preferences.language][item.phase]}</span></div>
        <p className={styles.muted}>{byteLabel(item.bytes)}</p><p className={styles.literal}>{item.detail}</p>
        {item.actions.includes('receive') ? <Field label={t.profile}>{id => <select id={id} value={item.profile ?? ''} disabled={props.busy}
          onChange={event => { if (event.target.value) props.onProfile(item.key, event.target.value as IntakeProfile); }}>
          <option value="" disabled>{t.chooseProfile}</option>
          {props.profiles.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.receptionAvailable}>{profile.label}</option>)}
        </select>}</Field> : item.profile !== null && <p className={styles.literal}>{item.profile}</p>}
        {item.observations.length > 0 && <Observations observations={item.observations} preferences={preferences}/>}
        <div className={styles.actions}>{item.actions.map(action => <button key={action} type="button"
          disabled={props.busy && action !== 'stop'} onClick={() => props.onAction(item.key, action)}>{ACTION[preferences.language][action]}</button>)}</div>
      </li>)}</ul>
    </section>
  </section>;
}
