import { useEffect, useMemo, useRef, useState } from 'react';
import { isGroup, type Catalog, type Condition, type FieldKey, type FilterButton, type Group } from './api';
import { Icon } from './ui';

export interface Choices { last_channel: string[]; city: string[]; categories: string[] }
export interface EditorProps { catalog: Catalog; fields: FieldKey[]; choices: Choices; buttons: FilterButton[]; buttonProblem: (b: FilterButton) => string }

export const defaultValue = (type: string, op: string): unknown =>
  op === 'bought_not' ? { bought: [], notBought: [] } : (type === 'date' || type === 'number') ? (op === 'between' ? ['', ''] : '') : [];
export const newCondition = (catalog: Catalog, f: FieldKey): Condition => {
  const t = catalog.fields[f].type; const op = Object.keys(catalog.ops[t])[0];
  return { field: f, op, value: defaultValue(t, op) };
};
export const newCustom = (b: FilterButton): Condition =>
  ({ field: 'custom', op: 'include', filterId: b.id, version: b.latestVersion ?? undefined, params: Object.fromEntries(b.params.map(p => [p.name, ''])) });

const GROUPS: Array<[string, FieldKey[]]> = [
  ['Purchase timing', ['last_purchase_date', 'days_since_last_purchase', 'first_purchase_date', 'registered_at']],
  ['Value', ['lifetime_gmv', 'aov', 'lifetime_order_count']],
  ['Customer', ['customer_type', 'last_channel', 'city']],
  ['Products', ['categories']],
];

/** "+ Add filter" menu: built-in fields grouped by meaning, then the developer's buttons. */
export function AddFilterMenu({ onAdd, catalog, fields, buttons, buttonProblem, label = 'Add filter' }:
  EditorProps & { onAdd: (c: Condition) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number }>({ left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const toggle = (e: React.MouseEvent) => {
    // Fixed position so the menu is never clipped by the scrolling filter panel; opens upward near the bottom.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    setPos(below > 420 ? { left: r.left, top: r.bottom + 6 } : { left: r.left, bottom: window.innerHeight - r.top + 6 });
    setOpen(!open);
  };
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k); window.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); window.removeEventListener('scroll', close, true); };
  }, [open]);
  return <div className="menu-wrap" ref={ref}>
    <button className="btn ghost sm" onClick={toggle} aria-expanded={open}><Icon name="plus" size={15} />{label}</button>
    {open && <div className="menu" style={pos}>
      {GROUPS.map(([g, list]) => <div key={g} className="menu-group">
        <div className="menu-title">{g}</div>
        {list.map(f => <button key={f} className="menu-item" disabled={!fields.includes(f)} onClick={() => { onAdd(newCondition(catalog, f)); setOpen(false); }}>
          {catalog.fields[f].label}{!fields.includes(f) && <span className="muted small"> · not in source</span>}
        </button>)}
      </div>)}
      {buttons.length > 0 && <div className="menu-group">
        <div className="menu-title">Filter buttons (from developers)</div>
        {buttons.map(b => <button key={b.id} className="menu-item" disabled={!!buttonProblem(b)} title={buttonProblem(b) || b.description} onClick={() => { onAdd(newCustom(b)); setOpen(false); }}>
          <span className="fb-dot" />{b.label}
        </button>)}
      </div>}
    </div>}
  </div>;
}

