import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { encrypt, hashEmail, isValidEmail, maskEmail, normaliseEmail } from '../crypto.js';
import type { CustomerRow, Dataset, FieldKey, OrderLine, ValidationReport } from '../model.js';
import { withDerived } from '../filter.js';

type InternalField = Exclude<FieldKey, 'days_since_last_purchase' | 'aov' | 'customer_type'> | 'customer_id' | 'email' | 'phone';

/** Header aliases (case/space-insensitive). Power BI "Customer Audience" export names are included. */
const ALIASES: Record<InternalField, string[]> = {
  customer_id: ['customer id', 'customer_id', 'customerid', 'cust id', 'id'],
  email: ['email', 'email id', 'email_id', 'customer email', 'e-mail', 'email address'],
  phone: ['phone', 'phone number', 'mobile', 'mobile number', 'contact number'],
  registered_at: ['registered at', 'registered_at', 'registration date', 'signup date'],
  first_purchase_date: ['first purchase date', 'first_purchase_date'],
  last_purchase_date: ['last purchase date', 'last_purchase_date'],
  lifetime_order_count: ['total purchase count', 'lifetime_order_count', 'lifetime order count', 'order count', 'orders'],
  lifetime_gmv: ['lifetime gmv', 'lifetime_gmv', 'total gmv', 'total spend', 'lifetime spend'],
  last_channel: ['last channel', 'last_channel', 'channel'],
  city: ['city'],
  categories: ['categories bought', 'categories', 'category', 'bought categories'],
};
const norm = (h: string) => h.toLowerCase().replace(/[\s_]+/g, ' ').trim();
const ALIAS_LOOKUP = new Map<string, InternalField>();
for (const [k, list] of Object.entries(ALIASES)) for (const a of list) ALIAS_LOOKUP.set(norm(a), k as InternalField);

export const MAX_ROWS = 1_000_000;

/** Plain value out of an exceljs cell (handles hyperlinks, rich text, formulas). */
function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellValue(o.result as ExcelJS.CellValue);
    if ('text' in o) return typeof o.text === 'string' ? o.text : cellValue(o.text as ExcelJS.CellValue);
    if ('richText' in o) return (o.richText as Array<{ text: string }>).map(t => t.text).join('');
    if ('hyperlink' in o) return String(o.hyperlink).replace(/^mailto:/i, '');
    return undefined;
  }
  return v;
}

/** → YYYY-MM-DD, or null if it can't be read. Day-first unless DATE_ORDER=MDY. */
export function toIsoDate(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const iso = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  if (v instanceof Date) return isNaN(+v) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return v > 20000 && v < 80000 ? new Date((v - 25569) * 864e5).toISOString().slice(0, 10) : null; // Excel serial
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/);
  if (m) return config.dateOrder === 'MDY' ? iso(+m[3], +m[1], +m[2]) : iso(+m[3], +m[2], +m[1]);
  return null;
}

const toNumber = (v: unknown): number | null | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse + validate an uploaded file. The file buffer is only held in memory; emails are
 * encrypted and hashed row by row and the plain value is dropped immediately.
 */
