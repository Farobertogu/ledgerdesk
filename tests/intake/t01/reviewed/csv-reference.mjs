import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Checker-only references. The producer and consumer cannot read this file.
// Record boundaries and fields are specified before the evaluated parser runs.
export const CSV_REFERENCES = {
  'table.csv': {
    bomBytes: 0,
    records: ['Code,Value,Value,Note\r\n', '001,0,,"USD, excludes tax"\r\n', '002,12.50,=B2*C2,"Line one\r\nLine two"\r\n', '003,#N/A,"", final space \r\n'],
    fields: [['Code','Value','Value','Note'], ['001','0','','USD, excludes tax'], ['002','12.50','=B2*C2','Line one\r\nLine two'], ['003','#N/A','',' final space ']]
  },
  'unicode-records.csv': {
    bomBytes: 0,
    records: ['Code,Note\r\n', '\ufeff001,"Información 😀\r\nCafe\u0301"\r\n', '002,"literal �"'],
    fields: [['Code','Note'], ['\ufeff001','Información 😀\r\nCafe\u0301'], ['002','literal �']]
  }
};

export function assertCsvReference(extraction, bytes, reference) {
  const prefix = reference.bomBytes ? Buffer.from([239,187,191]) : Buffer.alloc(0);
  assert.deepEqual(bytes, Buffer.concat([prefix, Buffer.from(reference.records.join(''))]), 'Input differs from the independently specified records');
  const table = extraction.elements[0];
  assert.equal(extraction.original.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(table.locator.original, extraction.original.sha256);
  assert.equal(extraction.inventory.bomBytes, reference.bomBytes);
  assert.equal(table.rows.length, reference.records.length);
  assert.deepEqual(table.headers, reference.fields[0] ?? []);
  let position = reference.bomBytes;
  const expected = reference.records.map((raw, index) => {
    const start = position; position += Buffer.byteLength(raw);
    return { index, fields: reference.fields[index], raw, originalByteRange: [start, position] };
  });
  // Compare both the source range and its content to an external reference,
  // not only to each other. Also checks index, field order and record order.
  assert.deepEqual(table.rows, expected);
  for (const row of table.rows) assert.equal(bytes.subarray(...row.originalByteRange).toString('utf8'), reference.records[row.index]);
  assert.equal(position, bytes.length);
  return { expected, observed: table.rows };
}
