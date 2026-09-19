// Literal reference data. Logical labels are not existing service records.
export const REFERENCE_PROFILE = 't04-independent-references/1';

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const REFERENCES = freeze({
  'F-T': {
    source: 'tests/intake/t01/fixtures/text.txt',
    bytes: 197,
    sha256: 'eca7253801e939ccdf6ea63e5bf1b1b59dbed50c27ebf4281b8abb5e4100bf3b',
    text: 'AZ-17\r\nFor procedure AZ-17, receipt Q is required.\r\nUnder condition Z, receipt R replaces receipt Q.\r\nAZ-18\r\nUnder condition Z, receipt S replaces receipt Q.\r\nEspañol: información. Cafe\u0301. 😀\r\n',
    lines: [
      { role: 'heading', text: 'AZ-17\r\n', bytes: [0, 7], code_points: [0, 7] },
      { role: 'rule', text: 'For procedure AZ-17, receipt Q is required.\r\n', bytes: [7, 52], code_points: [7, 52] },
      { role: 'exception', text: 'Under condition Z, receipt R replaces receipt Q.\r\n', bytes: [52, 102], code_points: [52, 102] },
      { role: 'other_heading', text: 'AZ-18\r\n', bytes: [102, 109], code_points: [102, 109] },
      { role: 'other_exception', text: 'Under condition Z, receipt S replaces receipt Q.\r\n', bytes: [109, 159], code_points: [109, 159] },
      { role: 'unicode', text: 'Español: información. Cafe\u0301. 😀\r\n', bytes: [159, 197], code_points: [159, 191] },
    ],
    short: {
      source: 'tests/intake/t01/fixtures/short.txt', text: 'No.', bytes: 3,
      sha256: '38178a20b470cfd18299fb1593dd4ba706f1a83321dac051d01086efd8b7a96f',
      byte_range: [0, 3],
    },
  },
  'F-P': {
    preparation: { id: 'P-T', revision: 2 }, original: 'O-T@1', extraction: 'E-T@1',
    heading: 'AZ-17', rule: 'For procedure AZ-17, receipt Q is required.',
    exception: 'Under condition Z, receipt R replaces receipt Q.',
    relation: { from: 'rule', to: 'exception', role: 'indispensable', scope: 'AZ-17 under condition Z' },
    order: ['rule', 'exception'], reordered: ['exception', 'rule'],
    redaction: 'For AZ-17, use receipt Q unless condition Z holds; under Z, receipt R replaces Q.',
    correction: { before: 'P', after: 'R', simulated_extraction_error: true },
    meaning: { ordinary: 'Q', under_Z: 'R' },
    approval_inherited: false,
  },
  'F-R': {
    local_id: 'R-1',
    az17: {
      operation: 'OP-V-17', preparation: 'P-V@2', artifact: 'A-17', generation: 7,
      utf8: '<svg>AZ-17 R</svg>', bytes: 18,
      sha256: '0f89f7bcdc3ce22de57dac66f927d14668ffb9112a1eb0438cf89ffb5adc48b3',
      caption: 'AZ-17 under condition Z', scope: 'AZ-17 under condition Z',
    },
    az18: {
      operation: 'OP-V-18', preparation: 'P-V-alt@1', artifact: 'A-18', generation: 9,
      utf8: '<svg>AZ-18 S</svg>', bytes: 18,
      sha256: 'ba1968924947e6ac6107bc99be030f58361e18c1449d89807c7e92655b2766cd',
      // The independent alternative fixes bytes and association, not a new caption literal.
      caption: null, scope: null,
    },
  },
  'F-D': {
    correction: {
      before: 'P@1', after: 'P@2', original: 'O-P@1', difference: 'D-ok@1',
      before_text: 'receipt P', after_text: 'receipt R', affected_role: 'exception',
      method: 'correction', transformation: 'cleanup',
    },
    other: {
      before: 'Q@4', after: 'Q@5', original: 'O-Q@1', difference: 'D-other@1',
      before_text: 'Use M.', after_text: 'Use N.', affected_role: 'rule',
      method: 'correction', transformation: 'cleanup',
    },
  },
  'F-X': {
    x07: {
      source: 'tests/intake/t01/fixtures/unsupported-part.xlsx', bytes: 4862,
      sha256: '147ef087a2f0e6f7fb708839390b26d1e727397ead28a3c14eaa0bc194da8e52',
      observation_sha256: '3279f69ff76fa4776e919cdffebf6df5888fb3b5290ad3887dcd3807b47834ff',
      // Package counts do not establish a complete semantic source inventory.
      outcome: 'partial', sheets: 2, cells: 36, inventory: 'unknown',
      unsupported: 'xl/media/image1.svg',
      parent: { execution: 'completed', coverage: 'partial', fidelity: 'unchecked' },
      unprocessed: { execution: 'not_attempted', coverage: 'none', fidelity: 'unchecked' },
      incident: { cause: 'route_unoffered', detail: 'xl/media/image1.svg' },
    },
    mixed: {
      A: { execution: 'completed', cause: null },
      B: { execution: 'failed', cause: 'unreadable' },
      C: { execution: 'not_attempted', cause: 'route_unoffered' },
      D: { execution: 'failed', cause: 'technical_failure' },
      E: { execution: 'not_attempted', interrupted_by: 'D' },
      known: ['A', 'B', 'C', 'D', 'E'], unknown: ['A', 'B', 'C', 'D'],
      selected: ['A'], complete_source_claim: false,
    },
  },
  'F-C9': {
    identity: 'U-17@1', first_receipt: 'RECEIPT-1', next_receipt: 'RECEIPT-2',
    conditions: { procedure: 'AZ-17', exception: 'Z', ordinary: 'Q', under_Z: 'R' },
    repetition_requires: ['authenticated_exact_version', 'matching_integrity', 'compatible_conditions'],
    unproven: { equal_bytes: true, authenticated_equivalence: false, automatic_fusion: false },
    collision_variants: ['replace_R_with_S', 'remove_Z_from_conditions'],
    distinct_requires: 'legitimate_distinct_unit_declaration',
    outcomes: {
      distinct: { outcome: 'constituted', block_kind: null, candidates: 1, relationships: 0, blocks: 0, states: ['candidate'] },
      repetition: { outcome: 'relationship_recorded', block_kind: null, candidates: 0, relationships: 1, blocks: 0, states: [] },
      collision: { outcome: 'blocked', block_kind: 'identity_collision', candidates: 0, relationships: 0, blocks: 1, states: [] },
      possible_duplicate: { outcome: 'blocked', block_kind: 'possible_duplicate', candidates: 0, relationships: 0, blocks: 1, states: [] },
    },
    approvals: 0, published: 0, searchable: 0,
    previous_bytes_unchanged: true, previous_provenance_unchanged: true, new_receipt_preserved: true,
  },
});
