import fs from 'node:fs';
import path from 'node:path';
import { CATALOG, nextDay } from '../filter.js';
import type { Condition, FieldKey, Group } from '../model.js';
import { isGroup } from '../model.js';
import { filters, renderDax } from '../customFilters.js';

export interface PbiMapping {
  customerTable: string;
  customerId: string;
  customerIdIsNumber: boolean;
  email: string;
  fields: Partial<Record<FieldKey, string | null>>;
  choices: { categories: string[]; last_channel: string[]; city: string[] };
}

export const loadMapping = (): PbiMapping =>
  JSON.parse(fs.readFileSync(path.resolve('config/powerbi-mapping.json'), 'utf8'));

export const mappedFields = (m: PbiMapping) =>
  (Object.keys(m.fields) as FieldKey[]).filter(f => m.fields[f]);

const str = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;      // DAX string escaping
const date = (iso: string) => { const [y, mo, d] = iso.split('-').map(Number); return `DATE(${y},${mo},${d})`; };
const num = (v: unknown) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error('bad number'); return String(n); };

/**
 * Rules → DAX. Only called on rules that already passed validateRules(), and only
 * with column names from the mapping file, so user input never becomes DAX code.
 * Blank handling matches the Excel engine: blank dates/numbers never match (BLANK < DATE is TRUE in DAX!).
 */
export function buildDax(rules: Group, m: PbiMapping, mode: 'count' | 'fetch', opts: { afterId?: string | number; pageSize?: number } = {}) {
  const vars: string[] = [];
  const cond = (c: Condition): string => {
    if (c.field === 'custom') {
      const def = filters.version(c.filterId!, c.version);
      if (!def?.dax) throw new Error('This filter button has no DAX for Power BI');
      const inSet = `${m.customerId} IN (${renderDax(def, c.params ?? {})})`;
      return c.op === 'exclude' ? `NOT (${inSet})` : `(${inSet})`;
    }
    const ref = m.fields[c.field];
    if (!ref) throw new Error(`Field ${c.field} is not mapped to the Power BI model`);
    const type = CATALOG[c.field].type;
    const v = c.value;
    if (type === 'date') {
      switch (c.op) {
        case 'between': { const [a, b] = v as string[]; return `(NOT ISBLANK(${ref}) && ${ref} >= ${date(a)} && ${ref} < ${date(nextDay(b))})`; }
        case 'before': return `(NOT ISBLANK(${ref}) && ${ref} < ${date(String(v))})`;
        case 'on_or_after': return `(NOT ISBLANK(${ref}) && ${ref} >= ${date(String(v))})`;
        case 'is_empty': return `ISBLANK(${ref})`;
        case 'not_empty': return `NOT ISBLANK(${ref})`;
      }
    }
    if (type === 'number') {
      if (c.op === 'between') { const [a, b] = v as unknown[]; return `(NOT ISBLANK(${ref}) && ${ref} >= ${num(a)} && ${ref} <= ${num(b)})`; }
      const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[c.op];
      return `(NOT ISBLANK(${ref}) && ${ref} ${op} ${num(v)})`;
    }
    if (type === 'choice') {
      const list = `{ ${(v as string[]).map(str).join(', ')} }`;
      return c.op === 'in' ? `${ref} IN ${list}` : `NOT (${ref} IN ${list})`;
    }
    if (type === 'categories' && c.op === 'bought_not') {
      const { bought, notBought } = v as { bought: string[]; notBought: string[] };
      const a = `Cats${vars.length + 1}`; vars.push(`    VAR ${a} = { ${bought.map(str).join(', ')} }`);
      const b = `Cats${vars.length + 1}`; vars.push(`    VAR ${b} = { ${notBought.map(str).join(', ')} }`);
      return `(COUNTROWS(INTERSECT(${a}, ${ref})) = ${bought.length} && ISEMPTY(INTERSECT(${b}, ${ref})))`;
    }
    if (type === 'categories') {
      const name = `Cats${vars.length + 1}`;
      vars.push(`    VAR ${name} = { ${(v as string[]).map(str).join(', ')} }`);
      if (c.op === 'all_of') return `COUNTROWS(INTERSECT(${name}, ${ref})) = ${(v as string[]).length}`;
      if (c.op === 'any_of') return `NOT ISEMPTY(INTERSECT(${name}, ${ref}))`;
      return `ISEMPTY(INTERSECT(${name}, ${ref}))`;
    }
    throw new Error(`Unsupported operator ${c.op}`);
  };
  const group = (g: Group): string =>
    `(${g.conditions.map(c => (isGroup(c) ? group(c) : cond(c))).join(g.logic === 'AND' ? ' && ' : ' || ')})`;

  const where = group(rules);
  const define = vars.length ? `DEFINE\n${vars.join('\n')}\n` : '';
  const table = `'${m.customerTable.replace(/'/g, "''")}'`;
  if (mode === 'count') return `${define}EVALUATE\nROW("Audience", COUNTROWS(FILTER(${table}, ${where})))`;

  const after = opts.afterId === undefined ? '' :
    `${m.customerId} > ${m.customerIdIsNumber ? num(opts.afterId) : str(opts.afterId)} && `;
  return `${define}EVALUATE\nTOPN(${opts.pageSize ?? 100000}, SELECTCOLUMNS(\n    FILTER(${table}, ${after}${where}),\n` +
    `    "customer_id", ${m.customerId}, "email", ${m.email}),\n  [customer_id], ASC)\nORDER BY [customer_id] ASC`;
}
