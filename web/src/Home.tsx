import { useEffect, useState } from 'react';
import { api, type Cohort, type DatasetMeta, type Run } from './api';
import { PRESETS, type Preset } from './Builder';
import { Empty, Icon, StatusBadge, timeAgo } from './ui';

export default function Home({ userName, role, datasets, go, startPreset, openCohort }: {
  userName: string; role?: string; datasets: DatasetMeta[]; go: (r: string) => void; startPreset: (p: Preset) => void; openCohort: (id: string) => void;
}) {
  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => { api<Cohort[]>('/cohorts').then(setCohorts); api<Run[]>('/runs').then(setRuns); }, []);
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = userName.split(' ')[0];
  const pending = cohorts.filter(c => c.status === 'pending_approval');
  const mine = role === 'approver' ? pending : cohorts.filter(c => ['draft', 'rejected', 'approved', 'failed'].includes(c.status));
  const since = Date.now() - 30 * 864e5;
  const sent30 = runs.filter(r => r.status === 'success' && r.mode === 'clevertap' && Date.parse(r.startedAt) > since);
  const latest = datasets[0];

  return (
    <div className="page">
      <div className="hero">
        <div>
          <h1>{hello}, {first}</h1>
          <p>Find customers by their full purchase history and tag them in CleverTap as a segment — by Fynd user ID only, no contact lists.</p>
        </div>
        <div className="row">
          <button className="btn primary lg" onClick={() => go('build')}><Icon name="filter" size={17} />Build an audience</button>
          <button className="btn ghost lg on-dark" onClick={() => go('data')}><Icon name="upload" size={17} />Upload data</button>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><div className="kpi-label">Customers in latest data</div><div className="kpi-value">{latest ? latest.report.validRows.toLocaleString() : '—'}</div><div className="kpi-sub">{latest ? `as of ${latest.dataAsOf}` : 'no upload yet'}</div></div>
        <div className="kpi"><div className="kpi-label">Audiences</div><div className="kpi-value">{cohorts.length}</div><div className="kpi-sub">{cohorts.filter(c => c.status === 'tagged').length} tagged</div></div>
        <div className={`kpi ${pending.length ? 'attn' : ''}`}><div className="kpi-label">Waiting for approval</div><div className="kpi-value">{pending.length}</div><div className="kpi-sub">{pending.length ? 'needs an approver' : 'all clear'}</div></div>
        <div className="kpi"><div className="kpi-label">Customers tagged, last 30 days</div><div className="kpi-value">{sent30.reduce((s, r) => s + (r.rowsTagged ?? 0), 0).toLocaleString()}</div><div className="kpi-sub">{sent30.length} segments tagged</div></div>
      </div>

      <div className="home-grid">
        <section className="card">
          <div className="card-head"><h2>{role === 'approver' ? 'Waiting for you' : 'Your audiences in progress'}</h2><button className="btn link sm" onClick={() => go('cohorts')}>See all</button></div>
          {mine.length === 0 ? <Empty icon="check" title={role === 'approver' ? 'Nothing to approve' : 'Nothing in progress'}>{role === 'approver' ? 'You’re all caught up.' : 'Start from a quick start on the right.'}</Empty> :
            <ul className="mini-list">{mine.slice(0, 6).map(c => <li key={c.id} className="clickable" onClick={() => openCohort(c.id)}>
              <div><div className="strong">{c.name}</div><div className="muted small">{(c.snapshotCount ?? c.previewCount ?? 0).toLocaleString()} customers · {timeAgo(c.history.at(-1)?.at)}</div></div>
              <StatusBadge status={c.status} />
            </li>)}</ul>}
        </section>
        <section className="card">
          <div className="card-head"><h2>Quick starts</h2><span className="muted small">common campaigns, one click</span></div>
          <div className="preset-cards">{PRESETS.map(p => <button key={p.id} className="preset-card" onClick={() => startPreset(p)}>
            <b>{p.title}</b><span className="muted small">{p.why}</span><Icon name="chevron" size={16} className="pc-arrow" />
          </button>)}</div>
        </section>
        <section className="card span2">
          <div className="card-head"><h2>Recently tagged</h2><button className="btn link sm" onClick={() => go('history')}>History</button></div>
          {runs.length === 0 ? <Empty icon="send" title="Nothing tagged yet" /> : <ul className="mini-list">{runs.slice(0, 5).map(r => <li key={r.id}>
            <div><div className="strong mono">{r.segmentName}</div><div className="muted small">{r.mode === 'dry-run' ? 'dry run' : 'CleverTap'}{r.attempt > 1 ? ` · retry ${r.attempt - 1}` : ''} · by {r.startedBy} · {timeAgo(r.startedAt)}</div></div>
            <div className="row tight"><span className="num">{r.rowsTagged?.toLocaleString() ?? 0}</span><StatusBadge status={r.status} /></div>
          </li>)}</ul>}
        </section>
      </div>
    </div>
  );
}
