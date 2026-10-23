import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post, type Catalog, type Condition, type DatasetMeta, type Delivery, type FieldKey, type FilterButton, type Freshness, type Group, type SortKey } from './api';
import { Columns, Donut, Funnel, HBars, inr, Kpi } from './Charts';
import { GroupEditor, type Choices } from './FilterEditor';
import { describe } from './rules';
import { Empty, Icon, Modal, Skeleton, slug, useToast } from './ui';

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
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/** Ready-made starting points. Marketing can tweak any of them. */
export interface Preset { id: string; title: string; why: string; name: string; rules: Group }
const Y = new Date().getFullYear();
export const PRESETS: Preset[] = [
  { id: 'lapsed', title: `Bought in ${Y - 1}, not in ${Y}`, why: 'Win back last year’s buyers before they go cold', name: `Lapsed ${Y - 1} buyers`,
    rules: { logic: 'AND', conditions: [{ field: 'last_purchase_date', op: 'between', value: [`${Y - 1}-01-01`, `${Y - 1}-12-31`] }] } },
  { id: 'second', title: 'One-time buyers, 3–12 months ago', why: 'Nudge a second order while the brand is remembered', name: 'Second-order nudge',
    rules: { logic: 'AND', conditions: [{ field: 'customer_type', op: 'in', value: ['One-time'] }, { field: 'days_since_last_purchase', op: 'between', value: ['90', '365'] }] } },
  { id: 'vip', title: 'High-value repeat buyers', why: 'Early access and premium collections', name: 'VIP repeat buyers',
    rules: { logic: 'AND', conditions: [{ field: 'customer_type', op: 'in', value: ['Repeat'] }, { field: 'lifetime_gmv', op: 'gte', value: '100000' }] } },
  { id: 'bed', title: 'Bought Bed, not Mattress', why: 'Natural cross-sell for recent bed buyers', name: 'Bed buyers without mattress',
    rules: { logic: 'AND', conditions: [{ field: 'categories', op: 'bought_not', value: { bought: ['Bed'], notBought: ['Mattress'] } }] } },
  { id: 'never', title: 'Signed up in the last 6 months, never bought', why: 'First-order offer for warm sign-ups', name: 'New sign-ups, no order',
    rules: { logic: 'AND', conditions: [{ field: 'customer_type', op: 'in', value: ['Never bought'] }, { field: 'registered_at', op: 'on_or_after', value: isoDaysAgo(182) }] } },
  { id: 'dormant', title: 'Repeat buyers silent for 1–2 years', why: 'Loyal customers drifting away', name: 'Dormant loyal customers',
    rules: { logic: 'AND', conditions: [{ field: 'customer_type', op: 'in', value: ['Repeat'] }, { field: 'days_since_last_purchase', op: 'between', value: ['366', '730'] }] } },
];

/** Clicking a chart mark turns it into a filter. */
const RECENCY_FILTER: Record<string, Condition> = {
  '0–90 days': { field: 'days_since_last_purchase', op: 'lte', value: '90' },
  '91–180 days': { field: 'days_since_last_purchase', op: 'between', value: ['91', '180'] },
  '181–365 days': { field: 'days_since_last_purchase', op: 'between', value: ['181', '365'] },
  '1–2 years': { field: 'days_since_last_purchase', op: 'between', value: ['366', '730'] },
  '2+ years': { field: 'days_since_last_purchase', op: 'gt', value: '730' },
  'Never bought': { field: 'customer_type', op: 'in', value: ['Never bought'] },
};
const SPEND_FILTER: Record<string, Condition> = {
  '₹0': { field: 'lifetime_gmv', op: 'lte', value: '0' },
  '< ₹10k': { field: 'lifetime_gmv', op: 'between', value: ['0.01', '9999.99'] },
  '₹10k–25k': { field: 'lifetime_gmv', op: 'between', value: ['10000', '24999.99'] },
  '₹25k–50k': { field: 'lifetime_gmv', op: 'between', value: ['25000', '49999.99'] },
  '₹50k–1L': { field: 'lifetime_gmv', op: 'between', value: ['50000', '99999.99'] },
  '₹1L+': { field: 'lifetime_gmv', op: 'gte', value: '100000' },
};

