/** Offline checks (no servers needed): npm test */
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { ingestExcel } from '../server/sources/excel.js';
import { matches, validateRules, RuleError } from '../server/filter.js';
import { buildDax, loadMapping } from '../server/sources/dax.js';
import { decrypt, keysReady } from '../server/crypto.js';
import type { Group } from '../server/model.js';

let failed = 0;
const check = (name: string, ok: boolean, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); if (!ok) failed++; };

if (!keysReady()) { console.error('Run `npm run keys` first'); process.exit(1); }
const buf = fs.readFileSync('sample/sample_customers.xlsx');
const ds = await ingestExcel(buf, 'sample_customers.xlsx', 'test', '2026-10-20');
check('sample loads', ds.report.validRows > 0, `${ds.report.validRows}/${ds.report.totalRows} valid`);
check('phone column ignored', ds.report.ignoredColumns.some(c => /phone/i.test(c)));
check('no plain emails stored', !JSON.stringify(ds.rows).match(/customer\d+@example\.com/));
check('encryption round-trip', /@example\.com$/.test(decrypt(ds.rows[0].email_enc)));

// Independent count straight from the sheet for the pilot rule
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer);
const ws = wb.worksheets[0]; const seen = new Set<string>(); let expected = 0;
ws.eachRow((row, i) => {
  if (i === 1) return;
  const email = String(row.getCell(2).value ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.endsWith('@urbanladder.com') || seen.has(email)) return;
  seen.add(email);
  const lp = String(row.getCell(6).value ?? '');
  if (lp.slice(6, 10) === '2025') expected++;
});
const pilot: Group = { logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'between', value: ['2025-01-01', '2025-12-31'] }] };
const got = ds.rows.filter(r => matches(r, pilot)).length;
check('pilot count matches independent count', got === expected, `${got} vs ${expected}`);

const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof RuleError; } };
check('rejects DAX injection in a value', throws(() => validateRules({ logic: 'AND', conditions: [{ field: 'categories', op: 'all_of', value: ['Bed"}) || TRUE() --'] }] }, ds.fieldsAvailable)));
check('rejects unknown field', throws(() => validateRules({ logic: 'AND', conditions: [{ field: 'phone' as never, op: 'in', value: ['1'] }] }, ds.fieldsAvailable)));
const dax = buildDax({ logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'before', value: '2024-01-01' }] }, loadMapping(), 'count');
check('DAX guards blank dates', dax.includes('NOT ISBLANK'), dax.replace(/\s+/g, ' ').slice(0, 90));

try { await ingestExcel(fs.readFileSync('sample/sample_missing_email.xlsx'), 'x.xlsx', 'test', '2026-10-20'); check('rejects file without Email', false); }
catch (e) { check('rejects file without Email', /Validation/.test((e as Error).message)); }

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
