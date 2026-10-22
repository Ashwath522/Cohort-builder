import { useEffect, useMemo, useState } from 'react';
import { api, isGroup, post, type Catalog, type Condition, type DatasetMeta, type FieldKey, type FilterButton, type Freshness, type Group } from './api';
import { describe } from './rules';

interface Preview {
  count: number; total: number | null; freshness: Freshness;
  breakdowns: Record<string, Array<{ label: string; count: number }>> | null;
  sample: Array<{ customer_id: string; email: string; last_purchase_date: string | null }>;
}
export interface Choices { last_channel: string[]; city: string[]; categories: string[] }

const defaultValue = (type: string, op: string): unknown =>
  op === 'bought_not' ? { bought: [], notBought: [] } : (type === 'date' || type === 'number') ? (op === 'between' ? ['', ''] : '') : [];
const PILOT: Group = { logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'between', value: ['2025-01-01', '2025-12-31'] }] };

export default function Builder({ catalog, datasets, role, buttons, onSaved }:
  { catalog: Catalog; datasets: DatasetMeta[]; role?: string; buttons: FilterButton[]; onSaved: () => void }) {
  const [source, setSource] = useState<'excel' | 'powerbi'>('excel');
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '');
  const [pbi, setPbi] = useState<{ configured: boolean; fieldsAvailable: FieldKey[]; choices: Choices } | null>(null);
  const [rules, setRules] = useState<Group>(PILOT);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [dax, setDax] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('Bought in 2025, not in 2026');
  const [segment, setSegment] = useState('lapsed_2025_not_2026');
  useEffect(() => { api<typeof pbi>('/sources/powerbi').then(setPbi).catch(() => {}); }, []);
  useEffect(() => { setPreview(null); setDax(''); }, [rules, source, datasetId]);

  const ds = datasets.find(d => d.id === datasetId);
  const fields: FieldKey[] = source === 'excel' ? ds?.fieldsAvailable ?? [] : pbi?.fieldsAvailable ?? [];
  const choices: Choices = source === 'excel' ? ds?.choices ?? { last_channel: [], city: [], categories: [] } : pbi?.choices ?? { last_channel: [], city: [], categories: [] };
  const sourceReady = source === 'excel' ? Boolean(ds) : Boolean(pbi?.configured);
  const canSave = role === 'creator' || role === 'admin';
  const buttonProblem = (b: FilterButton) =>
    source === 'powerbi' && !b.worksOn.powerbi ? 'Excel only for now (no DAX yet)'
      : source === 'excel' && b.needsOrderLines && !ds?.hasOrderLines ? 'Needs an "Order Lines" sheet in the upload' : '';

  async function run(fn: () => Promise<void>) {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const doPreview = () => run(async () => setPreview(await post<Preview>('/preview', { source, datasetId, rules })));
  const doDax = () => run(async () => { const r = await post<{ count: string; fetch: string }>('/sources/powerbi/dax', { rules }); setDax(`-- count (preview)\n${r.count}\n\n-- fetch (at approval, paged)\n${r.fetch}`); });
  const save = () => run(async () => { await post('/cohorts', { name, segmentName: segment, source, datasetId, rules }); onSaved(); });
  const addButton = (b: FilterButton) => setRules({ ...rules, conditions: [...rules.conditions,
    { field: 'custom', op: 'include', filterId: b.id, version: b.latestVersion ?? undefined, params: Object.fromEntries(b.params.map(p => [p.name, ''])) }] });

  return (
    <div className="stack">
      <section className="card">
        <h2>Data source</h2>
        <div className="row">
          <label><input type="radio" checked={source === 'excel'} onChange={() => setSource('excel')} /> Excel upload</label>
          {source === 'excel' && (datasets.length
            ? <select value={datasetId} onChange={e => setDatasetId(e.target.value)}>
                {datasets.map(d => <option key={d.id} value={d.id}>{d.fileName} · {d.report.validRows.toLocaleString()} rows · as of {d.dataAsOf}</option>)}
              </select>
            : <span className="muted">Upload a file in step 1 first.</span>)}
          <label><input type="radio" checked={source === 'powerbi'} onChange={() => setSource('powerbi')} /> Power BI {pbi && !pbi.configured && <span className="pill muted">not configured</span>}</label>
        </div>
      </section>

      <section className="card">
        <h2>Filters</h2>
        {buttons.length > 0 && <div className="buttonbar">
          <span className="muted small">Filter buttons:</span>
          {buttons.map(b => <button key={b.id} className="fbtn" disabled={!!buttonProblem(b)} title={buttonProblem(b) || b.description} onClick={() => addButton(b)}>+ {b.label}</button>)}
        </div>}
        <GroupEditor g={rules} onChange={setRules} catalog={catalog} fields={fields} choices={choices} buttons={buttons} depth={0} />
        <p className="muted small summary">{describe(rules, catalog, buttons)}</p>
        <div className="row">
          <button className="primary" disabled={!sourceReady || busy} onClick={doPreview}>{busy ? 'Working…' : 'Preview count'}</button>
          <button disabled={busy} onClick={doDax} title="The DAX the app would send to Power BI for these filters">Show Power BI DAX</button>
          <button className="link" onClick={() => setRules(PILOT)}>Reset to pilot</button>
        </div>
        {err && <div className="alert bad">{err}</div>}
        {dax && <pre className="dax">{dax}</pre>}
      </section>

      {preview && <section className="card">
        <h2>Preview</h2>
        <div className="big">{preview.count.toLocaleString()} <span className="muted">customers{preview.total !== null && ` of ${preview.total.toLocaleString()}`}</span></div>
        <div className={`pill ${preview.freshness.level === 'ok' ? 'ok' : preview.freshness.level === 'warn' ? 'warn' : 'bad'}`}>
          Data as of {preview.freshness.dataAsOf?.slice(0, 10) ?? 'unknown'}{preview.freshness.daysOld !== null && ` (${preview.freshness.daysOld} days old)`}
        </div>
        {preview.breakdowns && <div className="breakdowns">
          {Object.entries({ lastPurchaseYear: 'Last purchase year', orderCount: 'Orders', lastChannel: 'Last channel', categories: 'Categories bought' }).map(([k, label]) =>
            <Bars key={k} title={label} data={preview.breakdowns![k] ?? []} max={preview.count} />)}
        </div>}
        {preview.sample.length > 0 && <>
          <h3>Sample (masked)</h3>
          <table><thead><tr><th>Customer ID</th><th>Email</th><th>Last purchase</th></tr></thead><tbody>
            {preview.sample.map(s => <tr key={s.customer_id}><td>{s.customer_id}</td><td>{s.email}</td><td>{s.last_purchase_date ?? '—'}</td></tr>)}
          </tbody></table>
        </>}
        <h3>Save as cohort</h3>
        <div className="form">
          <label>Cohort name <input value={name} onChange={e => setName(e.target.value)} /></label>
          <label>CleverTap segment name <input value={segment} onChange={e => setSegment(e.target.value)} /></label>
          <button className="primary" disabled={!canSave || busy || preview.count === 0} onClick={save}>Save draft</button>
          {!canSave && <span className="muted">Only a Creator can save cohorts.</span>}
        </div>
      </section>}
    </div>
  );
}

