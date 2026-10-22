import type { Condition, CustomerRow, FieldKey, Group } from './model.js';
import { isGroup } from './model.js';

export type FieldType = 'date' | 'number' | 'choice' | 'categories';

/** Filter Catalog: the built-in fields and operators the app accepts, for every source. */
export const CATALOG: Record<FieldKey, { label: string; type: FieldType }> = {
  last_purchase_date:   { label: 'Last purchase date', type: 'date' },
  first_purchase_date:  { label: 'First purchase date', type: 'date' },
  registered_at:        { label: 'Registered on', type: 'date' },
  lifetime_order_count: { label: 'Lifetime order count', type: 'number' },
  lifetime_gmv:         { label: 'Lifetime spend (₹)', type: 'number' },
  last_channel:         { label: 'Last channel', type: 'choice' },
  city:                 { label: 'City', type: 'choice' },
  categories:           { label: 'Categories', type: 'categories' },
  days_since_last_purchase: { label: 'Days since last purchase', type: 'number' },
  aov:                  { label: 'Avg order value (₹)', type: 'number' },
  customer_type:        { label: 'Customer type', type: 'choice' },
};
export const CUSTOMER_TYPES = ['Never bought', 'One-time', 'Repeat'];

/** Derived fields exist when the fields they are computed from exist. */
export function withDerived(fields: FieldKey[]): FieldKey[] {
  const out = new Set(fields);
  if (fields.includes('last_purchase_date')) out.add('days_since_last_purchase');
  if (fields.includes('lifetime_gmv') && fields.includes('lifetime_order_count')) out.add('aov');
  if (fields.includes('lifetime_order_count')) out.add('customer_type');
  return [...out];
}
const DAY = 864e5;
export const customerType = (n?: number) => (!n ? 'Never bought' : n === 1 ? 'One-time' : 'Repeat');
/** A row's value for any field, derived ones included. `asOf` = the data's date (for "days since"). */
export function fieldValue(row: CustomerRow, f: FieldKey, asOf: string): unknown {
  switch (f) {
    case 'days_since_last_purchase': return row.last_purchase_date ? Math.floor((Date.parse(asOf) - Date.parse(row.last_purchase_date)) / DAY) : undefined;
    case 'aov': return row.lifetime_order_count ? (row.lifetime_gmv ?? 0) / row.lifetime_order_count : undefined;
    case 'customer_type': return row.lifetime_order_count === undefined ? undefined : customerType(row.lifetime_order_count);
    default: return (row as unknown as Record<string, unknown>)[f];
  }
}

export const OPS: Record<FieldType, Record<string, string>> = {
  date: { between: 'is between', before: 'is before', on_or_after: 'is on or after', is_empty: 'is empty', not_empty: 'is not empty' },
  number: { gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'is between' },
  choice: { in: 'is any of', not_in: 'is none of' },
  categories: { bought_not: 'bought … but NOT …', all_of: 'bought ALL of', any_of: 'bought ANY of', none_of: 'bought NONE of' },
};

export class RuleError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const SAFE_TEXT = /^[\p{L}\p{N} &\-\/.,()'_+]{1,60}$/u;   // allowed characters in a choice / category / text value

/** What validation needs to know about the source and the custom filters. */
export interface RuleEnv {
  fieldsAvailable: FieldKey[];
  validateCustom: (c: Condition) => void;     // throws RuleError
}

/** Validates the rules tree. Throws RuleError with a message the user can act on. */
export function validateRules(g: Group, env: RuleEnv, depth = 0, count = { n: 0 }): void {
  if (depth > 2) throw new RuleError('Groups can be nested at most 2 levels deep');
  if (!g || !['AND', 'OR'].includes(g.logic) || !Array.isArray(g.conditions)) throw new RuleError('Invalid group');
  if (g.conditions.length === 0) throw new RuleError('A group needs at least one condition');
  for (const c of g.conditions) {
    if (isGroup(c)) { validateRules(c, env, depth + 1, count); continue; }
    if (++count.n > 40) throw new RuleError('Too many conditions (max 40)');
    if (c.field === 'custom') env.validateCustom(c);
    else validateCondition(c, env.fieldsAvailable);
  }
}

const textList = (label: string, v: unknown, allowEmpty = false) => {
  if (!Array.isArray(v) || (!allowEmpty && v.length === 0)) throw new RuleError(`${label}: pick at least one value`);
  if (v.length > 50) throw new RuleError(`${label}: too many values`);
  for (const x of v) if (typeof x !== 'string' || !SAFE_TEXT.test(x)) throw new RuleError(`${label}: invalid value "${String(x).slice(0, 40)}"`);
  return v as string[];
};

function validateCondition(c: Condition, fieldsAvailable: FieldKey[]) {
  const meta = CATALOG[c.field as FieldKey];
  if (!meta) throw new RuleError(`Unknown filter "${String(c.field)}"`);
  if (!fieldsAvailable.includes(c.field as FieldKey)) throw new RuleError(`"${meta.label}" is not available in this data source`);
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
    case 'choice':
      textList(meta.label, v);
      break;
    case 'categories':
      if (c.op === 'bought_not') {
        const o = (v ?? {}) as { bought?: unknown; notBought?: unknown };
        const b = textList(`${meta.label} (bought)`, o.bought);
        const n = textList(`${meta.label} (not bought)`, o.notBought);
        if (b.some(x => n.includes(x))) throw new RuleError(`${meta.label}: a category can't be both bought and not bought`);
      } else textList(meta.label, v);
  }
}

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10);
export const nextDay = (iso: string) => addDays(iso, 1);

