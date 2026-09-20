'use client';

import {useEffect, useId, useRef, useState} from 'react';
import type {WorkspaceViewProps, ViewPreferences} from '../view_model';
import {COPY, PHASE} from './copy';
import {workspaceRows} from './presentation';
import {ContextDetails, Notices} from './shared';
import {returnFocus, ViewNavigation} from './focus';
import styles from './intake.module.css';

/** List/detail composition adapted from the corpus explorer. */
export function WorkspaceView(props: WorkspaceViewProps) {
  const [language, setLanguage] = useState<ViewPreferences['language']>('en');
  const [theme, setTheme] = useState<ViewPreferences['theme']>('dark');
  const [query, setQuery] = useState('');
  const [detailOpen, setDetailOpen] = useState(props.selectedKey !== null);
  const [entry, setEntry] = useState(0);
  const filterId = useId();
  const filter = useRef<HTMLInputElement>(null);
  const previous = useRef<HTMLButtonElement | null>(null);
  const t = COPY[language], preferences = {language, theme};
  const {rows, selected, outsideFilter} = workspaceRows(props.items, query, props.selectedKey);
  useEffect(() => { if (props.selectedKey !== null) setDetailOpen(true); }, [props.selectedKey]);
  useEffect(() => { if (props.phase !== 'ready') setDetailOpen(false); }, [props.phase]);
  const showBody = props.selectedKey === null || selected !== null;
  const returnToList = () => { setDetailOpen(false); returnFocus(previous.current, filter.current); };
  return <main className={styles.workspace} data-theme={theme} lang={language}>
    <header className={styles.header}>
      <h1>{t.title}</h1>
      <div className={styles.tools}>
        <label>{t.language}<select aria-label={t.language} value={language} onChange={event => setLanguage(event.target.value as ViewPreferences['language'])}>
          <option value="en">English</option><option value="es">Español</option>
        </select></label>
        <label>{t.theme}<select aria-label={t.theme} value={theme} onChange={event => setTheme(event.target.value as ViewPreferences['theme'])}>
          <option value="dark">{t.dark}</option><option value="light">{t.light}</option>
        </select></label>
        <button type="button" onClick={props.onRefresh}>{t.refresh}</button>
      </div>
    </header>
    <Notices notices={props.notices}/>
    {props.phase !== 'ready' ? <p className={styles.placeholder} role="status">{props.phase === 'checking_session' ? t.checking : t.unavailable}</p>
      : <div className={styles.layout} data-detail={detailOpen && showBody}>
        <aside className={styles.index} aria-label={t.pending}>
          <div className={styles.field}><label htmlFor={filterId}>{t.filter}</label>
            <input ref={filter} id={filterId} type="search" value={query} onChange={event => setQuery(event.target.value)}/></div>
          {props.intakeOffered && <button type="button" onClick={event => {
            previous.current = event.currentTarget; setDetailOpen(true); setEntry(value => value + 1); props.onOpenIntake();
          }}>{t.newMaterial}</button>}
          <ContextDetails context={props.context} preferences={preferences}/>
          {!props.items.length ? <p role="status">{t.empty}</p> : !rows.length ? <p role="status">{t.noMatch}</p> :
            <ul>{rows.map(item => <li key={item.key} data-item-key={item.key}>
              <button type="button" aria-current={selected?.key === item.key ? 'true' : undefined} onClick={event => {
                previous.current = event.currentTarget; setDetailOpen(true); setEntry(value => value + 1); props.onSelect(item.key);
              }}><span className={styles.literal}>{item.name}</span><small>{PHASE[language][item.phase]}</small></button>
            </li>)}</ul>}
        </aside>
        <section className={styles.detail} aria-label={t.details}>
          <button type="button" className={styles.mobileBack} onClick={returnToList}>{t.back}</button>
          {outsideFilter && <p className={styles.muted} role="status">{t.outsideFilter}</p>}
          <ViewNavigation.Provider value={{entry, returnToList}}>
            {showBody ? props.body(preferences) : <p className={styles.placeholder}>{t.choose}</p>}
          </ViewNavigation.Provider>
        </section>
      </div>}
  </main>;
}
