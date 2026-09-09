'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Reader, sameReference } from './reader';
import styles from './reader.module.css';

const copy = {
  en: {
    title: 'Material library', trial: 'ISOLATED READING TRIAL', filter: 'Filter received references',
    refresh: 'Refresh', loading: 'Loading material…', empty: 'No readable references were returned.',
    noMatch: 'No received references match this filter.', choose: 'Select a reference to read.',
    untitled: 'Untitled material', back: 'Back to list', metadata: 'Reference details',
    conditions: 'Reading conditions', original: 'Original text', excerpt: 'Original fragments',
    reference: 'Reference only. No original text was returned.', retry: 'Retry reading',
    unavailable: 'Material is unavailable.', unauthenticated: 'Reading access is unavailable.',
    technical: 'The reading service could not complete this request.', invalid: 'The reading response could not be used safely.',
    signal: 'An existence signal was returned. No further details are available.',
    paused: 'Reading is paused.', theme: 'Change colour theme', language: 'Control language',
    note: 'Read-only · Controls can change language; the original text does not.',
  },
  es: {
    title: 'Biblioteca de material', trial: 'ENSAYO AISLADO DE LECTURA', filter: 'Filtrar referencias recibidas',
    refresh: 'Actualizar', loading: 'Cargando material…', empty: 'No se devolvieron referencias legibles.',
    noMatch: 'Ninguna referencia recibida coincide con este filtro.', choose: 'Selecciona una referencia para leer.',
    untitled: 'Material sin título', back: 'Volver a la lista', metadata: 'Detalles de la referencia',
    conditions: 'Condiciones de lectura', original: 'Texto original', excerpt: 'Fragmentos originales',
    reference: 'Sólo referencia. No se devolvió texto original.', retry: 'Reintentar lectura',
    unavailable: 'El material no está disponible.', unauthenticated: 'El acceso de lectura no está disponible.',
    technical: 'El servicio de lectura no pudo completar esta solicitud.', invalid: 'La respuesta de lectura no se pudo utilizar de forma segura.',
    signal: 'Se devolvió una señal de existencia. No hay más detalles disponibles.',
    paused: 'La lectura está en pausa.', theme: 'Cambiar tema de color', language: 'Idioma de los controles',
    note: 'Sólo lectura · Los controles pueden cambiar de idioma; el texto original no.',
  },
};

export default function MaterialReader({ serviceOrigin }: { serviceOrigin: string }) {
  const [reader] = useState(() => new Reader(undefined, serviceOrigin));
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const [light, setLight] = useState(false);
  const [query, setQuery] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const lastButton = useRef<HTMLButtonElement | null>(null);
  const t = copy[language];
  useEffect(() => {
    void reader.reload();
    const hide = () => reader.pause();
    const show = () => { if (!document.hidden) void reader.reload(); };
    const visibility = () => document.hidden ? hide() : show();
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
      document.removeEventListener('visibilitychange', visibility);
      reader.pause();
    };
  }, [reader]);
  useEffect(() => { if (state.selected) heading.current?.focus(); }, [state.selected]);
  const filtered = state.list?.items.filter(item =>
    `${item.metadata.title ?? ''}\n${item.reference.unit_id}\n${item.reference.version_id}`
      .toLowerCase().includes(query.toLowerCase())) ?? [];
  const projection = state.detail;
  return (
    <main className={styles.reader} data-theme={light ? 'light' : 'dark'} lang={language}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>{t.trial}</p><h1>{t.title}</h1></div>
        <div className={styles.tools}>
          <label>{t.language} <select value={language} onChange={e => setLanguage(e.target.value as 'en' | 'es')}><option value="en">EN</option><option value="es">ES</option></select></label>
          <button aria-label={t.theme} onClick={() => setLight(!light)}>{light ? '◐' : '◑'}</button>
          <button onClick={() => { setQuery(''); void reader.reload(); }}>{t.refresh}</button>
        </div>
      </header>
      <p className={styles.note}>{t.note}</p>
      {state.phase === 'error' ? <section className={styles.message} role="alert"><p>{t[state.failure!]}</p><button onClick={() => void reader.reload()}>{t.retry}</button></section>
        : state.phase !== 'ready' ? <p className={styles.message} role="status">{state.phase === 'loading' ? t.loading : t.paused}</p>
        : <div className={styles.workspace} data-selected={Boolean(state.selected)}>
          <section className={styles.index} aria-label={t.title}>
            <label className={styles.filter}>{t.filter}<input value={query} onChange={e => setQuery(e.target.value)} type="search" /></label>
            {state.list?.existence_signal && <p className={styles.signal}>{t.signal}</p>}
            {!state.list?.items.length ? <p role="status">{t.empty}</p> : !filtered.length ? <p role="status">{t.noMatch}</p> :
              <ul>{filtered.map(item => <li key={JSON.stringify(item.reference)}>
                <button aria-pressed={Boolean(state.selected && sameReference(state.selected, item.reference))}
                  onClick={e => { lastButton.current = e.currentTarget; void reader.select(item.reference); }}>
                  <span>{item.metadata.title ?? t.untitled}</span><small>{item.reference.unit_id} · {item.reference.version_id}</small>
                </button>
              </li>)}</ul>}
          </section>
          <article className={styles.detail} aria-label={t.original}>
            {!state.selected ? <p className={styles.placeholder}>{t.choose}</p> : <>
              <button className={styles.back} onClick={() => { reader.back(); requestAnimationFrame(() => lastButton.current?.focus()); }}>{t.back}</button>
              <h2 tabIndex={-1} ref={heading}>{projection?.metadata.title ?? t.untitled}</h2>
              {state.detailPhase === 'loading' ? <p role="status">{t.loading}</p> : projection && <>
                <details className={styles.metadata}><summary>{t.metadata}</summary>
                  <p>{projection.reference.unit_id} · {projection.reference.version_id}</p>
                  {projection.metadata.locator !== undefined && <pre>{projection.metadata.locator}</pre>}
                  {projection.metadata.editorial_state && <p>{projection.metadata.editorial_state}</p>}
                  {projection.metadata.classification && <ul>{Object.entries(projection.metadata.classification).map(([key, value]) => <li key={key}>{key}: {value}</li>)}</ul>}
                </details>
                {Boolean(projection.metadata.reading_conditions?.length) && <section className={styles.conditions}><h3>{t.conditions}</h3><ul>{projection.metadata.reading_conditions!.map((condition, i) => <li key={i}>{condition}</li>)}</ul></section>}
                {projection.kind === 'REFERENCE' ? <p>{t.reference}</p> : <section lang={projection.original_language}>
                  <p className={styles.eyebrow}>{projection.kind === 'CONTENT' ? t.original : t.excerpt} · {projection.original_language.toUpperCase()}</p>
                  {projection.kind === 'CONTENT' ? <pre className={styles.original} data-testid="original">{projection.original_text}</pre> :
                    projection.fragments.map((fragment, i) => <section className={styles.fragment} key={i}>
                      <small>{fragment.fragment_id}</small>
                      {fragment.locator !== undefined && <pre className={styles.locator}>{fragment.locator}</pre>}
                      <pre className={styles.original} data-testid="original">{fragment.text}</pre>
                    </section>)}
                </section>}
              </>}
            </>}
          </article>
        </div>}
    </main>
  );
}
