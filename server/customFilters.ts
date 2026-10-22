/**
 * Developer-defined filter buttons.
 * A developer writes a SQL query (and optionally DAX for Power BI) that returns customer IDs,
 * names the button (e.g. "Not bought"), tests it and publishes it. Marketing then sees it as a
 * button in the filter builder and only fills in its parameters (e.g. which category).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { config } from './config.js';
import { RuleError, SAFE_TEXT } from './filter.js';
import type { Condition, CustomFilter, Dataset, FilterDefinition, FilterParam, ParamType } from './model.js';

// ───────────────────────── storage ─────────────────────────
const FILE = path.join(config.dataDir, 'filters.json');
const read = (): CustomFilter[] => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const write = (all: CustomFilter[]) => { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(all, null, 1)); fs.renameSync(FILE + '.tmp', FILE); };

export const filters = {
  all: read,
  get: (id: string) => read().find(f => f.id === id),
  save: (f: CustomFilter) => write([f, ...read().filter(x => x.id !== f.id)]),
  /** Published version n of a filter (or the latest published). */
  version: (id: string, v?: number) => {
    const f = read().find(x => x.id === id);
    if (!f) return undefined;
    return v === undefined ? f.versions.at(-1) : f.versions.find(x => x.version === v);
  },
};

// ───────────────────────── checks on a definition ─────────────────────────
export const PARAM_TYPES: ParamType[] = ['number', 'date', 'text', 'category', 'channel', 'city'];
export const SCHEMA = {
  customers: ['customer_id', 'registered_at', 'first_purchase_date', 'last_purchase_date', 'lifetime_order_count', 'lifetime_gmv', 'last_channel', 'city'],
  customer_categories: ['customer_id', 'category'],
  order_lines: ['customer_id', 'order_date', 'category', 'amount'],
};

/** SQL text with string literals and comments blanked out, so keyword checks can't be fooled. */
const stripSql = (sql: string) => sql
  .replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|replace\s+into|vacuum|reindex|savepoint|begin|commit|rollback|load_extension)\b/i;

/** Names used as :name in a query (outside strings / comments). */
export const placeholders = (q: string) => [...new Set([...stripSql(q).matchAll(/(?<![:\w]):([A-Za-z_]\w*)/g)].map(m => m[1]))];

export function checkDefinition(d: FilterDefinition): string[] {
  const errs: string[] = [];
  if (!d.label?.trim() || d.label.length > 40) errs.push('Button name: 1–40 characters');
  if (!Array.isArray(d.params)) errs.push('Parameters must be a list');
  const names = new Set<string>();
  for (const p of d.params ?? []) {
    if (!/^[A-Za-z_]\w{0,30}$/.test(p.name)) errs.push(`Parameter "${p.name}": letters, numbers, _ only`);
    if (names.has(p.name)) errs.push(`Parameter "${p.name}" is defined twice`);
    names.add(p.name);
    if (!PARAM_TYPES.includes(p.type)) errs.push(`Parameter "${p.name}": unknown type`);
    if (!p.label?.trim()) errs.push(`Parameter "${p.name}": give it a label`);
  }
  const sql = stripSql(d.sql ?? '').trim();
  if (!/^(select|with)\b/i.test(sql)) errs.push('SQL must start with SELECT or WITH');
  if (FORBIDDEN.test(sql)) errs.push(`SQL can only read data (found "${sql.match(FORBIDDEN)![0]}")`);
  if (/;\s*\S/.test(sql)) errs.push('Only one SQL statement is allowed');
  for (const n of placeholders(d.sql ?? '')) if (!names.has(n)) errs.push(`SQL uses :${n} but there is no parameter "${n}"`);
  if (d.dax?.trim()) for (const n of placeholders(d.dax)) if (!names.has(n)) errs.push(`DAX uses :${n} but there is no parameter "${n}"`);
  return errs;
}

