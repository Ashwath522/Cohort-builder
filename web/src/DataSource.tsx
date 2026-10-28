import { useEffect, useRef, useState } from 'react';
import { api, post, type DatasetMeta } from './api';
import { Empty, Icon, timeAgo, useToast } from './ui';

interface PbiStatus { configured: boolean; requirements: Array<{ item: string; env: string | null; done: boolean | null }> }

export default function DataSource({ datasets, reload, role }: { datasets: DatasetMeta[]; reload: () => void; role?: string }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string; report?: DatasetMeta['report'] } | null>(null);
  const [pbi, setPbi] = useState<PbiStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { api<PbiStatus>('/sources/powerbi').then(setPbi).catch(() => {}); }, []);
  const canUpload = role === 'creator' || role === 'admin' || role === 'developer';

  const pick = (f?: File | null) => {
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return toast('bad', 'Only .xlsx or .csv files');
    setFile(f); setResult(null);
  };
  async function upload() {
    if (!file) return;
    setBusy(true); setResult(null);
    const fd = new FormData(); fd.append('file', file); fd.append('dataAsOf', asOf);
    try {
      const r = await api<{ dataset: DatasetMeta }>('/sources/excel', { method: 'POST', body: fd });
      setResult({ ok: true, msg: `${r.dataset.report.validRows.toLocaleString()} of ${r.dataset.report.totalRows.toLocaleString()} customers loaded`, report: r.dataset.report });
      toast('ok', `Loaded ${file.name}`); setFile(null); reload();
    } catch (e) {
      const data = (e as { data?: { report?: DatasetMeta['report'] } }).data;
      setResult({ ok: false, msg: (e as Error).message, report: data?.report });
    } finally { setBusy(false); }
  }
  async function test() {
    setTesting(true);
    try { const r = await post<{ connected: boolean; lastRefresh: string | null }>('/sources/powerbi/test'); toast(r.connected ? 'ok' : 'bad', r.connected ? `Connected · last refresh ${r.lastRefresh ?? 'unknown'}` : 'Not connected'); }
    catch (e) { toast('bad', (e as Error).message); } finally { setTesting(false); }
  }
  const done = pbi?.requirements.filter(r => r.done).length ?? 0;
  const withEnv = pbi?.requirements.filter(r => r.done !== null).length ?? 0;

  return (
    <div className="page">
      <div className="page-head"><div><h1>Data sources</h1><p className="muted">Where customer purchase history comes from. Only Fynd user IDs and purchase fields are read; email and phone columns are skipped.</p></div></div>
      <div className="grid2">
        <section className="card">
          <div className="card-head"><h2>Upload a file</h2><span className="badge muted">fallback · pilot</span></div>
          <div className={`dropzone ${drag ? 'drag' : ''} ${file ? 'has-file' : ''} ${!canUpload ? 'disabled' : ''}`}
            onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); canUpload && pick(e.dataTransfer.files[0]); }}
            onClick={() => canUpload && input.current?.click()} role="button" tabIndex={0}>
            <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={e => pick(e.target.files?.[0])} />
            <Icon name="upload" size={28} />
            {file ? <><b>{file.name}</b><span className="muted small">{(file.size / 1024).toFixed(0)} KB · click to change</span></>
              : <><b>Drop a Power BI export here</b><span className="muted small">or click to browse · .xlsx or .csv · needs a Fynd User ID column</span></>}
          </div>
          <div className="row">
            <label className="inline-label">Exported on <input type="date" value={asOf} max={new Date().toISOString().slice(0, 10)} onChange={e => setAsOf(e.target.value)} /></label>
            <button className="btn primary" disabled={!file || busy || !canUpload} onClick={upload}>{busy ? <><span className="spinner light" />Checking…</> : 'Upload & check'}</button>
          </div>
          <p className="muted small">Tip: include an <b>Order Lines</b> sheet (Customer ID, Order Date, Category, Amount) to unlock time-based category filters. Try <span className="mono">sample/sample_customers.xlsx</span>.</p>
          {result && <div className={`alert ${result.ok ? 'ok' : 'bad'}`}><Icon name={result.ok ? 'check' : 'alert'} size={16} />{result.msg}</div>}
          {result?.report && <Report r={result.report} />}
        </section>

        <section className="card">
          <div className="card-head"><h2>Power BI</h2><span className={`badge ${pbi?.configured ? 'ok' : 'muted'}`}>{pbi?.configured ? 'connected' : 'setup needed'}</span></div>
          <p className="muted">Primary source. The app asks the existing semantic model for counts during preview, and for Fynd user IDs only when an audience is approved. Emails and phones are never queried.</p>
          {withEnv > 0 && <div className="progress-line"><span style={{ width: `${(done / withEnv) * 100}%` }} /><em className="muted small">{done} of {withEnv} settings filled in</em></div>}
          <ol className="checklist">
            {pbi?.requirements.map(r => <li key={r.item} className={r.done ? 'done' : ''}>
              <span className={`check ${r.done ? 'on' : ''}`}>{r.done ? <Icon name="check" size={12} /> : null}</span>
              <span>{r.item}{r.env && <code className="small"> {r.env}</code>}</span>
            </li>)}
          </ol>
          <div className="row"><button className="btn ghost" disabled={!pbi?.configured || testing} onClick={test}>{testing ? 'Testing…' : 'Test connection'}</button>
            <span className="muted small">Values go in <code>.env</code>; model names in <code>config/powerbi-mapping.json</code>.</span></div>
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>Uploaded datasets</h2><span className="muted small">deleted automatically after the retention period</span></div>
        {datasets.length === 0 ? <Empty icon="data" title="No uploads yet">Upload a file above to start building audiences.</Empty> : <div className="ds-grid">
          {datasets.map(d => <div key={d.id} className="ds-card">
            <div className="ds-top"><Icon name="data" size={18} /><b className="ellipsis">{d.fileName}</b>
              {d.freshness && d.freshness.level !== 'ok' && <span className={`badge ${d.freshness.level === 'blocked' ? 'bad' : 'warn'} mini`}>{d.freshness.daysOld}d old</span>}</div>
            <div className="ds-num">{d.report.validRows.toLocaleString()}<span className="muted small"> customers</span></div>
            <div className="muted small">as of {d.dataAsOf} · uploaded {timeAgo(d.uploadedAt)} by {d.uploadedBy}</div>
            <div className="tags">{d.hasOrderLines && <span className="tag">order lines</span>}<span className="tag">{d.fieldsAvailable.length} filters available</span></div>
            <div className="ds-foot"><span className="muted small">deletes {d.expiresAt.slice(0, 10)}</span>
              {canUpload && <button className="btn link sm danger-text" onClick={() => api(`/sources/excel/${d.id}`, { method: 'DELETE' }).then(() => { toast('ok', 'Dataset deleted'); reload(); })}>Delete</button>}</div>
          </div>)}
        </div>}
      </section>
    </div>
  );
}

function Report({ r }: { r: DatasetMeta['report'] }) {
  return (
    <div className="report">
      {r.errors.map(e => <div key={e} className="bad-text">✗ {e}</div>)}
      {Object.keys(r.columnsFound).length > 0 && <div className="tags">{Object.entries(r.columnsFound).map(([k, v]) => <span key={k} className="tag ok" title={`→ ${k}`}>{v}</span>)}</div>}
      {r.ignoredColumns.length > 0 && <div className="muted small">Ignored: {r.ignoredColumns.join(', ')}</div>}
      {r.warnings.map(w => <div key={w} className="warn-text small">⚠ {w}</div>)}
    </div>
  );
}