function Bars({ title, data, max }: { title: string; data: Array<{ label: string; count: number }>; max: number }) {
  return <div className="bars"><h4>{title}</h4>{data.map(d =>
    <div key={d.label} className="bar"><span className="lbl">{d.label}</span><span className="track"><span style={{ width: `${(d.count / Math.max(max, 1)) * 100}%` }} /></span><span className="num">{d.count.toLocaleString()}</span></div>)}</div>;
}

interface EditorProps { catalog: Catalog; fields: FieldKey[]; choices: Choices; buttons: FilterButton[] }

function GroupEditor({ g, onChange, depth, onRemove, ...p }: EditorProps & { g: Group; onChange: (g: Group) => void; depth: number; onRemove?: () => void }) {
  const firstField = p.fields[0] ?? 'last_purchase_date';
  const update = (i: number, c: Condition | Group) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) });
  const remove = (i: number) => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) });
  const newCond = (): Condition => { const t = p.catalog.fields[firstField].type; const op = Object.keys(p.catalog.ops[t])[0]; return { field: firstField, op, value: defaultValue(t, op) }; };
  return (
    <div className={`group depth${depth}`}>
      <div className="group-head">
        <span>Match</span>
        <select value={g.logic} onChange={e => onChange({ ...g, logic: e.target.value as 'AND' | 'OR' })}>
          <option value="AND">ALL of these (AND)</option><option value="OR">ANY of these (OR)</option>
        </select>
        {onRemove && <button className="link" onClick={onRemove}>Remove group</button>}
      </div>
      {g.conditions.map((c, i) => isGroup(c)
        ? <GroupEditor key={i} g={c} onChange={x => update(i, x)} depth={depth + 1} onRemove={() => remove(i)} {...p} />
        : c.field === 'custom'
          ? <CustomRow key={i} c={c} onChange={x => update(i, x)} onRemove={() => remove(i)} {...p} />
          : <ConditionRow key={i} c={c} onChange={x => update(i, x)} onRemove={() => remove(i)} {...p} />)}
      <div className="row">
        <button onClick={() => onChange({ ...g, conditions: [...g.conditions, newCond()] })}>+ Condition</button>
        {depth < 2 && <button onClick={() => onChange({ ...g, conditions: [...g.conditions, { logic: g.logic === 'AND' ? 'OR' : 'AND', conditions: [newCond()] }] })}>+ Group</button>}
      </div>
    </div>
  );
}

