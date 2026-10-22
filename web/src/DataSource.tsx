import { useEffect, useState } from 'react';
import { api, post, type DatasetMeta } from './api';

interface PbiStatus { configured: boolean; requirements: Array<{ item: string; env: string | null; done: boolean | null }> }

export default function DataSource({ datasets, reload, role }: { datasets: DatasetMeta[]; reload: () => void; role?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string; report?: DatasetMeta['report'] } | null>(null);
  const [pbi, setPbi] = useState<PbiStatus | null>(null);
  const [pbiTest, setPbiTest] = useState('');
  useEffect(() => { api<PbiStatus>('/sources/powerbi').then(setPbi).catch(() => {}); }, []);
  const canUpload = role === 'creator' || role === 'admin';

  async function upload() {
    if (!file) return;
    setBusy(true); setResult(null);
    const fd = new FormData(); fd.append('file', file); fd.append('dataAsOf', asOf);
    try {
      const r = await api<{ dataset: DatasetMeta }>('/sources/excel', { method: 'POST', body: fd });
      setResult({ ok: true, msg: `Loaded ${r.dataset.report.validRows.toLocaleString()} of ${r.dataset.report.totalRows.toLocaleString()} rows`, report: r.dataset.report });
      reload();
    } catch (e) {
      const data = (e as { data?: { report?: DatasetMeta['report'] } }).data;
      setResult({ ok: false, msg: (e as Error).message, report: data?.report });
    } finally { setBusy(false); }
  }

  return (
    <div className="grid2">
      <section className="card">
        <h2>Excel upload <span className="tag">fallback / pilot</span></h2>
        <p className="muted">Export the Customer Audience table from Power BI (or use <code>sample/sample_customers.xlsx</code>). Needs at least <b>Customer ID</b> and <b>Email</b>. Phone columns are ignored. The file is read in memory, emails are encrypted, and the original is discarded.</p>
        <div className="form">
          <input type="file" accept=".xlsx,.csv" onChange={e => setFile(e.target.files?.[0] ?? null)} disabled={!canUpload} />
          <label>Data exported on <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></label>
          <button className="primary" disabled={!file || busy || !canUpload} onClick={upload}>{busy ? 'Validating…' : 'Upload & validate'}</button>
          {!canUpload && <span className="muted">Only a Creator can upload.</span>}
        </div>
        {result && <div className={`alert ${result.ok ? 'ok' : 'bad'}`}>{result.msg}</div>}
        {result?.report && <Report r={result.report} />}
        <h3>Uploaded datasets</h3>
        {datasets.length === 0 ? <p className="muted">None yet.</p> : (
          <table><thead><tr><th>File</th><th>Rows</th><th>Data as of</th><th>Deleted on</th><th /></tr></thead><tbody>
            {datasets.map(d => <tr key={d.id}>
              <td>{d.fileName}<div className="muted small">{d.id} · by {d.uploadedBy}</div></td>
              <td>{d.report.validRows.toLocaleString()}</td>
              <td>{d.dataAsOf} {d.freshness && d.freshness.level !== 'ok' && <span className={`pill ${d.freshness.level === 'blocked' ? 'bad' : 'warn'}`}>{d.freshness.daysOld}d old</span>}</td>
              <td>{d.expiresAt.slice(0, 10)}</td>
              <td>{canUpload && <button className="link" onClick={() => api(`/sources/excel/${d.id}`, { method: 'DELETE' }).then(reload)}>Delete</button>}</td>
            </tr>)}
          </tbody></table>
        )}
      </section>

      <section className="card">
        <h2>Power BI <span className="tag">primary</span></h2>
        {pbi?.configured
          ? <>
              <p>Configured. The app queries the semantic model directly with the Execute Queries API (counts for preview, Customer ID + Email only at approval).</p>
              <button onClick={() => post<{ connected: boolean; lastRefresh: string | null }>('/sources/powerbi/test')
                .then(r => setPbiTest(r.connected ? `Connected ✓ · last refresh ${r.lastRefresh ?? 'unknown'}` : 'Not connected'))
                .catch(e => setPbiTest(e.message))}>Test connection</button>
              {pbiTest && <div className="alert">{pbiTest}</div>}
            </>
          : <p className="muted">Not configured yet. What's needed from your side:</p>}
        <ol className="checklist">
          {pbi?.requirements.map(r => <li key={r.item} className={r.done ? 'done' : ''}>
            {r.done === true ? '✓ ' : r.done === false ? '○ ' : '• '}{r.item}{r.env && <code className="small"> {r.env}</code>}
          </li>)}
        </ol>
        <p className="muted small">Put the values in <code>.env</code> and the model's names in <code>config/powerbi-mapping.json</code>, then restart.</p>
      </section>
    </div>
  );
}

function Report({ r }: { r: DatasetMeta['report'] }) {
  return (
    <div className="report">
      {r.errors.map(e => <div key={e} className="bad-text">✗ {e}</div>)}
      {Object.keys(r.columnsFound).length > 0 && <div><b>Columns used:</b> {Object.entries(r.columnsFound).map(([k, v]) => `${v} → ${k}`).join(' · ')}</div>}
      {r.ignoredColumns.length > 0 && <div><b>Ignored:</b> {r.ignoredColumns.join(', ')}</div>}
      {r.warnings.map(w => <div key={w} className="warn-text">⚠ {w}</div>)}
    </div>
  );
}
