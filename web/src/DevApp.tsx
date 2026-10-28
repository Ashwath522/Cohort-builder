import { useCallback, useEffect, useState } from 'react';
import { api, post, setUser, type CustomFilter, type DatasetMeta, type FilterDefinition, type FilterParam, type ParamType } from './api';

interface DevData { filters: CustomFilter[]; schema: Record<string, string[]>; paramTypes: ParamType[] }
interface TestResult { count: number; total: number; ms: number; unknownIds: number; sample: Array<{ customer_id: string; fynd_user_id: string; last_purchase_date: string | null }>; dax: string | null }

const EMPTY: FilterDefinition = {
  label: '', description: '', params: [{ name: 'category', label: 'Category', type: 'category' }],
  sql: 'SELECT customer_id\nFROM customer_categories\nWHERE category = :category', dax: '',
};

/** Developer window (/developer): write SQL (and optional DAX), name the button, test, publish. */
export default function DevApp() {
  const [user, setU] = useState('dev');
  const [data, setData] = useState<DevData | null>(null);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);   // filter id, or null = new
  const [def, setDef] = useState<FilterDefinition>(EMPTY);
  const [saved, setSaved] = useState<string>(JSON.stringify(EMPTY));
  const [datasetId, setDatasetId] = useState('');
  const [testParams, setTestParams] = useState<Record<string, string>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<DevData>('/dev/filters'));
      const ds = await api<DatasetMeta[]>('/sources/excel'); setDatasets(ds);
      setDatasetId(id => id || ds[0]?.id || '');
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); setData(null); }
  }, []);
  useEffect(() => { load(); }, [load, user]);

  const current = data?.filters.find(f => f.id === selected);
  const dirty = JSON.stringify(def) !== saved;
  const ds = datasets.find(d => d.id === datasetId);
  const choicesFor = (t: ParamType) => t === 'category' ? ds?.choices.categories ?? [] : t === 'channel' ? ds?.choices.last_channel ?? [] : t === 'city' ? ds?.choices.city ?? [] : [];

  function open(f: CustomFilter | null) {
    const d = f ? { ...f.draft, dax: f.draft.dax ?? '' } : EMPTY;
    setSelected(f?.id ?? null); setDef(d); setSaved(JSON.stringify(d)); setTest(null); setMsg(null); setTestParams({});
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }
  const save = () => act(async () => {
    const f = selected ? await api<CustomFilter>(`/dev/filters/${selected}`, { method: 'PUT', body: JSON.stringify(def) }) : await post<CustomFilter>('/dev/filters', def);
    setSelected(f.id); setSaved(JSON.stringify(def)); setMsg({ ok: true, text: 'Draft saved. Marketing sees it only after you publish.' }); await load();
  });
  const publish = () => act(async () => {
    const f = await post<CustomFilter>(`/dev/filters/${selected}/publish`);
    setMsg({ ok: true, text: `Published v${f.versions.at(-1)!.version}. The "${f.draft.label}" button is now in the marketing window.` }); await load();
  });
  const archive = () => act(async () => { const f = await post<CustomFilter>(`/dev/filters/${selected}/archive`); setMsg({ ok: true, text: f.status === 'archived' ? 'Archived: hidden from marketing.' : 'Restored.' }); await load(); });
  const runTest = () => act(async () => setTest(await post<TestResult>('/dev/filters/test', { definition: def, datasetId, params: testParams })));

  const setParam = (i: number, p: Partial<FilterParam>) => setDef({ ...def, params: def.params.map((x, j) => (j === i ? { ...x, ...p } : x)) });

  return (
    <div className="dev-shell"><div className="page wide">
      <header className="dev-header">
        <div><h1><span className="logo sm">CB</span> Developer window</h1><span className="sub">Write a query, name the button, publish. Marketing just clicks it.</span></div>
        <div className="header-right">
          <a href="/" className="small">Open marketing window ↗</a>
          <label className="acting">Acting as
            <select value={user} onChange={e => { setU(e.target.value); setUser(e.target.value); }}>
              <option value="dev">Dev (Analytics)</option><option value="admin">Admin</option><option value="priya">Priya (Marketing)</option>
            </select>
          </label>
        </div>
      </header>
      {!data ? <div className="alert bad">{msg?.text ?? 'Loading…'} {msg && 'This window is for developers only.'}</div> : (
        <div className="devgrid">
          <aside className="card">
            <h2>Filter buttons</h2>
            <button className="btn primary wide" onClick={() => open(null)}>+ New filter button</button>
            <ul className="flist">
              {data.filters.map(f => <li key={f.id} className={f.id === selected ? 'active' : ''} onClick={() => open(f)}>
                <b>{f.draft.label}</b>
                <span className={`pill ${f.status === 'published' ? 'ok' : f.status === 'archived' ? 'muted' : 'warn'}`}>{f.status}{f.versions.length ? ` v${f.versions.at(-1)!.version}` : ''}</span>
              </li>)}
            </ul>
          </aside>

          <section className="stack">
            <div className="card">
              <h2>{selected ? 'Edit' : 'New'} filter button {dirty && <span className="pill warn">unsaved</span>}</h2>
              <div className="form">
                <label>Button name (what marketing sees)<input value={def.label} maxLength={40} placeholder="e.g. Not bought" onChange={e => setDef({ ...def, label: e.target.value })} /></label>
                <label className="grow">Description<input value={def.description} placeholder="One line explaining what it selects" onChange={e => setDef({ ...def, description: e.target.value })} /></label>
              </div>

              <h3>Parameters <span className="muted small">— marketing fills these in; use them in the query as <code>:name</code></span></h3>
              <table className="params"><thead><tr><th>Name in query</th><th>Label for marketing</th><th>Type</th><th /></tr></thead><tbody>
                {def.params.map((p, i) => <tr key={i}>
                  <td><input value={p.name} onChange={e => setParam(i, { name: e.target.value })} /></td>
                  <td><input value={p.label} onChange={e => setParam(i, { label: e.target.value })} /></td>
                  <td><select value={p.type} onChange={e => setParam(i, { type: e.target.value as ParamType })}>{data.paramTypes.map(t => <option key={t}>{t}</option>)}</select></td>
                  <td><button className="link" onClick={() => setDef({ ...def, params: def.params.filter((_, j) => j !== i) })}>✕</button></td>
                </tr>)}
              </tbody></table>
              <button onClick={() => setDef({ ...def, params: [...def.params, { name: `p${def.params.length + 1}`, label: 'Value', type: 'text' }] })}>+ Parameter</button>

              <div className="sqlgrid">
                <div>
                  <h3>SQL <span className="muted small">— runs on uploaded data; must return <code>customer_id</code></span></h3>
                  <textarea className="code" rows={9} spellCheck={false} value={def.sql} onChange={e => setDef({ ...def, sql: e.target.value })} />
                  <h3>DAX <span className="muted small">— optional, for the Power BI source: a table of customer IDs</span></h3>
                  <textarea className="code" rows={5} spellCheck={false} value={def.dax ?? ''} placeholder={"CALCULATETABLE(VALUES('OrderLines'[Customer ID]), 'OrderLines'[Category] = :category)"} onChange={e => setDef({ ...def, dax: e.target.value })} />
                </div>
                <div className="schema">
                  <h3>Tables</h3>
                  {Object.entries(data.schema).map(([t, cols]) => <div key={t}><code className="strong">{t}</code><div className="muted small">{cols.join(', ')}</div></div>)}
                  <p className="muted small">No email or phone columns: queries select <i>who</i>, never contact details. Read-only: SELECT / WITH only.</p>
                  <h3>Examples</h3>
                  <pre className="small">{`-- bought Bed, never Mattress
SELECT customer_id FROM customer_categories WHERE category = :bought
EXCEPT
SELECT customer_id FROM customer_categories WHERE category = :not_bought

-- bought a category in a year
SELECT DISTINCT customer_id FROM order_lines
WHERE category = :category
  AND substr(order_date,1,4) = CAST(:year AS TEXT)`}</pre>
                </div>
              </div>

              <div className="row">
                <button className="btn primary" disabled={busy || !dirty} onClick={save}>Save draft</button>
                <button className="btn primary" disabled={busy || dirty || !selected} title={dirty ? 'Save first' : ''} onClick={publish}>Publish to marketing</button>
                {current && <button disabled={busy} onClick={archive}>{current.status === 'archived' ? 'Restore' : 'Archive'}</button>}
              </div>
              {msg && <div className={`alert ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
            </div>

            <div className="card">
              <h2>Test</h2>
              <div className="form">
                <label>Dataset
                  <select value={datasetId} onChange={e => setDatasetId(e.target.value)}>
                    {datasets.length === 0 && <option value="">Upload a file in the marketing window first</option>}
                    {datasets.map(d => <option key={d.id} value={d.id}>{d.fileName} · {d.report.validRows.toLocaleString()} rows{d.hasOrderLines ? ' · has order lines' : ''}</option>)}
                  </select>
                </label>
                {def.params.map(p => <label key={p.name}>{p.label || p.name}
                  {p.type === 'date' ? <input type="date" value={testParams[p.name] ?? ''} onChange={e => setTestParams({ ...testParams, [p.name]: e.target.value })} />
                    : ['category', 'channel', 'city'].includes(p.type) ? <select value={testParams[p.name] ?? ''} onChange={e => setTestParams({ ...testParams, [p.name]: e.target.value })}><option value="">choose…</option>{choicesFor(p.type).map(o => <option key={o}>{o}</option>)}</select>
                    : <input type={p.type === 'number' ? 'number' : 'text'} value={testParams[p.name] ?? ''} onChange={e => setTestParams({ ...testParams, [p.name]: e.target.value })} />}
                </label>)}
                <button className="btn primary" disabled={busy || !datasetId} onClick={runTest}>Run test</button>
              </div>
              {test && <>
                <div className="big">{test.count.toLocaleString()} <span className="muted">of {test.total.toLocaleString()} customers · {test.ms} ms</span></div>
                {test.unknownIds > 0 && <div className="warn-text small">{test.unknownIds} IDs returned by the query aren't in the customer sheet (ignored).</div>}
                {test.sample.length > 0 && <table><thead><tr><th>Customer ID</th><th>Fynd user ID</th><th>Last purchase</th></tr></thead><tbody>
                  {test.sample.map(s => <tr key={s.customer_id}><td>{s.customer_id}</td><td className="mono">{s.fynd_user_id}</td><td>{s.last_purchase_date ?? '—'}</td></tr>)}
                </tbody></table>}
                {test.dax && <><h3>DAX sent to Power BI (with these values)</h3><pre className="dax">{test.dax}</pre></>}
              </>}
            </div>

            {current && current.versions.length > 0 && <div className="card">
              <h2>Published versions</h2>
              <ul className="history">{[...current.versions].reverse().map(v => <li key={v.version}><b>v{v.version}</b> · {v.publishedAt.replace('T', ' ').slice(0, 16)} by {v.publishedBy} · “{v.label}” · {v.params.length} parameter(s){v.dax ? ' · Excel + Power BI' : ' · Excel only'}</li>)}</ul>
              <p className="muted small">Cohorts keep the version they were built with, so publishing a change never alters an existing cohort.</p>
            </div>}
          </section>
        </div>
      )}
    </div></div>
  );
}