export function GroupEditor({ g, onChange, depth, onRemove, ...p }: EditorProps & { g: Group; onChange: (g: Group) => void; depth: number; onRemove?: () => void }) {
  const update = (i: number, c: Condition | Group) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) });
  const remove = (i: number) => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) });
  const first = p.fields[0] ?? 'last_purchase_date';
  return (
    <div className={`group depth${depth}`}>
      <div className="group-head">
        <span className="muted small">Match</span>
        <div className="seg" role="radiogroup">
          {(['AND', 'OR'] as const).map(l => <button key={l} role="radio" aria-checked={g.logic === l} className={g.logic === l ? 'on' : ''} onClick={() => onChange({ ...g, logic: l })}>{l === 'AND' ? 'All' : 'Any'}</button>)}
        </div>
        <span className="muted small">of these</span>
        {onRemove && <button className="btn link sm right" onClick={onRemove}>Remove group</button>}
      </div>
      {g.conditions.length === 0 && <div className="cond empty-cond muted small">No filters yet: everyone in the data is included.</div>}
      {g.conditions.map((c, i) => <div key={i} className="cond-wrap">
        {i > 0 && <span className="joiner">{g.logic === 'AND' ? 'and' : 'or'}</span>}
        {isGroup(c)
          ? <GroupEditor g={c} onChange={x => update(i, x)} depth={depth + 1} onRemove={() => remove(i)} {...p} />
          : c.field === 'custom'
            ? <CustomRow c={c} onChange={x => update(i, x)} onRemove={() => remove(i)} {...p} />
            : <ConditionRow c={c} onChange={x => update(i, x)} onRemove={() => remove(i)} {...p} />}
      </div>)}
      <div className="row tight">
        <AddFilterMenu onAdd={c => onChange({ ...g, conditions: [...g.conditions, c] })} {...p} />
        {depth < 2 && <button className="btn ghost sm" onClick={() => onChange({ ...g, conditions: [...g.conditions, { logic: g.logic === 'AND' ? 'OR' : 'AND', conditions: [newCondition(p.catalog, first)] }] })}>
          <Icon name="plus" size={15} />Group ({g.logic === 'AND' ? 'any of' : 'all of'})</button>}
      </div>
    </div>
  );
}

export const optionsFor = (type: string, choices: Choices) =>
  type === 'customer_type' ? ['Never bought', 'One-time', 'Repeat']
    : type === 'category' || type === 'categories' ? choices.categories : type === 'channel' || type === 'last_channel' ? choices.last_channel : choices.city;

function Chips({ options, value, onChange, tone }: { options: string[]; value: string[]; onChange: (v: string[]) => void; tone?: 'ok' | 'bad' }) {
  return <div className="chips">
    {options.length === 0 && <span className="muted small">no values in source</span>}
    {options.map(o => <button type="button" key={o} className={`chip ${value.includes(o) ? `on ${tone ?? ''}` : ''}`} aria-pressed={value.includes(o)}
      onClick={() => onChange(value.includes(o) ? value.filter(x => x !== o) : [...value, o])}>{value.includes(o) && <Icon name="check" size={12} />}{o}</button>)}
  </div>;
}

/** A developer-made filter button: marketing only picks include/exclude and fills its parameters. */
function CustomRow({ c, onChange, onRemove, buttons, choices }: EditorProps & { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const b = buttons.find(x => x.id === c.filterId);
  if (!b) return <div className="cond"><span className="bad-text">This filter button was removed.</span><button className="icon-btn" onClick={onRemove}><Icon name="x" size={14} /></button></div>;
  const set = (k: string, v: unknown) => onChange({ ...c, params: { ...c.params, [k]: v } });
  const missing = b.params.some(p => !c.params?.[p.name]);
  return (
    <div className={`cond custom ${missing ? 'incomplete' : ''}`}>
      <span className="fbadge" title={b.description}><span className="fb-dot" />{b.label}</span>
      <div className="seg sm">
        {(['include', 'exclude'] as const).map(o => <button key={o} className={c.op === o ? 'on' : ''} onClick={() => onChange({ ...c, op: o })}>{o === 'include' ? 'Include' : 'Exclude'}</button>)}
      </div>
      {b.params.map(p => <label key={p.name} className="param">{p.label}
        {p.type === 'date' ? <input type="date" value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)} />
          : p.type === 'number' ? <input type="number" value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)} />
          : p.type === 'text' ? <input value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)} />
          : <select value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)}>
              <option value="">choose…</option>{optionsFor(p.type, choices).map(o => <option key={o}>{o}</option>)}
            </select>}
      </label>)}
      {b.latestVersion !== c.version && <span className="badge warn" title="The developer published a newer version">v{c.version} · newer v{b.latestVersion}</span>}
      <button className="icon-btn right" onClick={onRemove} aria-label="Remove filter"><Icon name="x" size={14} /></button>
    </div>
  );
}

