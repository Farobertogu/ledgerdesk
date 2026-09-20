'use client';

import type {ArtifactReference, InspectionBlock, ViewPreferences} from '../view_model';
import {COPY} from './copy';
import {ReferenceDetails} from './shared';
import styles from './intake.module.css';

/** Supplied display blocks are not parsed, normalised or made executable. */
export function InspectionBlocks({blocks, preferences, busy = false, onDownloadResource}: {
  blocks: readonly InspectionBlock[]; preferences: ViewPreferences; busy?: boolean;
  onDownloadResource?: (resource: ArtifactReference) => void;
}) {
  const t = COPY[preferences.language];
  return <>{!blocks.length && <p className={styles.muted}>{t.noBlocks}</p>}
    {blocks.map(block => <section key={block.id} className={styles.section} data-block-id={block.id}>
      <h3 className={styles.literal}>{block.title}</h3>
      {block.reference && <details className={styles.disclosure}><summary>{t.reference}</summary>
        <ReferenceDetails reference={block.reference} preferences={preferences}/></details>}
      {block.kind === 'text' && <>
        <dl className={styles.facts}><div><dt>{t.coordinates}</dt><dd>{block.coordinates}</dd></div></dl>
        <pre className={styles.original} data-testid="intake-exact-text">{block.text}</pre>
      </>}
      {block.kind === 'table' && <>
        <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={block.title}>
          <table className={styles.table}>
            <thead><tr>{block.columns.map((column, index) => <th key={index} scope="col" data-column={index}>{column}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} data-row={rowIndex}>
              {row.map((cell, columnIndex) => <td key={columnIndex} data-column={columnIndex} data-testid="intake-cell">{cell}</td>)}
            </tr>)}</tbody>
          </table>
        </div>
        <dl className={styles.facts}>{block.fields.map((field, index) => <div key={index}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}</dl>
        {block.notes.length > 0 && <section aria-label={t.tableNotes}><h4>{t.tableNotes}</h4>
          <ul>{block.notes.map((note, index) => <li key={index} className={styles.literal}>{note}</li>)}</ul>
        </section>}
      </>}
      {block.kind === 'facts' && <dl className={styles.facts}>
        {block.fields.map((field, index) => <div key={index}><dt>{field.name}</dt><dd>{field.value}</dd></div>)}
      </dl>}
      {block.kind === 'resource' && <>
        <ReferenceDetails reference={block.resource} preferences={preferences}/>
        <dl className={styles.facts}><div><dt>{t.mediaType}</dt><dd>{block.mediaType}</dd></div></dl>
        {block.downloadOffered && onDownloadResource && <button type="button" disabled={busy}
          onClick={() => onDownloadResource(block.resource)}>{t.downloadResource}</button>}
      </>}
    </section>)}
  </>;
}
