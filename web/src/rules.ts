import { isGroup, type Catalog, type Condition, type FilterButton, type Group } from './api';

export function describe(g: Group, cat: Catalog, buttons: FilterButton[] = []): string {
  const one = (c: Condition) => {
    if (c.field === 'custom') {
      const b = buttons.find(x => x.id === c.filterId);
      const p = Object.entries(c.params ?? {}).map(([k, v]) => `${b?.params.find(x => x.name === k)?.label ?? k}: ${v}`).join(', ');
      return `${c.op === 'exclude' ? 'NOT ' : ''}[${b?.label ?? 'filter'}${p ? ` · ${p}` : ''}]`;
    }
    const f = cat.fields[c.field];
    if (c.op === 'bought_not') {
      const v = c.value as { bought: string[]; notBought: string[] };
      return `Bought ${v.bought.join(' + ') || '…'} but NOT ${v.notBought.join(' / ') || '…'}`;
    }
    const op = cat.ops[f.type][c.op] ?? c.op;
    const v = Array.isArray(c.value) ? (f.type === 'date' || f.type === 'number' ? c.value.join(' and ') : c.value.join(', ')) : c.value ?? '';
    return `${f.label} ${op}${v === '' ? '' : ' ' + v}`;
  };
  return g.conditions.map(c => (isGroup(c) ? `(${describe(c, cat, buttons)})` : one(c))).join(` ${g.logic} `);
}
