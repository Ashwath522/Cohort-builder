import { useEffect, useMemo, useState } from 'react';
import { api, isGroup, post, type Catalog, type Condition, type DatasetMeta, type Delivery, type FieldKey, type FilterButton, type Freshness, type Group, type SortKey } from './api';
import { Columns, Donut, Funnel, HBars, inr, Kpi } from './Charts';
import { describe } from './rules';

type D = Array<{ label: string; count: number }>;
interface Analytics {
  kpis: { audience: number; shareOfBase: number; lifetimeGmv: number; avgSpend: number; avgOrders: number; medianDaysSinceLast: number | null; buyers: number };
  customerType: D; channel: D; recency: D; spend: D; categories: D; cities: D;
}
interface Preview { count: number; total: number | null; freshness: Freshness; analytics: Analytics | null; funnel: Array<{ step: string; count: number; aside?: boolean }> | null }
interface RowPage { total: number; page: number; pageSize: number; rows: Array<Record<string, unknown> & { customer_id: string; categories: string[] }> }
const DEFAULT_DELIVERY: Delivery = { sortBy: 'lifetime_gmv', dir: 'desc', holdoutPct: 0, suppressDays: 0 };
const DATE_SORTS: SortKey[] = ['last_purchase_date', 'first_purchase_date', 'registered_at'];
const dirLabel = (k: SortKey, d: 'asc' | 'desc') => DATE_SORTS.includes(k) ? (d === 'desc' ? 'Newest first' : 'Oldest first') : (d === 'desc' ? 'Highest first' : 'Lowest first');
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
  const [delivery, setDelivery] = useState<Delivery>(DEFAULT_DELIVERY);
  const [rows, setRows] = useState<RowPage | null>(null);
  const [page, setPage] = useState(1);
  const [name, setName] = useState('Bought in 2025, not in 2026');
  const [segment, setSegment] = useState('lapsed_2025_not_2026');
  useEffect(() => { api<typeof pbi>('/sources/powerbi').then(setPbi).catch(() => {}); }, []);
  useEffect(() => { setPreview(null); setRows(null); setDax(''); setPage(1); }, [rules, source, datasetId]);
  // Delivery or sort changed after a preview → refresh the funnel and the table.
  useEffect(() => { if (preview) refresh(page); /* eslint-disable-line */ }, [delivery, page, segment]);

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
  async function refresh(p: number) {
    try {
      setErr('');
      const pv = await post<Preview>('/preview', { source, datasetId, rules, delivery, segmentName: segment });
      setPreview(pv);
      if (source === 'excel') setRows(await post<RowPage>('/preview/rows', { source, datasetId, rules, sortBy: delivery.sortBy, dir: delivery.dir, page: p, pageSize: 25 }));
    } catch (e) { setErr((e as Error).message); }
  }
  const doPreview = () => run(async () => { setPage(1); await refresh(1); });
  const sortBy = (k: SortKey) => { setPage(1); setDelivery({ ...delivery, sortBy: k, dir: delivery.sortBy === k && delivery.dir === 'desc' ? 'asc' : 'desc' }); };
  const doDax = () => run(async () => { const r = await post<{ count: string; fetch: string }>('/sources/powerbi/dax', { rules }); setDax(`-- count (preview)\n${r.count}\n\n-- fetch (at approval, paged)\n${r.fetch}`); });
  const save = () => run(async () => { await post('/cohorts', { name, segmentName: segment, source, datasetId, rules, delivery }); onSaved(); });
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

      {preview && <PreviewPanel preview={preview} source={source} catalog={catalog} delivery={delivery} setDelivery={setDelivery}
        rows={rows} page={page} setPage={setPage} sortBy={sortBy} />}

      {preview && <section className="card">
        <h2>Save as cohort</h2>
        <p className="muted small">Saves the filters <b>and</b> the delivery rules above. Approval locks exactly who will be sent.</p>
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

function PreviewPanel({ preview, source, catalog, delivery, setDelivery, rows, page, setPage, sortBy }: {
  preview: Preview; source: string; catalog: Catalog; delivery: Delivery; setDelivery: (d: Delivery) => void;
  rows: RowPage | null; page: number; setPage: (p: number) => void; sortBy: (k: SortKey) => void;
}) {
  const a = preview.analytics, k = a?.kpis;
  const fr = preview.freshness;
  const cols: Array<[string, string, SortKey | null]> = [
    ['customer_id', 'Customer ID', null], ['email', 'Email (masked)', null], ['city', 'City', null], ['last_channel', 'Channel', null],
    ['registered_at', 'Registered', 'registered_at'], ['last_purchase_date', 'Last purchase', 'last_purchase_date'],
    ['days_since_last_purchase', 'Days since', 'days_since_last_purchase'], ['lifetime_order_count', 'Orders', 'lifetime_order_count'],
    ['lifetime_gmv', 'Lifetime spend', 'lifetime_gmv'], ['aov', 'Avg order', 'aov'], ['categories', 'Categories', null],
  ];
  const fmt = (key: string, v: unknown) => v === null || v === undefined ? '—'
    : key === 'lifetime_gmv' || key === 'aov' ? `₹${Math.round(Number(v)).toLocaleString('en-IN')}`
    : Array.isArray(v) ? v.join(', ') : String(v);
  return <>
    <section className="card">
      <div className="row space">
        <h2>Audience</h2>
        <span className={`pill ${fr.level === 'ok' ? 'ok' : fr.level === 'warn' ? 'warn' : 'bad'}`}>Data as of {fr.dataAsOf?.slice(0, 10) ?? 'unknown'}{fr.daysOld !== null && ` · ${fr.daysOld} days old`}</span>
      </div>
      {k ? <div className="kpis">
        <Kpi hero label="Customers matched" value={k.audience.toLocaleString()} sub={`${(k.shareOfBase * 100).toFixed(1)}% of ${preview.total?.toLocaleString()} in the data`} />
        <Kpi label="Lifetime spend" value={inr(k.lifetimeGmv)} sub="all orders, all time" />
        <Kpi label="Avg spend per buyer" value={inr(k.avgSpend)} sub={`${k.buyers.toLocaleString()} buyers`} />
        <Kpi label="Avg orders per buyer" value={k.avgOrders.toFixed(1)} />
        <Kpi label="Median days since last order" value={k.medianDaysSinceLast === null ? '—' : String(k.medianDaysSinceLast)} sub="buyers only" />
      </div> : <div className="kpis"><Kpi hero label="Customers matched" value={preview.count.toLocaleString()} sub="Power BI preview shows the count only" /></div>}
      {a && <div className="charts">
        <Donut title="Customer type" data={a.customerType} note="Repeat buyers usually respond best to new-collection offers; one-time buyers to a second-order nudge." />
        <Donut title="Last channel" data={a.channel.slice(0, 3)} note={a.channel.length > 3 ? `Top 3 of ${a.channel.length} channels shown.` : undefined} />
        <Columns title="Recency: time since last purchase" data={a.recency} note="Older buckets are win-back targets; 0–90 days are still warm." />
        <Columns title="Lifetime spend band" data={a.spend} />
        <HBars title="Top categories bought" data={a.categories} base={preview.count} note="A customer can appear in several categories." />
        <HBars title="Top cities" data={a.cities} base={preview.count} />
      </div>}
    </section>

    <section className="card">
      <h2>Who gets it <span className="muted small">— business rules applied when the cohort is approved</span></h2>
      <div className="form">
        <label>Order customers by
          <select value={delivery.sortBy} onChange={e => setDelivery({ ...delivery, sortBy: e.target.value as SortKey })}>
            {Object.entries(catalog.sorts).map(([k2, v]) => <option key={k2} value={k2}>{v}</option>)}
          </select>
        </label>
        <label>Direction
          <select value={delivery.dir} onChange={e => setDelivery({ ...delivery, dir: e.target.value as 'asc' | 'desc' })}>
            <option value="desc">{dirLabel(delivery.sortBy, 'desc')}</option><option value="asc">{dirLabel(delivery.sortBy, 'asc')}</option>
          </select>
        </label>
        <label>Send to
          <span className="inline">
            <select value={delivery.limit ? 'top' : 'all'} disabled={source === 'powerbi'} onChange={e => setDelivery({ ...delivery, limit: e.target.value === 'top' ? Math.min(1000, preview.count) || 1 : undefined })}>
              <option value="all">Everyone matched</option><option value="top">Only the top…</option>
            </select>
            {delivery.limit !== undefined && <input type="number" min={1} value={delivery.limit} onChange={e => setDelivery({ ...delivery, limit: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 100 }} />}
          </span>
        </label>
        <label>Control group (not sent)
          <select value={delivery.holdoutPct} onChange={e => setDelivery({ ...delivery, holdoutPct: Number(e.target.value) })}>
            {[0, 5, 10, 20].map(p => <option key={p} value={p}>{p === 0 ? 'None' : `${p}% — to measure lift`}</option>)}
          </select>
        </label>
        <label>Skip people messaged in the last
          <select value={delivery.suppressDays} onChange={e => setDelivery({ ...delivery, suppressDays: Number(e.target.value) })}>
            {[0, 7, 14, 30, 60].map(d => <option key={d} value={d}>{d === 0 ? 'Off' : `${d} days`}</option>)}
          </select>
        </label>
      </div>
      {source === 'powerbi' && <p className="muted small">"Only the top…" needs the customer details, which Power BI doesn't send yet; control group and skip rules still apply.</p>}
      {preview.funnel && <Funnel steps={preview.funnel} />}
    </section>

    {rows && <section className="card">
      <div className="row space">
        <h2>Customers <span className="muted small">— sorted by {catalog.sorts[delivery.sortBy].toLowerCase()}, {dirLabel(delivery.sortBy, delivery.dir).toLowerCase()} · this order decides "Only the top…"</span></h2>
        <span className="muted small">{rows.total.toLocaleString()} rows</span>
      </div>
      <div className="table-scroll"><table className="results">
        <thead><tr>{cols.map(([key, label, sk]) => <th key={key} className={sk ? 'sortable' : ''} onClick={() => sk && sortBy(sk)}>
          {label}{sk && delivery.sortBy === sk && <span className="arrow">{delivery.dir === 'desc' ? ' ▼' : ' ▲'}</span>}</th>)}</tr></thead>
        <tbody>{rows.rows.map(r => <tr key={r.customer_id}>{cols.map(([key]) => <td key={key} className={['lifetime_gmv', 'aov', 'lifetime_order_count', 'days_since_last_purchase'].includes(key) ? 'num' : key === 'categories' ? 'wrap' : ''}>{fmt(key, r[key])}</td>)}</tr>)}</tbody>
      </table></div>
      <div className="row">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
        <span className="muted small">Page {rows.page} of {Math.max(1, Math.ceil(rows.total / rows.pageSize))}</span>
        <button disabled={rows.page * rows.pageSize >= rows.total} onClick={() => setPage(page + 1)}>Next →</button>
      </div>
    </section>}
  </>;
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
  type === 'customer_type' ? ['Never bought', 'One-time', 'Repeat']
    : type === 'category' || type === 'categories' ? choices.categories : type === 'channel' || type === 'last_channel' ? choices.last_channel : choices.city;

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
