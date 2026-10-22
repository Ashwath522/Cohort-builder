import { useEffect, useState } from 'react';
import { api, type Run } from './api';

export default function Runs() {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => { api<Run[]>('/runs').then(setRuns); }, []);
  return (
    <section className="card">
      <h2>Push history</h2>
      <p className="muted">Counts and a fingerprint of each CSV only. Emails are never logged.</p>
      {runs.length === 0 ? <p className="muted">No pushes yet.</p> : runs.map(r => (
        <div key={r.id} className="run">
          <div className="row">
            <b>{r.segmentName}</b>
            <span className={`pill ${r.status === 'success' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}`}>{r.status}</span>
            <span className="pill muted">{r.mode}</span>
            <span className="muted small">{r.startedAt.replace('T', ' ').slice(0, 19)} by {r.startedBy} · {r.rowsSent?.toLocaleString() ?? 0} rows · {r.id}</span>
          </div>
          <ol className="steps">{r.steps.map((s, i) => <li key={i} className={s.ok ? '' : 'bad-text'}>{s.ok ? '✓' : '…'} {s.step}{s.detail && <span className="muted"> — {s.detail}</span>}</li>)}</ol>
          {r.error && <div className="bad-text">{r.error}</div>}
          {r.csvSha256 && <div className="muted small">CSV sha256 {r.csvSha256.slice(0, 16)}…</div>}
        </div>
      ))}
    </section>
  );
}