/** Validates a marketing user's values for a filter's parameters; returns them cleaned. */
export function cleanParams(def: FilterDefinition, values: Record<string, unknown> = {}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const p of def.params) {
    const v = values[p.name];
    if (v === undefined || v === null || v === '') throw new RuleError(`${def.label}: fill in "${p.label}"`);
    if (p.type === 'number') {
      const n = Number(v); if (!Number.isFinite(n)) throw new RuleError(`${def.label}: "${p.label}" must be a number`); out[p.name] = n;
    } else if (p.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new RuleError(`${def.label}: "${p.label}" must be a date`); out[p.name] = String(v);
    } else {
      if (!SAFE_TEXT.test(String(v))) throw new RuleError(`${def.label}: "${p.label}" has characters that aren't allowed`); out[p.name] = String(v);
    }
  }
  return out;
}

/** Validates a custom condition inside cohort rules. */
export function validateCustomCondition(c: Condition, source: 'excel' | 'powerbi', ds?: Dataset) {
  if (!['include', 'exclude'].includes(c.op)) throw new RuleError('Custom filter: choose include or exclude');
  const f = c.filterId ? filters.get(c.filterId) : undefined;
  if (!f || f.status === 'archived') throw new RuleError('This filter button no longer exists');
  const def = filters.version(f.id, c.version);
  if (!def) throw new RuleError(`"${f.draft.label}" has no published version ${c.version ?? ''}`.trim());
  cleanParams(def, c.params);
  if (source === 'powerbi' && !def.dax?.trim()) throw new RuleError(`"${def.label}" works on uploaded data only (no DAX written yet)`);
  if (source === 'excel' && /\border_lines\b/i.test(def.sql) && !ds?.orderLines?.length)
    throw new RuleError(`"${def.label}" needs order lines; this file has no "Order Lines" sheet`);
}

// ───────────────────────── SQL engine (uploaded data) ─────────────────────────
let SQL: SqlJsStatic | null = null;
const dbCache = new Map<string, Database>();   // dataset id → in-memory SQLite (no emails in it)

async function dbFor(ds: Dataset): Promise<Database> {
  SQL ??= await initSqlJs();
  const hit = dbCache.get(ds.id);
  if (hit) return hit;
  const db = new SQL.Database();
  db.run(`CREATE TABLE customers(customer_id TEXT PRIMARY KEY, registered_at TEXT, first_purchase_date TEXT, last_purchase_date TEXT,
            lifetime_order_count REAL, lifetime_gmv REAL, last_channel TEXT, city TEXT);
          CREATE TABLE customer_categories(customer_id TEXT, category TEXT);
          CREATE TABLE order_lines(customer_id TEXT, order_date TEXT, category TEXT, amount REAL);`);
  db.run('BEGIN');
  const c = db.prepare('INSERT OR IGNORE INTO customers VALUES (?,?,?,?,?,?,?,?)');
  const cc = db.prepare('INSERT INTO customer_categories VALUES (?,?)');
  for (const r of ds.rows) {
    c.run([r.customer_id, r.registered_at ?? null, r.first_purchase_date ?? null, r.last_purchase_date ?? null,
      r.lifetime_order_count ?? null, r.lifetime_gmv ?? null, r.last_channel ?? null, r.city ?? null]);
    for (const cat of r.categories ?? []) cc.run([r.customer_id, cat]);
  }
  const ol = db.prepare('INSERT INTO order_lines VALUES (?,?,?,?)');
  for (const o of ds.orderLines ?? []) ol.run([o.customer_id, o.order_date ?? null, o.category ?? null, o.amount ?? null]);
  c.free(); cc.free(); ol.free();
  db.run('COMMIT');
  db.run('CREATE INDEX ix_cc ON customer_categories(category, customer_id); CREATE INDEX ix_ol ON order_lines(category, customer_id)');
  if (dbCache.size >= 3) { const [k, old] = dbCache.entries().next().value!; old.close(); dbCache.delete(k); }
  dbCache.set(ds.id, db);
  return db;
}
export const forgetDataset = (id: string) => { dbCache.get(id)?.close(); dbCache.delete(id); };