export default function Builder({ catalog, datasets, role, buttons, onSaved, preset, onPresetUsed }: {
  catalog: Catalog; datasets: DatasetMeta[]; role?: string; buttons: FilterButton[];
  onSaved: () => void; preset?: Preset | null; onPresetUsed: () => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState<'excel' | 'powerbi'>('excel');
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '');
  const [pbi, setPbi] = useState<{ configured: boolean; fieldsAvailable: FieldKey[]; choices: Choices } | null>(null);
  const [rules, setRules] = useState<Group>(PRESETS[0].rules);
  const [name, setName] = useState(PRESETS[0].name);
  const [delivery, setDelivery] = useState<Delivery>(() => ({ ...DEFAULT_DELIVERY, seed: Math.random().toString(36).slice(2, 12).padEnd(6, '0') }));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<RowPage | null>(null);
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'insights' | 'customers'>('insights');
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState('');
  const [dax, setDax] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);
  const reqId = useRef(0);

  useEffect(() => { api<typeof pbi>('/sources/powerbi').then(setPbi).catch(() => {}); }, []);
  useEffect(() => { if (!datasetId && datasets[0]) setDatasetId(datasets[0].id); }, [datasets, datasetId]);
  useEffect(() => { if (preset) { setRules(preset.rules); setName(preset.name); onPresetUsed(); toast('info', `Started from “${preset.title}”`); } }, [preset]); // eslint-disable-line

  const ds = datasets.find(d => d.id === datasetId);
  const fields: FieldKey[] = source === 'excel' ? ds?.fieldsAvailable ?? [] : pbi?.fieldsAvailable ?? [];
  const choices: Choices = source === 'excel' ? ds?.choices ?? { last_channel: [], city: [], categories: [] } : pbi?.choices ?? { last_channel: [], city: [], categories: [] };
  const sourceReady = source === 'excel' ? Boolean(ds) : Boolean(pbi?.configured);
  const canSave = role === 'creator' || role === 'admin';
  const buttonProblem = (b: FilterButton) =>
    source === 'powerbi' && !b.worksOn.powerbi ? 'Excel only for now (no DAX yet)'
      : source === 'excel' && b.needsOrderLines && !ds?.hasOrderLines ? 'Needs an "Order Lines" sheet in the upload' : '';
  const editorProps = { catalog, fields, choices, buttons, buttonProblem };

  // Live preview: re-count shortly after anything changes.
  useEffect(() => {
    if (!sourceReady) return;
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const pv = await post<Preview>('/preview', { source, datasetId, rules, delivery, segmentName: slug(name) });
        if (id !== reqId.current) return;
        setPreview(pv); setHint('');
        if (source === 'excel') {
          const r = await post<RowPage>('/preview/rows', { source, datasetId, rules, sortBy: delivery.sortBy, dir: delivery.dir, page, pageSize: 20 });
          if (id === reqId.current) setRows(r);
        } else setRows(null);
      } catch (e) {
        if (id === reqId.current) setHint((e as Error).message);
      } finally { if (id === reqId.current) setLoading(false); }
    }, 450);
    return () => clearTimeout(t);
  }, [rules, source, datasetId, delivery, page, name, sourceReady]);
  useEffect(() => { setPage(1); }, [rules, datasetId, source, delivery.sortBy, delivery.dir]);

  const addFilter = (c: Condition, label: string) => {
    if (JSON.stringify(rules.conditions).includes(JSON.stringify(c))) return toast('info', 'That filter is already applied');
    setRules({ ...rules, logic: rules.logic, conditions: [...rules.conditions, c] });
    toast('ok', `Added filter: ${label}`);
  };
  const removeTop = (i: number) => setRules({ ...rules, conditions: rules.conditions.filter((_, j) => j !== i) });
  const sortBy = (k: SortKey) => setDelivery({ ...delivery, sortBy: k, dir: delivery.sortBy === k && delivery.dir === 'desc' ? 'asc' : 'desc' });
  const showDax = async () => {
    try { const r = await post<{ count: string; fetch: string }>('/sources/powerbi/dax', { rules }); setDax(`-- count (preview)\n${r.count}\n\n-- fetch (at approval, paged)\n${r.fetch}`); }
    catch (e) { toast('bad', (e as Error).message); }
  };
  const sendCount = preview?.funnel?.at(-1)?.count ?? preview?.count ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Build an audience</h1><p className="muted">Pick customers by their full purchase history. The count updates as you go.</p></div>
        <div className="source-picker">
          <div className="seg">
            <button className={source === 'excel' ? 'on' : ''} onClick={() => setSource('excel')}><Icon name="data" size={15} />Uploaded file</button>
            <button className={source === 'powerbi' ? 'on' : ''} onClick={() => setSource('powerbi')} title={pbi?.configured ? '' : 'Not configured yet'}>Power BI{pbi && !pbi.configured && <span className="badge muted mini">setup needed</span>}</button>
          </div>
          {source === 'excel' && datasets.length > 0 && <select value={datasetId} onChange={e => setDatasetId(e.target.value)}>
            {datasets.map(d => <option key={d.id} value={d.id}>{d.fileName} · {d.report.validRows.toLocaleString()} customers · {d.dataAsOf}</option>)}
          </select>}
        </div>
      </div>

      <div className="presets">
        <span className="muted small">Quick start</span>
        {PRESETS.map(p => <button key={p.id} className="preset" title={p.why} onClick={() => { setRules(p.rules); setName(p.name); toast('info', `Loaded “${p.title}”`); }}>{p.title}</button>)}
      </div>

      {!sourceReady ? <div className="card"><Empty icon="data" title={source === 'excel' ? 'No data yet' : 'Power BI isn’t connected yet'}>
        {source === 'excel' ? 'Upload a Power BI export (or the sample file) on the Data sources page.' : 'Ask your Power BI admin for API access; the checklist is on the Data sources page. Use an uploaded file meanwhile.'}
      </Empty></div> : <div className="builder">
        <div className="builder-left">
          <section className="card">
            <div className="card-head"><h2>Filters</h2><button className="btn link sm" onClick={() => setRules({ logic: 'AND', conditions: [] })}>Clear all</button></div>
            <GroupEditor g={rules} onChange={setRules} depth={0} {...editorProps} />
            <div className="row tight"><button className="btn link sm" onClick={showDax}><Icon name="code" size={14} />See the Power BI query</button></div>
            {dax && <pre className="dax">{dax}</pre>}
          </section>

          <section className="card">
            <div className="card-head"><h2>Who gets it</h2><span className="muted small">applied when approved</span></div>
            <div className="form-grid">
              <label>Order by
                <select value={delivery.sortBy} onChange={e => setDelivery({ ...delivery, sortBy: e.target.value as SortKey })}>
                  {Object.entries(catalog.sorts).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label>Direction
                <select value={delivery.dir} onChange={e => setDelivery({ ...delivery, dir: e.target.value as 'asc' | 'desc' })}>
                  <option value="desc">{dirLabel(delivery.sortBy, 'desc')}</option><option value="asc">{dirLabel(delivery.sortBy, 'asc')}</option>
                </select>
              </label>
              <label>Send to
                <select value={delivery.limit ? 'top' : 'all'} disabled={source === 'powerbi'} onChange={e => setDelivery({ ...delivery, limit: e.target.value === 'top' ? Math.max(1, Math.min(1000, preview?.count ?? 1000)) : undefined })}>
                  <option value="all">Everyone matched</option><option value="top">Only the top…</option>
                </select>
              </label>
              {delivery.limit !== undefined && <label>How many
                <input type="number" min={1} value={delivery.limit} onChange={e => setDelivery({ ...delivery, limit: Math.max(1, Number(e.target.value) || 1) })} />
              </label>}
              <label>Control group
                <select value={delivery.holdoutPct} onChange={e => setDelivery({ ...delivery, holdoutPct: Number(e.target.value) })}>
                  {[0, 5, 10, 20].map(p => <option key={p} value={p}>{p === 0 ? 'None' : `${p}% kept aside`}</option>)}
                </select>
              </label>
              <label>Skip if messaged in last
                <select value={delivery.suppressDays} onChange={e => setDelivery({ ...delivery, suppressDays: Number(e.target.value) })}>
                  {[0, 7, 14, 30, 60].map(d => <option key={d} value={d}>{d === 0 ? 'Off' : `${d} days`}</option>)}
                </select>
              </label>
            </div>
            {preview?.funnel && <Funnel steps={preview.funnel} />}
          </section>
        </div>

        <div className="builder-right">
          <section className={`card results-head ${loading ? 'is-loading' : ''}`}>
            <div className="count-block">
              <div className="count-label">Customers matched {loading && <span className="spinner" aria-label="Updating" />}</div>
              <div className="count-value">{preview ? preview.count.toLocaleString() : '—'}</div>
              {preview?.total ? <div className="share"><span style={{ width: `${Math.min(100, (preview.count / preview.total) * 100)}%` }} /></div> : null}
              <div className="muted small">{preview?.total ? `${((preview.count / preview.total) * 100).toFixed(1)}% of ${preview.total.toLocaleString()} customers` : 'Power BI preview shows the count only'}
                {preview && <> · data as of {preview.freshness.dataAsOf?.slice(0, 10) ?? 'unknown'}{preview.freshness.level !== 'ok' && <span className={`badge ${preview.freshness.level === 'blocked' ? 'bad' : 'warn'} mini`}>{preview.freshness.level === 'blocked' ? 'too old' : 'stale?'}</span>}</>}
              </div>
            </div>
            <div className="active-filters">
              {rules.conditions.length === 0 && <span className="muted small">No filters: everyone is included.</span>}
              {rules.conditions.map((c, i) => <span key={i} className="fchip" title="Remove this filter">
                {describe({ logic: 'AND', conditions: [c] }, catalog, buttons)}
                <button aria-label="Remove filter" onClick={() => removeTop(i)}><Icon name="x" size={12} /></button>
              </span>)}
              {rules.conditions.length > 1 && <span className="muted small">combined with {rules.logic === 'AND' ? 'AND' : 'OR'}</span>}
            </div>
            {hint && <div className="hint"><Icon name="alert" size={15} />{hint}</div>}
          </section>

          <div className="tabs">
            <button className={tab === 'insights' ? 'on' : ''} onClick={() => setTab('insights')}>Insights</button>
            <button className={tab === 'customers' ? 'on' : ''} onClick={() => setTab('customers')} disabled={source === 'powerbi'}>Customers{rows ? ` (${rows.total.toLocaleString()})` : ''}</button>
          </div>

          {tab === 'insights' && <Insights preview={preview} addFilter={addFilter} loading={loading} />}
          {tab === 'customers' && <CustomerTable rows={rows} delivery={delivery} catalog={catalog} sortBy={sortBy} page={page} setPage={setPage} />}
        </div>
      </div>}

      {sourceReady && <div className="actionbar">
        <div><b>{sendCount.toLocaleString()}</b> customers will be sent{preview?.funnel && preview.funnel.length > 2 && <span className="muted"> after delivery rules</span>}</div>
        <button className="btn primary" disabled={!canSave || !preview || sendCount === 0 || !!hint} onClick={() => setSaveOpen(true)} title={canSave ? '' : 'Only a Creator can save'}>
          <Icon name="check" size={16} />Save audience…</button>
      </div>}

      {saveOpen && preview && <SaveModal name={name} setName={setName} rules={rules} delivery={delivery} catalog={catalog} buttons={buttons}
        preview={preview} source={source} datasetId={datasetId} onClose={() => setSaveOpen(false)} onSaved={() => { setSaveOpen(false); onSaved(); }} />}
    </div>
  );
}