export async function ingestExcel(buf: Buffer, fileName: string, uploadedBy: string, dataAsOf: string): Promise<Dataset> {
  const report: ValidationReport = {
    totalRows: 0, validRows: 0, columnsFound: {}, ignoredColumns: [], errors: [], warnings: [],
    rowIssues: { missingId: 0, invalidEmail: 0, internalDomain: 0, duplicateEmail: 0, badDate: 0, badNumber: 0 },
  };
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(fileName)) await wb.csv.read(Readable.from(buf));
    else if (/\.xlsx$/i.test(fileName)) await wb.xlsx.load(buf as unknown as ArrayBuffer);
    else throw new Error('Only .xlsx and .csv files are supported');
  } catch (e) {
    throw new Error(`Could not read the file: ${(e as Error).message}`);
  }
  const ws = wb.worksheets.find(w => /customer/i.test(w.name)) ?? wb.worksheets.find(w => !/order/i.test(w.name)) ?? wb.worksheets[0];
  if (!ws) throw new Error('The file has no sheets');

  // Header row = first row (within the first 10) whose cells match at least 2 known columns.
  let headerRow = 0;
  const colMap = new Map<number, InternalField>();
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    const found = new Map<number, InternalField>();
    ws.getRow(r).eachCell((cell, col) => {
      const f = ALIAS_LOOKUP.get(norm(String(cellValue(cell.value) ?? '')));
      if (f && ![...found.values()].includes(f)) found.set(col, f);
    });
    if (found.size >= 2) { headerRow = r; found.forEach((f, c) => colMap.set(c, f)); }
  }
  if (!headerRow) {
    report.errors.push('No header row found. The file needs at least "Customer ID" and "Email" columns.');
    throw Object.assign(new Error('Validation failed'), { report });
  }
  ws.getRow(headerRow).eachCell((cell, col) => {
    const h = String(cellValue(cell.value) ?? '');
    const f = colMap.get(col);
    if (!f) report.ignoredColumns.push(h);
    else if (f === 'phone') report.ignoredColumns.push(`${h} (phone is never used)`);
    else report.columnsFound[f] = h;
  });
  if (!report.columnsFound.customer_id) report.errors.push('Missing required column: Customer ID');
  if (!report.columnsFound.email) report.errors.push('Missing required column: Email');
  if (report.errors.length) throw Object.assign(new Error('Validation failed'), { report });

  const rows: CustomerRow[] = [];
  const seen = new Set<string>();
  const choices = { last_channel: new Set<string>(), city: new Set<string>(), categories: new Set<string>() };

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    if (++report.totalRows > MAX_ROWS) { report.errors.push(`More than ${MAX_ROWS.toLocaleString()} rows`); break; }
    const get = (f: InternalField) => {
      for (const [col, field] of colMap) if (field === f) return cellValue(row.getCell(col).value);
      return undefined;
    };
    const id = String(get('customer_id') ?? '').trim();
    if (!id) { report.rowIssues.missingId++; continue; }
    let email = normaliseEmail(get('email'));
    if (!isValidEmail(email)) { report.rowIssues.invalidEmail++; continue; }
    if (config.excludeDomains.includes(email.split('@')[1])) { report.rowIssues.internalDomain++; continue; }
    const hash = hashEmail(email);
    if (seen.has(hash)) { report.rowIssues.duplicateEmail++; continue; }
    seen.add(hash);

    const out: CustomerRow = { customer_id: id, email_hash: hash, email_enc: encrypt(email), email_masked: maskEmail(email) };
    email = '';                                                       // plain email not kept
    for (const f of ['registered_at', 'first_purchase_date', 'last_purchase_date'] as const) {
      const d = toIsoDate(get(f));
      if (d === null) report.rowIssues.badDate++; else if (d) out[f] = d;
    }
    for (const f of ['lifetime_order_count', 'lifetime_gmv'] as const) {
      const n = toNumber(get(f));
      if (n === null) report.rowIssues.badNumber++; else if (n !== undefined) out[f] = n;
    }
    const ch = get('last_channel'); if (ch) { out.last_channel = String(ch).trim(); choices.last_channel.add(out.last_channel); }
    const city = get('city'); if (city) { out.city = String(city).trim(); choices.city.add(out.city); }
    const cats = get('categories');
    if (cats) {
      out.categories = String(cats).split(/[;,|]/).map(s => s.trim()).filter(Boolean);
      out.categories.forEach(c => choices.categories.add(c));
    }
    rows.push(out);
  }
  report.validRows = rows.length;

  // Optional second sheet "Order Lines" (Customer ID, Order Date, Category, Amount): enables
  // time-based category filters for developer-defined filter buttons.
  let orderLines: OrderLine[] | undefined;
  const os = wb.worksheets.find(w => w !== ws && /order/i.test(w.name));
  if (os) {
    const OL: Record<string, string[]> = {
      customer_id: ALIASES.customer_id, order_date: ['order date', 'order_date', 'date', 'purchase date'],
      category: ['category', 'product category'], amount: ['amount', 'line gmv', 'line_gmv', 'gmv', 'value', 'price'],
    };
    const cols: Record<string, number> = {};
    os.getRow(1).eachCell((cell, col) => {
      const h = norm(String(cellValue(cell.value) ?? ''));
      for (const [k, list] of Object.entries(OL)) if (!(k in cols) && list.map(norm).includes(h)) cols[k] = col;
    });
    if (cols.customer_id && cols.category) {
      const valid = new Set(rows.map(r => r.customer_id));
      orderLines = []; let skipped = 0;
      for (let r = 2; r <= os.rowCount; r++) {
        const row = os.getRow(r); if (!row.hasValues) continue;
        const id = String(cellValue(row.getCell(cols.customer_id).value) ?? '').trim();
        if (!valid.has(id)) { skipped++; continue; }
        const d = cols.order_date ? toIsoDate(cellValue(row.getCell(cols.order_date).value)) : undefined;
        const amt = cols.amount ? toNumber(cellValue(row.getCell(cols.amount).value)) : undefined;
        const cat = String(cellValue(row.getCell(cols.category).value) ?? '').trim();
        orderLines.push({ customer_id: id, order_date: d ?? undefined, category: cat || undefined, amount: amt ?? undefined });
        if (cat) choices.categories.add(cat);
      }
      report.orderLines = { sheet: os.name, rows: orderLines.length, skipped };
      if (!report.columnsFound.categories) {          // derive "categories bought" from the order lines
        const byId = new Map<string, Set<string>>();
        for (const o of orderLines) if (o.category) (byId.get(o.customer_id) ?? byId.set(o.customer_id, new Set()).get(o.customer_id)!).add(o.category);
        for (const r of rows) { const c = byId.get(r.customer_id); if (c) r.categories = [...c]; }
        report.columnsFound.categories = `${os.name} → Category`;
      }
      if (skipped) report.warnings.push(`${skipped} order lines skipped: customer not in the customer sheet (or skipped there)`);
    } else report.warnings.push(`Sheet "${os.name}" ignored: it needs Customer ID and Category columns`);
  }
  if (rows.length === 0) report.errors.push('No usable rows after validation');
  if (report.errors.length) throw Object.assign(new Error('Validation failed'), { report });

  const ri = report.rowIssues;
  if (ri.missingId) report.warnings.push(`${ri.missingId} rows skipped: no Customer ID`);
  if (ri.invalidEmail) report.warnings.push(`${ri.invalidEmail} rows skipped: invalid email`);
  if (ri.internalDomain) report.warnings.push(`${ri.internalDomain} rows skipped: internal domain (${config.excludeDomains.join(', ')})`);
  if (ri.duplicateEmail) report.warnings.push(`${ri.duplicateEmail} rows skipped: duplicate email`);
  if (ri.badDate) report.warnings.push(`${ri.badDate} date cells could not be read and were left blank`);
  if (ri.badNumber) report.warnings.push(`${ri.badNumber} number cells could not be read and were left blank`);
  const fieldsAvailable = withDerived(Object.keys(report.columnsFound)
    .filter(f => f !== 'customer_id' && f !== 'email' && f !== 'phone') as FieldKey[]);
  const missing = (['last_purchase_date', 'lifetime_order_count', 'categories'] as FieldKey[]).filter(f => !fieldsAvailable.includes(f));
  if (missing.length) report.warnings.push(`Not in this file, so these filters are unavailable: ${missing.join(', ')}`);

  const now = new Date();
  return {
    id: `ds_${crypto.randomUUID().slice(0, 8)}`, source: 'excel', fileName, uploadedBy,
    uploadedAt: now.toISOString(), dataAsOf,
    expiresAt: new Date(+now + config.retentionDays * 864e5).toISOString(),
    fieldsAvailable,
    choices: { last_channel: [...choices.last_channel].sort(), city: [...choices.city].sort(), categories: [...choices.categories].sort() },
    report, rows, orderLines,
  };
}
