import { isGroup, type Catalog, type Condition, type Group } from './api';

export function describe(g: Group, cat: Catalog): string {
  const one = (c: Condition) => {
    const f = cat.fields[c.field];
    const op = cat.ops[f.type][c.op] ?? c.op;
    const v = Array.isArray(c.value) ? (f.type === 'date' || f.type === 'number' ? c.value.join(' and ') : c.value.join(', ')) : c.value ?? '';
    return `${f.label} ${op}${v === '' ? '' : ' ' + v}`;
  };
  return g.conditions.map(c => (isGroup(c) ? `(${describe(c, cat)})` : one(c))).join(` ${g.logic} `);
}