const optionsFor = (type: string, choices: Choices) =>
  type === 'category' || type === 'categories' ? choices.categories : type === 'channel' || type === 'last_channel' ? choices.last_channel : choices.city;

function Chips({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return <div className="chips">
    {options.length === 0 && <span className="muted small">no values in source</span>}
    {options.map(o => <label key={o} className={`chip ${value.includes(o) ? 'on' : ''}`}>
      <input type="checkbox" checked={value.includes(o)} onChange={e => onChange(e.target.checked ? [...value, o] : value.filter(x => x !== o))} />{o}
    </label>)}
  </div>;
}

/** A developer-made filter button: marketing only picks include/exclude and fills its parameters. */
function CustomRow({ c, onChange, onRemove, buttons, choices }: EditorProps & { c: Condition; onChange: (c: Condition) => void; onRemove: () => void }) {
  const b = buttons.find(x => x.id === c.filterId);
  if (!b) return <div className="cond"><span className="bad-text">This filter button was removed.</span><button className="link" onClick={onRemove}>✕</button></div>;
  const set = (k: string, v: unknown) => onChange({ ...c, params: { ...c.params, [k]: v } });
  return (
    <div className="cond custom">
      <span className="fbadge" title={b.description}>{b.label}</span>
      <select value={c.op} onChange={e => onChange({ ...c, op: e.target.value })}>
        <option value="include">include these customers</option><option value="exclude">exclude these customers</option>
      </select>
      {b.params.map(p => <label key={p.name} className="param">{p.label}
        {p.type === 'date' ? <input type="date" value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)} />
          : p.type === 'number' ? <input type="number" value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)} />
          : p.type === 'text' ? <input value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)} />
          : <select value={String(c.params?.[p.name] ?? '')} onChange={e => set(p.name, e.target.value)}>
              <option value="">choose…</option>{optionsFor(p.type, choices).map(o => <option key={o}>{o}</option>)}
            </select>}
      </label>)}
      {b.latestVersion !== c.version && <span className="pill warn" title="The developer published a newer version">v{c.version} (newer: v{b.latestVersion})</span>}
      <button className="link" onClick={onRemove} title="Remove">✕</button>
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
  return (
    <div className={`cond ${unavailable ? 'unavailable' : ''}`}>
      <select value={field} onChange={e => { const f = e.target.value as FieldKey; const t = catalog.fields[f].type; const op = Object.keys(catalog.ops[t])[0]; onChange({ field: f, op, value: defaultValue(t, op) }); }}>
        {(Object.keys(catalog.fields) as FieldKey[]).map(f => <option key={f} value={f} disabled={!fields.includes(f)}>{catalog.fields[f].label}{!fields.includes(f) ? ' (not in source)' : ''}</option>)}
      </select>
      <select value={c.op} onChange={e => onChange({ ...c, op: e.target.value, value: defaultValue(meta.type, e.target.value) })}>
        {Object.entries(ops).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      {meta.type === 'date' && c.op === 'between' && <>
        <input type="date" value={arr[0] ?? ''} onChange={e => onChange({ ...c, value: [e.target.value, arr[1] ?? ''] })} /> and
        <input type="date" value={arr[1] ?? ''} onChange={e => onChange({ ...c, value: [arr[0] ?? '', e.target.value] })} />
      </>}
      {meta.type === 'date' && (c.op === 'before' || c.op === 'on_or_after') && <input type="date" value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })} />}
      {meta.type === 'number' && c.op === 'between' && <>
        <input type="number" value={arr[0] ?? ''} onChange={e => onChange({ ...c, value: [e.target.value, arr[1] ?? ''] })} /> and
        <input type="number" value={arr[1] ?? ''} onChange={e => onChange({ ...c, value: [arr[0] ?? '', e.target.value] })} />
      </>}
      {meta.type === 'number' && c.op !== 'between' && <input type="number" value={String(c.value ?? '')} onChange={e => onChange({ ...c, value: e.target.value })} />}
      {meta.type === 'choice' && <Chips options={options} value={arr} onChange={v => onChange({ ...c, value: v })} />}
      {meta.type === 'categories' && c.op !== 'bought_not' && <Chips options={options} value={arr} onChange={v => onChange({ ...c, value: v })} />}
      {c.op === 'bought_not' && <div className="boughtnot">
        <div><span className="ok-text strong">Bought</span><Chips options={options.filter(o => !bn.notBought.includes(o))} value={bn.bought} onChange={v => onChange({ ...c, value: { ...bn, bought: v } })} /></div>
        <div><span className="bad-text strong">NOT bought</span><Chips options={options.filter(o => !bn.bought.includes(o))} value={bn.notBought} onChange={v => onChange({ ...c, value: { ...bn, notBought: v } })} /></div>
      </div>}
      <button className="link" onClick={onRemove} title="Remove condition">✕</button>
    </div>
  );
}