function ConditionRow({ c, onChange, onRemove, catalog, fields, choices }: EditorProps & { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const field = c.field as FieldKey;
  const meta = catalog.fields[field];
  const ops = catalog.ops[meta.type];
  const unavailable = !fields.includes(field);
  const options = useMemo(() => optionsFor(field, choices), [field, choices]);
  const arr = Array.isArray(c.value) ? (c.value as string[]) : [];
  const bn = (c.value ?? { bought: [], notBought: [] }) as { bought: string[]; notBought: string[] };
  const unit = field === 'lifetime_gmv' || field === 'aov' ? '₹' : field === 'days_since_last_purchase' ? 'days' : '';
  return (
    <div className={`cond ${unavailable ? 'unavailable' : ''}`}>
      <select className="field-select" value={field} onChange={e => onChange(newCondition(catalog, e.target.value as FieldKey))}>
        {GROUPS.map(([g, list]) => <optgroup key={g} label={g}>{list.map(f => <option key={f} value={f} disabled={!fields.includes(f)}>{catalog.fields[f].label}</option>)}</optgroup>)}
      </select>
      <select value={c.op} onChange={e => onChange({ ...c, op: e.target.value, value: defaultValue(meta.type, e.target.value) })}>
        {Object.entries(ops).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      {meta.type === 'date' && c.op === 'between' && <span className="inline">
        <input type="date" value={arr[0] ?? ''} onChange={e => onChange({ ...c, value: [e.target.value, arr[1] ?? ''] })} /><span className="muted small">to</span>
        <input type="date" value={arr[1] ?? ''} onChange={e => onChange({ ...c, value: [arr[0] ?? '', e.target.value] })} />
      </span>}
      {meta.type === 'date' && (c.op === 'before' || c.op === 'on_or_after') && <input type="date" value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })} />}
      {meta.type === 'number' && c.op === 'between' && <span className="inline">
        <input className="num-input" type="number" value={arr[0] ?? ''} onChange={e => onChange({ ...c, value: [e.target.value, arr[1] ?? ''] })} /><span className="muted small">to</span>
        <input className="num-input" type="number" value={arr[1] ?? ''} onChange={e => onChange({ ...c, value: [arr[0] ?? '', e.target.value] })} />
        {unit && <span className="muted small">{unit}</span>}
      </span>}
      {meta.type === 'number' && c.op !== 'between' && <span className="inline"><input className="num-input" type="number" value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })} />{unit && <span className="muted small">{unit}</span>}</span>}
      {meta.type === 'choice' && <Chips options={options} value={arr} onChange={v => onChange({ ...c, value: v })} />}
      {meta.type === 'categories' && c.op !== 'bought_not' && <Chips options={options} value={arr} onChange={v => onChange({ ...c, value: v })} />}
      {c.op === 'bought_not' && <div className="boughtnot">
        <div><span className="bn-label ok-text">Bought</span><Chips tone="ok" options={options.filter(o => !bn.notBought.includes(o))} value={bn.bought} onChange={v => onChange({ ...c, value: { ...bn, bought: v } })} /></div>
        <div><span className="bn-label bad-text">Not bought</span><Chips tone="bad" options={options.filter(o => !bn.bought.includes(o))} value={bn.notBought} onChange={v => onChange({ ...c, value: { ...bn, notBought: v } })} /></div>
      </div>}
      <button className="icon-btn right" onClick={onRemove} aria-label="Remove filter"><Icon name="x" size={14} /></button>
    </div>
  );
}
