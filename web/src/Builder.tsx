import { useEffect, useMemo, useState } from 'react';
import { api, isGroup, post, type Catalog, type Condition, type DatasetMeta, type FieldKey, type Freshness, type Group } from './api';
import { describe } from './rules';

interface Preview {
  count: number; total: number | null; freshness: Freshness;
  breakdowns: Record<string, Array<{ label: string; count: number }>> | null;
  sample: Array<{ customer_id: string; email: string; last_purchase_date: string | null }>;
}
interface Choices { last_channel: string[]; city: string[]; categories: string[] }

const defaultValue = (type: string, op: string): unknown =>
  type === 'date' ? (op === 'between' ? ['', ''] : '') : type === 'number' ? (op === 'between' ? ['', ''] : '') : [];
const PILOT: Group = { logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'between', value: ['2025-01-01', '2025-12-31'] }] };

export default function Builder({ catalog, datasets, role, onSaved }: { catalog: Catalog; datasets: DatasetMeta[]; role?: string; onSaved: () => void }) {
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

  async function run(fn: () => Promise<void>) {
    setErr(''); setBusy(true);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const doPreview = () => run(async () => setPreview(await post<Preview>('/preview', { source, datasetId, rules })));
  const doDax = () => run(async () => { const r = await post<{ count: string; fetch: string }>('/sources/powerbi/dax', { rules }); setDax(`-- count (preview)\n${r.count}\n\n-- fetch (at approval, paged)\n${r.fetch}`); });
  const save = () => run(async () => { await post('/cohorts', { name, segmentName: segment, source, datasetId, rules }); onSaved(); });

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
        <GroupEditor g={rules} onChange={setRules} catalog={catalog} fields={fields} choices={choices} depth={0} />
        <p className="muted small summary">{describe(rules, catalog)}</p>
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

function GroupEditor({ g, onChange, catalog, fields, choices, depth, onRemove }:
  { g: Group; onChange: (g: Group) => void; catalog: Catalog; fields: FieldKey[]; choices: Choices; depth: number; onRemove?: () => void }) {
  const firstField = fields[0] ?? 'last_purchase_date';
  const update = (i: number, c: Condition | Group) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) });
  const remove = (i: number) => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) });
  const newCond = (): Condition => { const t = catalog.fields[firstField].type; const op = Object.keys(catalog.ops[t])[0]; return { field: firstField, op, value: defaultValue(t, op) }; };
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
        ? <GroupEditor key={i} g={c} onChange={x => update(i, x)} catalog={catalog} fields={fields} choices={choices} depth={depth + 1} onRemove={() => remove(i)} />
        : <ConditionRow key={i} c={c} onChange={x => update(i, x)} onRemove={() => remove(i)} catalog={catalog} fields={fields} choices={choices} />)}
      <div className="row">
        <button onClick={() => onChange({ ...g, conditions: [...g.conditions, newCond()] })}>+ Condition</button>
        {depth < 2 && <button onClick={() => onChange({ ...g, conditions: [...g.conditions, { logic: g.logic === 'AND' ? 'OR' : 'AND', conditions: [newCond()] }] })}>+ Group</button>}
      </div>
    </div>
  );
}

function ConditionRow({ c, onChange, onRemove, catalog, fields, choices }:
  { c: Condition; onChange: (c: Condition) => void; onRemove: () => void; catalog: Catalog; fields: FieldKey[]; choices: Choices }) {
  const meta = catalog.fields[c.field];
  const ops = catalog.ops[meta.type];
  const unavailable = !fields.includes(c.field);
  const options = useMemo(() => c.field === 'categories' ? choices.categories : c.field === 'last_channel' ? choices.last_channel : choices.city, [c.field, choices]);
  const arr = Array.isArray(c.value) ? (c.value as string[]) : [];
  return (
    <div className={`cond ${unavailable ? 'unavailable' : ''}`}>
      <select value={c.field} onChange={e => { const f = e.target.value as FieldKey; const t = catalog.fields[f].type; const op = Object.keys(catalog.ops[t])[0]; onChange({ field: f, op, value: defaultValue(t, op) }); }}>
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
      {(meta.type === 'choice' || meta.type === 'categories') && <div className="chips">
        {options.length === 0 && <span className="muted small">no values in source</span>}
        {options.map(o => <label key={o} className={`chip ${arr.includes(o) ? 'on' : ''}`}>
          <input type="checkbox" checked={arr.includes(o)} onChange={e => onChange({ ...c, value: e.target.checked ? [...arr, o] : arr.filter(x => x !== o) })} />{o}
        </label>)}
      </div>}
      <button className="link" onClick={onRemove} title="Remove condition">✕</button>
    </div>
  );
}
