export const trialContext = Object.freeze({
  deploymentId: 'inc01-synthetic', scopeId: 'inc01-material', subjectId: 'synthetic-reader',
  surface: 'material-reader', purpose: 'synthetic-reading-trial', generation: 't04-generation-one',
});
export const trialEnv = Object.freeze({
  LEDGERDESK_READING_TRIAL: '1', LEDGERDESK_READING_ENVIRONMENT: 'local-synthetic',
  LEDGERDESK_READING_SUBJECT: trialContext.subjectId, LEDGERDESK_READING_GENERATION: trialContext.generation,
});
export const treatment = Object.freeze({ capture: true, processing: true, conservation: true, trace: true, destination: true });
export const original = '  Exact original: café\r\nRegla. Excepto los domingos.\nCafe\u0301 😀 <script>inert()</script>\u0000\ud800  ';
export function policy(maximum, expires = null) {
  return { unit: ['list', 'exact'].map((action) => {
    const binding = { ...trialContext, action };
    return { binding, evaluation: 'GRANT', grant: {
      binding, maximum, metadata: ['title', 'editorial_state', 'reading_conditions'],
      fragmentIds: ['rule', 'exception'], fragmentLocatorIds: [], validFrom: 0, validUntil: expires,
    } };
  }), inherited: [], general: [] };
}
export async function seedTrial(admin) {
  await admin.query(`INSERT INTO reading_trial.control
    (deployment_id, scope_id, generation, active, capture_ready, processing_ready, conservation_ready, trace_ready, destination_ready)
    VALUES ('inc01-synthetic', 'inc01-material', $1, true, true, true, true, true, true)`, [trialContext.generation]);
  for (const [id, maximum] of [['content', 'CONTENT'], ['reference', 'REFERENCE'], ['excerpt', 'EXCERPT'],
    ['existence', 'EXISTENCE'], ['hidden', 'NONE'], ['unknown', 'CONTENT']]) {
    const hierarchy = policy(maximum);
    if (id === 'unknown') hierarchy.unit.forEach((row) => { row.evaluation = 'INDETERMINATE'; });
    await admin.query(`INSERT INTO reading_trial.material
      (deployment_id, scope_id, unit_key, version_key, original_value, original_language, metadata, fragments, requirements)
      VALUES ('inc01-synthetic','inc01-material',$1,'"v1"',$2,'en',$3,$4,$5)`, [JSON.stringify(id), JSON.stringify(original),
      JSON.stringify({ title: `Synthetic ${id}`, editorial_state: 'PUBLISHED', reading_conditions: ['Synthetic trial only.'] }),
      JSON.stringify([{ fragment_id: 'rule', text: 'Regla.' }, { fragment_id: 'exception', text: 'Excepto los domingos.' }]),
      JSON.stringify({ REFERENCE: { metadata: ['title'] }, CONTENT: { metadata: ['title'] },
        EXCERPT: { metadata: ['title'], fragmentIds: ['rule', 'exception'] } })]);
    await admin.query(`INSERT INTO reading_trial.policy VALUES ('inc01-synthetic','inc01-material',$1,'"v1"',$2)`, [JSON.stringify(id), JSON.stringify(hierarchy)]);
  }
}