function Insights({ preview, addFilter, loading }: { preview: Preview | null; addFilter: (c: Condition, label: string) => void; loading: boolean }) {
  if (!preview) return <div className="card"><Skeleton h={80} /><div style={{ height: 12 }} /><Skeleton h={180} /></div>;
  const a = preview.analytics, k = a?.kpis;
  if (!a || !k) return <div className="card"><Empty icon="spark" title="Charts need customer details">Power BI preview returns the count only. Charts appear for uploaded files.</Empty></div>;
  return <div className={`insights ${loading ? 'dim' : ''}`}>
    <div className="kpis">
      <Kpi label="Lifetime spend" value={inr(k.lifetimeGmv)} sub="all orders, all time" />
      <Kpi label="Avg spend per buyer" value={inr(k.avgSpend)} sub={`${k.buyers.toLocaleString()} buyers`} />
      <Kpi label="Avg orders per buyer" value={k.avgOrders.toFixed(1)} />
      <Kpi label="Median days since last order" value={k.medianDaysSinceLast === null ? '—' : String(k.medianDaysSinceLast)} sub="buyers only" />
    </div>
    <p className="muted small tip-line"><Icon name="spark" size={14} />Click any slice or bar to add it as a filter.</p>
    <div className="charts">
      <Donut title="Customer type" data={a.customerType} onSelect={l => addFilter({ field: 'customer_type', op: 'in', value: [l] }, `Customer type is ${l}`)} />
      <Donut title="Last channel" data={a.channel.slice(0, 3)} onSelect={l => addFilter({ field: 'last_channel', op: 'in', value: [l] }, `Last channel is ${l}`)} />
      <Columns title="Time since last purchase" data={a.recency} note="Older buckets are win-back targets; 0–90 days are still warm." onSelect={l => RECENCY_FILTER[l] && addFilter(RECENCY_FILTER[l], l)} />
      <Columns title="Lifetime spend band" data={a.spend} onSelect={l => SPEND_FILTER[l] && addFilter(SPEND_FILTER[l], `Spend ${l}`)} />
      <HBars title="Top categories bought" data={a.categories} base={preview.count} note="A customer can appear in several categories." onSelect={l => addFilter({ field: 'categories', op: 'any_of', value: [l] }, `Bought ${l}`)} />
      <HBars title="Top cities" data={a.cities} base={preview.count} onSelect={l => addFilter({ field: 'city', op: 'in', value: [l] }, `City is ${l}`)} />
    </div>
  </div>;
}

