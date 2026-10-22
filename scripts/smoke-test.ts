/** Offline checks (no servers needed): npm test */
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { ingestExcel } from '../server/sources/excel.js';
import { matches, validateRules, RuleError, type RuleEnv } from '../server/filter.js';
import { buildDax, loadMapping } from '../server/sources/dax.js';
import { decrypt, keysReady } from '../server/crypto.js';
import { runSql, checkDefinition } from '../server/customFilters.js';
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

const env: RuleEnv = { fieldsAvailable: ds.fieldsAvailable, validateCustom: () => { throw new RuleError('no custom'); } };
const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof RuleError; } };
check('rejects DAX injection in a value', throws(() => validateRules({ logic: 'AND', conditions: [{ field: 'categories', op: 'all_of', value: ['Bed"}) || TRUE() --'] }] }, env)));
check('rejects unknown field', throws(() => validateRules({ logic: 'AND', conditions: [{ field: 'phone' as never, op: 'in', value: ['1'] }] }, env)));
const dax = buildDax({ logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'before', value: '2024-01-01' }] }, loadMapping(), 'count');
check('DAX guards blank dates', dax.includes('NOT ISBLANK'), dax.replace(/\s+/g, ' ').slice(0, 90));

// "Bought Bed but NOT Mattress": built-in filter and a developer SQL button must agree
const bn = ds.rows.filter(r => matches(r, { logic: 'AND', conditions: [{ field: 'categories', op: 'bought_not', value: { bought: ['Bed'], notBought: ['Mattress'] } }] })).length;
const def = { label: 'Bought X, not Y', description: '', params: [{ name: 'bought', label: 'Bought', type: 'category' as const }, { name: 'not_bought', label: 'Not bought', type: 'category' as const }],
  sql: 'SELECT customer_id FROM customer_categories WHERE category = :bought EXCEPT SELECT customer_id FROM customer_categories WHERE category = :not_bought' };
const { ids } = await runSql(ds, def, { bought: 'Bed', not_bought: 'Mattress' });
check('bought-but-not: built-in = developer SQL', bn === ids.size && bn > 0, `${bn} vs ${ids.size}`);
check('developer SQL: writes are refused', checkDefinition({ ...def, params: [], sql: 'WITH x AS (SELECT 1) DELETE FROM customers' }).length > 0);
check('order lines loaded', (ds.orderLines?.length ?? 0) > 0, `${ds.orderLines?.length} lines`);

try { await ingestExcel(fs.readFileSync('sample/sample_missing_email.xlsx'), 'x.xlsx', 'test', '2026-10-20'); check('rejects file without Email', false); }
catch (e) { check('rejects file without Email', /Validation/.test((e as Error).message)); }

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
