/**
 * Checks on the spreadsheet reader.
 *   node scripts/test-xlsx.mjs
 *
 * Written when the npm `xlsx` package was swapped for exceljs. That package is
 * the abandoned mirror of SheetJS, carries a prototype pollution advisory with
 * no fix, and was being pointed at arbitrary government URLs from a process
 * holding an admin token.
 *
 * The cases here are the ones where a spreadsheet reader goes wrong quietly.
 * A formula cell that yields "=B2*C2" instead of the number that was on the
 * screen. A date that stringifies to something no year parser reads. A blank
 * spacer row that becomes a record with every field empty and is then counted
 * as data.
 */
import { build } from 'esbuild';
import ExcelJS from 'exceljs';
import { rmSync } from 'node:fs';

const OUT = '.tmp-xlsx-test.mjs';
await build({
  entryPoints: ['local/source-parsers.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['exceljs', 'pdf-parse'],
});
const { readSpreadsheet } = await import(`./../${OUT}`);

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Build a real .xlsx in memory so the test exercises the actual format. */
async function workbook(build) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  build(ws);
  return await wb.xlsx.writeBuffer();
}

console.log('\nReading a spreadsheet');
console.log('---------------------');

{
  const buf = await workbook((ws) => {
    ws.addRow(['year', 'partner', 'value_usd']);
    ws.addRow([2024, 'Netherlands', 412300000]);
    ws.addRow([2023, 'Switzerland', 5100000000]);
  });
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('rows read', rows.length === 2, `${rows.length}`);
  check('headers used as keys', rows[0].partner === 'Netherlands', JSON.stringify(rows[0]));
  check('numbers kept as text of the number', rows[0].value_usd === '412300000', rows[0].value_usd);
  check('year read', rows[1].year === '2023', rows[1].year);
}

{
  // A title and a blank line above the real header is the normal shape of a
  // published statistics table. header_row exists for exactly this.
  const buf = await workbook((ws) => {
    ws.addRow(['Exports by partner, 2024']);
    ws.addRow([]);
    ws.addRow(['year', 'partner', 'value_usd']);
    ws.addRow([2024, 'India', 89000000]);
  });
  const rows = await readSpreadsheet(buf, 2, 'test.xlsx');
  check('header offset honoured', rows.length === 1 && rows[0].partner === 'India', JSON.stringify(rows));
}

{
  // The formula is not the answer. Taking it would put "=B2*C2" where a number
  // belongs, and the row would then fail to parse for a reason that looks
  // nothing like the cause.
  const buf = await workbook((ws) => {
    ws.addRow(['qty', 'price', 'total']);
    const r = ws.addRow([1000, 25, null]);
    r.getCell(3).value = { formula: 'A2*B2', result: 25000 };
  });
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('a formula cell yields its result, not the formula', rows[0].total === '25000', rows[0].total);
}

{
  const buf = await workbook((ws) => {
    ws.addRow(['period', 'value']);
    ws.addRow([new Date(Date.UTC(2024, 2, 31)), 42]);
  });
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('a date reads as an ISO date', rows[0].period === '2024-03-31', rows[0].period);
}

{
  const buf = await workbook((ws) => {
    ws.addRow(['year', 'value']);
    ws.addRow([2024, 1]);
    ws.addRow([]);
    ws.addRow([2023, 2]);
  });
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('a blank spacer row is not a record', rows.length === 2, `${rows.length} rows: ${JSON.stringify(rows)}`);
}

{
  const buf = await workbook((ws) => {
    ws.addRow(['year', 'partner', 'value']);
    ws.addRow([2024, null, 500]);
  });
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('an empty cell is empty, not dropped from the record', 'partner' in rows[0], JSON.stringify(rows[0]));
  check('and reads as empty rather than as a value', rows[0].partner === '', JSON.stringify(rows[0]));
}

{
  const buf = await workbook((ws) => {
    ws.addRow(['year', 'note']);
    const r = ws.addRow([2024, null]);
    r.getCell(2).value = { richText: [{ text: 'part one ' }, { text: 'part two' }] };
  });
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('rich text is joined into one string', rows[0].note === 'part one part two', rows[0].note);
}

{
  // Old binary .xls can no longer be read. That has to fail with something a
  // person can act on, not a stack from deep inside a zip reader.
  let message = '';
  try {
    await readSpreadsheet(new TextEncoder().encode('\xD0\xCF\x11\xE0 not a zip').buffer, 0, 'http://x.test/old.xls');
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  check('an unreadable file throws', message !== '');
  check('the message names the file', /old\.xls/.test(message), message);
  check('and says what to do about it', /save as \.xlsx|point at a CSV/i.test(message), message);
}

{
  const buf = await workbook(() => {});
  const rows = await readSpreadsheet(buf, 0, 'test.xlsx');
  check('an empty sheet yields nothing rather than throwing', Array.isArray(rows) && rows.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