function CustomerTable({ rows, delivery, catalog, sortBy, page, setPage }: { rows: RowPage | null; delivery: Delivery; catalog: Catalog; sortBy: (k: SortKey) => void; page: number; setPage: (p: number) => void }) {
  const cols: Array<[string, string, SortKey | null]> = [
    ['customer_id', 'Customer', null], ['city', 'City', null], ['last_channel', 'Channel', null],
    ['last_purchase_date', 'Last purchase', 'last_purchase_date'], ['days_since_last_purchase', 'Days since', 'days_since_last_purchase'],
    ['lifetime_order_count', 'Orders', 'lifetime_order_count'], ['lifetime_gmv', 'Lifetime spend', 'lifetime_gmv'], ['aov', 'Avg order', 'aov'],
    ['registered_at', 'Registered', 'registered_at'], ['categories', 'Categories', null],
  ];
  const fmt = (key: string, v: unknown) => v === null || v === undefined ? '—'
    : key === 'lifetime_gmv' || key === 'aov' ? `₹${Math.round(Number(v)).toLocaleString('en-IN')}` : Array.isArray(v) ? v.join(', ') : String(v);
  if (!rows) return <div className="card"><Skeleton h={24} /><div style={{ height: 8 }} /><Skeleton h={24} /><div style={{ height: 8 }} /><Skeleton h={24} /></div>;
  const pages = Math.max(1, Math.ceil(rows.total / rows.pageSize));
  return <section className="card flush">
    <div className="card-head pad"><span className="muted small">Sorted by <b>{catalog.sorts[delivery.sortBy].toLowerCase()}</b>, {dirLabel(delivery.sortBy, delivery.dir).toLowerCase()}. This order decides “Only the top…”. Emails are masked.</span></div>
    {rows.total === 0 ? <Empty icon="users" title="Nobody matches">Try removing a filter.</Empty> : <>
      <div className="table-scroll"><table className="results">
        <thead><tr>{cols.map(([key, label, sk]) => <th key={key} className={sk ? 'sortable' : ''} onClick={() => sk && sortBy(sk)} aria-sort={sk && delivery.sortBy === sk ? (delivery.dir === 'desc' ? 'descending' : 'ascending') : undefined}>
          {label}{sk && <span className={`arrow ${delivery.sortBy === sk ? 'on' : ''}`}>{delivery.sortBy === sk && delivery.dir === 'asc' ? '▲' : '▼'}</span>}</th>)}</tr></thead>
        <tbody>{rows.rows.map(r => <tr key={r.customer_id}>{cols.map(([key]) => <td key={key} className={['lifetime_gmv', 'aov', 'lifetime_order_count', 'days_since_last_purchase'].includes(key) ? 'num' : key === 'categories' ? 'wrap' : ''}>
          {key === 'customer_id' ? <><div className="strong">{r.customer_id}</div><div className="muted small">{String(r.email)}</div></>
            : key === 'categories' ? <div className="tags">{r.categories.slice(0, 4).map(c => <span key={c} className="tag">{c}</span>)}{r.categories.length > 4 && <span className="muted small">+{r.categories.length - 4}</span>}</div>
            : fmt(key, r[key])}
        </td>)}</tr>)}</tbody>
      </table></div>
      <div className="pager">
        <span className="muted small">{((page - 1) * rows.pageSize + 1).toLocaleString()}–{Math.min(page * rows.pageSize, rows.total).toLocaleString()} of {rows.total.toLocaleString()}</span>
        <div className="row tight">
          <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
          <span className="muted small">Page {page} / {pages}</span>
          <button className="btn ghost sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
        </div>
      </div>
    </>}
  </section>;
}

