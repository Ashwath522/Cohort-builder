/** Offline checks (no servers needed): npm test */
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { ingestExcel } from '../server/sources/excel.js';
import { matches, validateRules, RuleError, type RuleEnv } from '../server/filter.js';
import { buildDax, loadMapping } from '../server/sources/dax.js';
import { runSql, checkDefinition } from '../server/customFilters.js';
import { applyDelivery, sortRows } from '../server/delivery.js';
import type { Group } from '../server/model.js';

let failed = 0;
const check = (name: string, ok: boolean, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); if (!ok) failed++; };

const buf = fs.readFileSync('sample/sample_customers.xlsx');
const ds = await ingestExcel(buf, 'sample_customers.xlsx', 'test', '2026-10-20');
check('sample loads', ds.report.validRows > 0, `${ds.report.validRows}/${ds.report.totalRows} valid`);
check('email and phone columns ignored', ['email', 'phone'].every(f => ds.report.ignoredColumns.some(c => c.toLowerCase().includes(f))));
check('no email or phone stored anywhere', !/@example\.com|"9\d{9}"/.test(JSON.stringify(ds)));
check('every row has a Fynd user ID', ds.rows.every(r => /^[0-9a-f]{24}$/.test(r.fynd_user_id)));
check('missing / duplicate Fynd IDs skipped', ds.report.rowIssues.missingId > 0 && ds.report.rowIssues.duplicateId > 0,
  `${ds.report.rowIssues.missingId} missing, ${ds.report.rowIssues.duplicateId} duplicate`);

// Independent count straight from the sheet for the pilot rule
const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer);
const ws = wb.worksheets[0]; const seen = new Set<string>(); let expected = 0;
ws.eachRow((row, i) => {
  if (i === 1) return;
  const fynd = String(row.getCell(2).value ?? '').trim();
  if (!fynd || seen.has(fynd)) return;
  seen.add(fynd);
  const lp = String(row.getCell(7).value ?? '');
  if (lp.slice(6, 10) === '2025') expected++;
});
const pilot: Group = { logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'between', value: ['2025-01-01', '2025-12-31'] }] };
const got = ds.rows.filter(r => matches(r, pilot, { asOf: ds.dataAsOf })).length;
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

// Delivery rules: sort, top N, control group
const buyers = ds.rows.filter(r => (r.lifetime_order_count ?? 0) > 0);
const sorted = sortRows(buyers, 'lifetime_gmv', 'desc', ds.dataAsOf);
check('sort: highest spend first', sorted.every((r, i) => i === 0 || (sorted[i - 1].lifetime_gmv ?? 0) >= (r.lifetime_gmv ?? 0)));
const d1 = applyDelivery(buyers, { sortBy: 'lifetime_gmv', dir: 'desc', limit: 500, holdoutPct: 10, suppressDays: 0 }, ds.dataAsOf, 'seg_a');
const d2 = applyDelivery(buyers, { sortBy: 'lifetime_gmv', dir: 'desc', limit: 500, holdoutPct: 10, suppressDays: 0 }, ds.dataAsOf, 'seg_a');
check('top N + control group add up', d1.tag.length + d1.holdout.length === 500, `${d1.tag.length} tagged + ${d1.holdout.length} control`);
check('control group is repeatable', d1.holdout.map(r => r.customer_id).join() === d2.holdout.map(r => r.customer_id).join());
check('control group ~10%', d1.holdout.length > 25 && d1.holdout.length < 80, `${d1.holdout.length} of 500`);

try { await ingestExcel(fs.readFileSync('sample/sample_missing_fynd_id.xlsx'), 'x.xlsx', 'test', '2026-10-20'); check('rejects file without Fynd User ID', false); }
catch (e) { check('rejects file without Fynd User ID', /Validation/.test((e as Error).message) && JSON.stringify((e as { report?: unknown }).report).includes('Fynd User ID')); }

const dax2 = buildDax(pilot, loadMapping(), 'fetch', { pageSize: 1000 });
check('Power BI fetch asks for Fynd user ID, never email', dax2.includes('[Fynd User ID]') && !/email|phone/i.test(dax2));

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