/** Runs a filter's SQL; returns the set of customer IDs it selects. */
export async function runSql(ds: Dataset, def: FilterDefinition, values: Record<string, unknown>) {
  const errs = checkDefinition(def);
  if (errs.length) throw new RuleError(errs.join('; '));
  const params = cleanParams(def, values);
  const db = await dbFor(ds);
  const t0 = Date.now();
  let stmt;
  try { stmt = db.prepare(def.sql); } catch (e) { throw new RuleError(`SQL error: ${(e as Error).message}`); }
  try {
    const names = placeholders(def.sql);
    if (names.length) stmt.bind(Object.fromEntries(names.map(n => [`:${n}`, params[n]])));
    const cols = stmt.getColumnNames();
    if (!cols.includes('customer_id')) throw new RuleError(`The query must return a "customer_id" column (it returns: ${cols.join(', ') || 'nothing'})`);
    const ids = new Set<string>();
    while (stmt.step()) {
      const v = stmt.getAsObject().customer_id;
      if (v !== null && v !== undefined) ids.add(String(v));
      if (ids.size > 5_000_000) throw new RuleError('Query returned too many rows');
    }
    return { ids, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof RuleError) throw e;
    throw new RuleError(`SQL error: ${(e as Error).message}`);
  } finally { stmt.free(); }
}

// ───────────────────────── DAX (Power BI) ─────────────────────────
const daxLiteral = (p: FilterParam, v: string | number) => {
  if (p.type === 'number') return String(v);
  if (p.type === 'date') { const [y, m, d] = String(v).split('-').map(Number); return `DATE(${y},${m},${d})`; }
  return `"${String(v).replace(/"/g, '""')}"`;
};
/** Fills :params in the filter's DAX with safe literals. Result = a one-column table of customer IDs. */
export function renderDax(def: FilterDefinition, values: Record<string, unknown>) {
  const params = cleanParams(def, values);
  return def.dax!.replace(/(?<![:\w]):([A-Za-z_]\w*)/g, (m, n) => {
    const p = def.params.find(x => x.name === n);
    return p ? daxLiteral(p, params[n]) : m;
  });
}

// ───────────────────────── examples (created once) ─────────────────────────
export function seedExamples() {
  if (read().length) return;
  const now = new Date().toISOString();
  const mk = (d: FilterDefinition): CustomFilter => ({
    id: `f_${crypto.randomUUID().slice(0, 8)}`, draft: d, status: 'published', createdBy: 'system', createdAt: now, updatedAt: now,
    versions: [{ ...d, version: 1, publishedBy: 'system', publishedAt: now }],
  });
  write([
    mk({
      label: 'Bought X, not Y',
      description: 'Ever bought the first category but never the second (e.g. Bed but not Mattress).',
      params: [{ name: 'bought', label: 'Bought', type: 'category' }, { name: 'not_bought', label: 'Not bought', type: 'category' }],
      sql: `SELECT customer_id FROM customer_categories WHERE category = :bought\nEXCEPT\nSELECT customer_id FROM customer_categories WHERE category = :not_bought`,
      dax: `EXCEPT(\n  CALCULATETABLE(VALUES('OrderLines'[Customer ID]), 'OrderLines'[Category] = :bought),\n  CALCULATETABLE(VALUES('OrderLines'[Customer ID]), 'OrderLines'[Category] = :not_bought))`,
    }),
    mk({
      label: 'Not bought since',
      description: 'Bought at least once, but nothing on or after the chosen date.',
      params: [{ name: 'since', label: 'Since', type: 'date' }],
      sql: `SELECT customer_id FROM customers\nWHERE last_purchase_date IS NOT NULL AND last_purchase_date < :since`,
      dax: `CALCULATETABLE(VALUES('Customers'[Customer ID]), NOT ISBLANK('Customers'[Last_Purchase_Date]), 'Customers'[Last_Purchase_Date] < :since)`,
    }),
    mk({
      label: 'Bought category in year',
      description: 'Bought the category during the given calendar year (needs the Order Lines sheet).',
      params: [{ name: 'category', label: 'Category', type: 'category' }, { name: 'year', label: 'Year', type: 'number' }],
      sql: `SELECT DISTINCT customer_id FROM order_lines\nWHERE category = :category AND substr(order_date, 1, 4) = CAST(:year AS TEXT)`,
    }),
  ]);
}