function SaveModal({ name, setName, rules, delivery, catalog, buttons, preview, source, datasetId, onClose, onSaved }: {
  name: string; setName: (s: string) => void; rules: Group; delivery: Delivery; catalog: Catalog; buttons: FilterButton[];
  preview: Preview; source: string; datasetId: string; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [segment, setSegment] = useState(slug(name));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (!touched) setSegment(slug(name)); }, [name, touched]);
  const summary = useMemo(() => [
    `Ordered by ${catalog.sorts[delivery.sortBy].toLowerCase()} (${dirLabel(delivery.sortBy, delivery.dir).toLowerCase()})`,
    delivery.limit ? `only the top ${delivery.limit.toLocaleString()}` : 'everyone matched',
    delivery.holdoutPct ? `${delivery.holdoutPct}% control group` : 'no control group',
    delivery.suppressDays ? `skip if messaged in last ${delivery.suppressDays} days` : 'no skip rule',
  ], [delivery, catalog]);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await post('/cohorts', { name, segmentName: segment, source, datasetId, rules, delivery });
      toast('ok', `Saved “${name}” as a draft. Submit it for approval next.`);
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title="Save audience" onClose={onClose} footer={<>
    <button className="btn ghost" onClick={onClose}>Cancel</button>
    <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button>
  </>}>
    <div className="form-col">
      <label>Audience name<input autoFocus value={name} onChange={e => setName(e.target.value)} /></label>
      <label>CleverTap segment name<input value={segment} onChange={e => { setTouched(true); setSegment(e.target.value); }} /><span className="muted small">Letters, numbers, _ or -. This is the name marketing will see in CleverTap.</span></label>
    </div>
    <div className="summary-box">
      <div className="sb-row"><span className="muted">Filters</span><span>{describe(rules, catalog, buttons) || 'Everyone'}</span></div>
      <div className="sb-row"><span className="muted">Delivery</span><span>{summary.join(' · ')}</span></div>
      <div className="sb-row"><span className="muted">Right now</span><span><b>{preview.count.toLocaleString()}</b> matched → <b>{(preview.funnel?.at(-1)?.count ?? preview.count).toLocaleString()}</b> to send</span></div>
    </div>
    <p className="muted small"><Icon name="lock" size={13} /> Nothing is sent yet. After you submit, a second person approves; that locks exactly who will be sent.</p>
    {err && <div className="alert bad">{err}</div>}
  </Modal>;
}
