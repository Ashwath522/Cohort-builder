import { useEffect, useState } from 'react';
import { api, type Run } from './api';
import { Empty, Icon, StatusBadge, timeAgo } from './ui';

export default function Runs() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api<Run[]>('/runs').then(setRuns); }, []);
  const sent = (runs ?? []).filter(r => r.status === 'success' && r.mode === 'clevertap');
  return (
    <div className="page">
      <div className="page-head"><div><h1>Send history</h1><p className="muted">Every upload to CleverTap. Counts and a fingerprint of each file only; emails are never logged.</p></div></div>
      {runs && runs.length > 0 && <div className="kpis">
        <div className="kpi"><div className="kpi-label">Sends</div><div className="kpi-value">{sent.length}</div><div className="kpi-sub">{runs.length - sent.length} dry runs / failed</div></div>
        <div className="kpi"><div className="kpi-label">Customers sent</div><div className="kpi-value">{sent.reduce((s, r) => s + (r.rowsSent ?? 0), 0).toLocaleString()}</div></div>
        <div className="kpi"><div className="kpi-label">Last send</div><div className="kpi-value sm">{timeAgo(sent[0]?.startedAt)}</div></div>
      </div>}
      <section className="card flush">
        {!runs ? <div className="pad muted">Loading…</div> : runs.length === 0 ? <Empty icon="clock" title="Nothing sent yet">Approved audiences appear here once they're sent.</Empty> :
          <ul className="runs">{runs.map(r => <li key={r.id}>
            <button className="run-row" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <span className={`run-icon ${r.status}`}><Icon name={r.status === 'success' ? 'check' : r.status === 'failed' ? 'alert' : 'clock'} size={15} /></span>
              <span className="grow"><b>{r.segmentName}</b><span className="muted small"> · {r.mode === 'dry-run' ? 'dry run' : 'CleverTap'} · by {r.startedBy}</span></span>
              <span className="num">{r.rowsSent?.toLocaleString() ?? 0} <span className="muted small">customers</span></span>
              <StatusBadge status={r.status} />
              <span className="muted small w80">{timeAgo(r.startedAt)}</span>
              <Icon name="chevron" size={16} className={`muted rot ${open === r.id ? 'open' : ''}`} />
            </button>
            {open === r.id && <div className="run-detail">
              <ol className="timeline">{r.steps.map((s, i) => <li key={i}><span className={`t-dot ${s.ok ? 'ok' : 'warn'}`} /><div>{s.step}{s.detail && <div className="muted small">{s.detail}</div>}</div></li>)}</ol>
              {r.error && <div className="alert bad">{r.error}</div>}
              <div className="muted small mono">run {r.id}{r.csvSha256 && ` · file sha256 ${r.csvSha256.slice(0, 16)}…`}</div>
            </div>}
          </li>)}</ul>}
      </section>
    </div>
  );
}
