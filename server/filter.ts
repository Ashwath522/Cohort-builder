import type { Condition, CustomerRow, FieldKey, Group } from './model.js';
import { isGroup } from './model.js';

export type FieldType = 'date' | 'number' | 'choice' | 'categories';

/** Filter Catalog: the ONLY fields and operators the app accepts, for every source. */
export const CATALOG: Record<FieldKey, { label: string; type: FieldType }> = {
  last_purchase_date:   { label: 'Last purchase date', type: 'date' },
  first_purchase_date:  { label: 'First purchase date', type: 'date' },
  registered_at:        { label: 'Registered on', type: 'date' },
  lifetime_order_count: { label: 'Lifetime order count', type: 'number' },
  lifetime_gmv:         { label: 'Lifetime spend (₹)', type: 'number' },
  last_channel:         { label: 'Last channel', type: 'choice' },
  city:                 { label: 'City', type: 'choice' },
  categories:           { label: 'Categories bought', type: 'categories' },
};

export const OPS: Record<FieldType, Record<string, string>> = {
  date: { between: 'is between', before: 'is before', on_or_after: 'is on or after', is_empty: 'is empty', not_empty: 'is not empty' },
  number: { gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'is between' },
  choice: { in: 'is any of', not_in: 'is none of' },
  categories: { all_of: 'includes ALL of', any_of: 'includes ANY of', none_of: 'includes NONE of' },
};

export class RuleError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_TEXT = /^[\p{L}\p{N} &\-\/.,()'_+]{1,60}$/u;   // allowed characters in a choice / category value

/** Validates the rules tree. Throws RuleError with a message the user can act on. */
export function validateRules(g: Group, fieldsAvailable: FieldKey[], depth = 0, count = { n: 0 }): void {
  if (depth > 2) throw new RuleError('Groups can be nested at most 2 levels deep');
  if (!g || !['AND', 'OR'].includes(g.logic) || !Array.isArray(g.conditions)) throw new RuleError('Invalid group');
  if (g.conditions.length === 0) throw new RuleError('A group needs at least one condition');
  for (const c of g.conditions) {
    if (isGroup(c)) { validateRules(c, fieldsAvailable, depth + 1, count); continue; }
    if (++count.n > 40) throw new RuleError('Too many conditions (max 40)');
    validateCondition(c, fieldsAvailable);
  }
}

function validateCondition(c: Condition, fieldsAvailable: FieldKey[]) {
  const meta = CATALOG[c.field];
  if (!meta) throw new RuleError(`Unknown filter "${String(c.field)}"`);
  if (!fieldsAvailable.includes(c.field)) throw new RuleError(`"${meta.label}" is not available in this data source`);
  if (!OPS[meta.type][c.op]) throw new RuleError(`Operator "${c.op}" is not allowed for "${meta.label}"`);
  const v = c.value;
  switch (meta.type) {
    case 'date':
      if (c.op === 'between') {
        if (!Array.isArray(v) || v.length !== 2 || !v.every(x => ISO.test(String(x)))) throw new RuleError(`${meta.label}: pick both dates`);
        if (String(v[0]) > String(v[1])) throw new RuleError(`${meta.label}: "from" is after "to"`);
      } else if (c.op === 'before' || c.op === 'on_or_after') {
        if (!ISO.test(String(v))) throw new RuleError(`${meta.label}: pick a date`);
      }
      break;
    case 'number':
      if (c.op === 'between') {
        if (!Array.isArray(v) || v.length !== 2 || !v.every(x => Number.isFinite(Number(x)) && x !== '')) throw new RuleError(`${meta.label}: enter both numbers`);
      } else if (!Number.isFinite(Number(v)) || v === '' || v === null) throw new RuleError(`${meta.label}: enter a number`);
      break;
    case 'choice': case 'categories':
      if (!Array.isArray(v) || v.length === 0) throw new RuleError(`${meta.label}: pick at least one value`);
      if (v.length > 50) throw new RuleError(`${meta.label}: too many values`);
      for (const x of v) if (typeof x !== 'string' || !SAFE_TEXT.test(x)) throw new RuleError(`${meta.label}: invalid value "${String(x).slice(0, 40)}"`);
  }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
export const nextDay = (iso: string) => addDays(iso, 1);

/** In-memory evaluation (Excel source). Blank dates/numbers never match, except "is empty". */
export function matches(row: CustomerRow, g: Group): boolean {
  const results = g.conditions.map(c => (isGroup(c) ? matches(row, c) : matchCondition(row, c)));
  return g.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function matchCondition(row: CustomerRow, c: Condition): boolean {
  const type = CATALOG[c.field].type;
  const raw = (row as unknown as Record<string, unknown>)[c.field];
  if (type === 'date') {
    const d = raw as string | undefined;
    if (c.op === 'is_empty') return !d;
    if (c.op === 'not_empty') return !!d;
    if (!d) return false;
    if (c.op === 'between') { const [a, b] = c.value as string[]; return d >= a && d <= b; }
    if (c.op === 'before') return d < String(c.value);
    if (c.op === 'on_or_after') return d >= String(c.value);
  }
  if (type === 'number') {
    if (raw === undefined || raw === null) return false;
    const n = Number(raw);
    if (c.op === 'between') { const [a, b] = (c.value as unknown[]).map(Number); return n >= a && n <= b; }
    const x = Number(c.value);
    return ({ gt: n > x, gte: n >= x, lt: n < x, lte: n <= x } as Record<string, boolean>)[c.op];
  }
  if (type === 'choice') {
    const set = (c.value as string[]).map(s => s.toLowerCase());
    const has = raw !== undefined && set.includes(String(raw).toLowerCase());
    return c.op === 'in' ? has : !has;
  }
  if (type === 'categories') {
    const mine = new Set((row.categories ?? []).map(s => s.toLowerCase()));
    const want = (c.value as string[]).map(s => s.toLowerCase());
    if (c.op === 'all_of') return want.every(w => mine.has(w));
    if (c.op === 'any_of') return want.some(w => mine.has(w));
    if (c.op === 'none_of') return want.every(w => !mine.has(w));
  }
  return false;
}

/** Breakdowns for the preview screen. Counts only, no identities. */
export function breakdowns(rows: CustomerRow[]) {
  const tally = (key: (r: CustomerRow) => string | string[] | undefined) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = key(r);
      for (const x of Array.isArray(k) ? k : [k ?? '(blank)']) m.set(x, (m.get(x) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, count]) => ({ label, count }));
  };
  const band = (n?: number) => n === undefined ? '(blank)' : n === 0 ? '0 (never bought)' : n === 1 ? '1 (one-time)' : n <= 3 ? '2–3' : '4+';
  return {
    lastPurchaseYear: tally(r => r.last_purchase_date?.slice(0, 4) ?? '(never)'),
    orderCount: tally(r => band(r.lifetime_order_count)),
    lastChannel: tally(r => r.last_channel),
    categories: tally(r => (r.categories?.length ? r.categories : ['(none)'])),
  };
}