/** All custom-filter conditions in a rules tree. */
export function customConditions(g: Group): Condition[] {
  return g.conditions.flatMap(c => (isGroup(c) ? customConditions(c) : c.field === 'custom' ? [c] : []));
}

/** Custom filter results, resolved before evaluation: condition → set of matching customer IDs. */
export type CustomSets = Map<Condition, Set<string>>;

export interface EvalCtx { sets?: CustomSets; asOf?: string }

/** In-memory evaluation (Excel source). Blank dates/numbers never match, except "is empty". */
export function matches(row: CustomerRow, g: Group, ctx: EvalCtx = {}): boolean {
  const results = g.conditions.map(c => (isGroup(c) ? matches(row, c, ctx) : matchCondition(row, c, ctx)));
  return g.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

function matchCondition(row: CustomerRow, c: Condition, { sets = new Map(), asOf = new Date().toISOString().slice(0, 10) }: EvalCtx): boolean {
  if (c.field === 'custom') {
    const set = sets.get(c);
    if (!set) throw new Error('Custom filter was not resolved');
    return c.op === 'exclude' ? !set.has(row.customer_id) : set.has(row.customer_id);
  }
  const type = CATALOG[c.field].type;
  const raw = fieldValue(row, c.field, asOf);
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
    if (c.op === 'bought_not') {
      const { bought, notBought } = c.value as { bought: string[]; notBought: string[] };
      return bought.every(b => mine.has(b.toLowerCase())) && notBought.every(n => !mine.has(n.toLowerCase()));
    }
    const want = (c.value as string[]).map(s => s.toLowerCase());
    if (c.op === 'all_of') return want.every(w => mine.has(w));
    if (c.op === 'any_of') return want.some(w => mine.has(w));
    if (c.op === 'none_of') return want.every(w => !mine.has(w));
  }
  return false;
}

/** Analytics for the preview screen: KPIs and chart data. Counts and sums only, never identities. */
export function analytics(rows: CustomerRow[], total: number, asOf: string) {
  const count = <K extends string>(order: K[], key: (r: CustomerRow) => K | undefined) => {
    const m = new Map<string, number>(order.map(k => [k, 0]));
    for (const r of rows) { const k = key(r); if (k !== undefined) m.set(k, (m.get(k) ?? 0) + 1); }
    return order.map(label => ({ label, count: m.get(label) ?? 0 }));
  };
  const top = (key: (r: CustomerRow) => string[] | string | undefined, n: number) => {
    const m = new Map<string, number>();
    for (const r of rows) { const k = key(r); for (const x of Array.isArray(k) ? k : k ? [k] : []) m.set(x, (m.get(x) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([label, count]) => ({ label, count }));
  };
  const days = (r: CustomerRow) => fieldValue(r, 'days_since_last_purchase', asOf) as number | undefined;
  const buyers = rows.filter(r => (r.lifetime_order_count ?? 0) > 0);
  const gmv = rows.reduce((s, r) => s + (r.lifetime_gmv ?? 0), 0);
  const orders = rows.reduce((s, r) => s + (r.lifetime_order_count ?? 0), 0);
  const dl = buyers.map(days).filter((d): d is number => d !== undefined).sort((a, b) => a - b);
  const RECENCY = ['0–90 days', '91–180 days', '181–365 days', '1–2 years', '2+ years', 'Never bought'];
  const SPEND = ['₹0', '< ₹10k', '₹10k–25k', '₹25k–50k', '₹50k–1L', '₹1L+'];
  return {
    kpis: {
      audience: rows.length, shareOfBase: total ? rows.length / total : 0,
      lifetimeGmv: gmv, avgSpend: buyers.length ? gmv / buyers.length : 0,
      avgOrders: buyers.length ? orders / buyers.length : 0,
      medianDaysSinceLast: dl.length ? dl[Math.floor(dl.length / 2)] : null,
      buyers: buyers.length,
    },
    customerType: count(CUSTOMER_TYPES, r => r.lifetime_order_count === undefined ? undefined : customerType(r.lifetime_order_count)),
    channel: top(r => r.last_channel, 6),
    recency: count(RECENCY, r => { const d = days(r); return d === undefined ? 'Never bought' : d <= 90 ? RECENCY[0] : d <= 180 ? RECENCY[1] : d <= 365 ? RECENCY[2] : d <= 730 ? RECENCY[3] : RECENCY[4]; }),
    spend: count(SPEND, r => { const g = r.lifetime_gmv ?? 0; return g <= 0 ? SPEND[0] : g < 1e4 ? SPEND[1] : g < 25e3 ? SPEND[2] : g < 5e4 ? SPEND[3] : g < 1e5 ? SPEND[4] : SPEND[5]; }),
    categories: top(r => r.categories, 10),
    cities: top(r => r.city, 8),
  };
}
