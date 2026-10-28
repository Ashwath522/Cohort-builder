import { useCallback, useEffect, useState } from 'react';
import { api, currentUserId, type Catalog, type Cohort, type FilterButton, type Group, type Run } from './api';
import { describe } from './rules';
import { Empty, Icon, Modal, StatusBadge, timeAgo, useToast } from './ui';

interface HistoryItem {
  cohortId: string; name: string; segmentName: string; status: string; source: string; rules: Group;
  createdBy: string; createdAt: string; approvedBy?: string; approvedAt?: string; taggedAt?: string; taggedBy?: string;
  matched?: number; tagged?: number; control?: number; dataAsOf?: string; idsAvailable: boolean; keepUntil: string;
  runs: Run[]; history: Cohort['history'];
}
interface IdPage { total: number; tagged: number; control: number; page: number; pageSize: number; rows: Array<{ customer_id: string; fynd_user_id: string; group: string }> }
const when = (iso?: string) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');

/** History: every approved segment for at least 90 days — who created and approved it, when it was tagged, the IDs added. */
export default function Runs({ catalog, buttons }: { catalog: Catalog; buttons: FilterButton[] }) {
  const toast = useToast();
  const [data, setData] = useState<{ retentionDays: number; items: HistoryItem[] } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [ids, setIds] = useState<HistoryItem | null>(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => api<{ retentionDays: number; items: HistoryItem[] }>('/history').then(setData).catch(e => toast('bad', e.message)), [toast]);
  useEffect(() => { load(); }, [load]);
  const busy = data?.items.some(i => i.status === 'tagging');
  useEffect(() => { if (!busy) return; const t = setInterval(load, 2000); return () => clearInterval(t); }, [busy, load]);

  const items = (data?.items ?? []).filter(i => !q || `${i.name} ${i.segmentName} ${i.createdBy} ${i.approvedBy}`.toLowerCase().includes(q.toLowerCase()));
  const tagged = (data?.items ?? []).filter(i => i.taggedAt);
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>History</h1><p className="muted">Every approved segment, kept for at least {data?.retentionDays ?? 90} days: who created and approved it, when it was tagged in CleverTap, each attempt, and the Fynd user IDs added.</p></div>
        <div className="search"><Icon name="search" size={16} /><input placeholder="Search segment or person" value={q} onChange={e => setQ(e.target.value)} /></div>
      </div>
      {data && data.items.length > 0 && <div className="kpis">
        <div className="kpi"><div className="kpi-label">Segments logged</div><div className="kpi-value">{data.items.length}</div><div className="kpi-sub">{tagged.length} tagged in CleverTap</div></div>
        <div className="kpi"><div className="kpi-label">Customers tagged</div><div className="kpi-value">{tagged.reduce((s, i) => s + (i.tagged ?? 0), 0).toLocaleString()}</div><div className="kpi-sub">by Fynd user ID</div></div>
        <div className="kpi"><div className="kpi-label">Last tagged</div><div className="kpi-value sm">{timeAgo(tagged.map(i => i.taggedAt!).sort().at(-1))}</div></div>
        <div className="kpi"><div className="kpi-label">Failed right now</div><div className="kpi-value">{data.items.filter(i => i.status === 'failed').length}</div><div className="kpi-sub">{data.items.reduce((s, i) => s + i.runs.filter(r => r.status === 'failed').length, 0)} failed attempts in total</div></div>
      </div>}
      <section className="card flush">
        {!data ? <div className="pad muted">Loading…</div> : items.length === 0 ? <Empty icon="clock" title="Nothing here yet">Approved audiences appear here and stay for at least {data.retentionDays} days.</Empty> :
          <ul className="runs">{items.map(i => <li key={i.cohortId}>
            <button className="run-row" onClick={() => setOpen(open === i.cohortId ? null : i.cohortId)} aria-expanded={open === i.cohortId}>
              <span className={`run-icon ${i.status === 'tagged' ? 'success' : i.status === 'failed' ? 'failed' : 'running'}`}>
                <Icon name={i.status === 'tagged' ? 'check' : i.status === 'failed' ? 'alert' : 'clock'} size={15} /></span>
              <span className="grow"><b>{i.segmentName}</b><span className="muted small"> · {i.name}</span>
                <div className="muted small">created by {i.createdBy} · approved by {i.approvedBy} · {i.taggedAt ? `tagged ${when(i.taggedAt)}` : 'not tagged yet'}</div></span>
              <span className="num">{i.tagged?.toLocaleString() ?? 0} <span className="muted small">customers</span></span>
              <StatusBadge status={i.status} />
              <Icon name="chevron" size={16} className={`muted rot ${open === i.cohortId ? 'open' : ''}`} />
            </button>
            {open === i.cohortId && <div className="run-detail">
              <div className="mini-kpis">
                <div><span className="muted small">Matched</span><b>{i.matched?.toLocaleString() ?? '—'}</b></div>
                <div><span className="muted small">Tagged</span><b>{i.tagged?.toLocaleString() ?? '—'}</b></div>
                <div><span className="muted small">Control group</span><b>{i.control?.toLocaleString() ?? 0}</b></div>
              </div>
              <table className="kv"><tbody>
                <tr><th>Filters</th><td>{describe(i.rules, catalog, buttons) || 'Everyone'}</td></tr>
                <tr><th>Source</th><td>{i.source === 'excel' ? 'File upload' : 'Power BI'}{i.dataAsOf && ` · data as of ${i.dataAsOf.slice(0, 10)}`}</td></tr>
                <tr><th>Created</th><td>{i.createdBy} · {when(i.createdAt)}</td></tr>
                <tr><th>Approved &amp; locked</th><td>{i.approvedBy} · {when(i.approvedAt)}</td></tr>
                <tr><th>Tagged in CleverTap</th><td>{i.taggedAt ? `${i.taggedBy ?? ''} · ${when(i.taggedAt)}` : '—'}</td></tr>
                <tr><th>Kept until</th><td>{i.keepUntil.slice(0, 10)} <span className="muted small">(at least {data.retentionDays} days)</span></td></tr>
              </tbody></table>
              <div className="row">
                <button className="btn ghost sm" disabled={!i.idsAvailable} onClick={() => setIds(i)}><Icon name="users" size={14} />View Fynd user IDs</button>
                {!i.idsAvailable && <span className="muted small">ID list no longer stored</span>}
              </div>
              <h4>Attempts</h4>
              {i.runs.length === 0 ? <p className="muted small">Not tagged yet.</p> : [...i.runs].sort((a, b) => a.attempt - b.attempt).map(r => <div key={r.id} className="attempt">
                <div className="row tight"><b>Attempt {r.attempt}</b><StatusBadge status={r.status} /><span className="muted small">{r.mode === 'dry-run' ? 'dry run' : 'CleverTap'} · by {r.startedBy} · {when(r.startedAt)}</span></div>
                <ol className="timeline">{r.steps.map((s, k) => <li key={k}><span className={`t-dot ${s.ok ? 'ok' : 'warn'}`} /><div>{s.step}{s.detail && <div className="muted small">{s.detail}</div>}</div></li>)}</ol>
                {r.error && <div className="alert bad"><Icon name="alert" size={16} /><div><b>Stopped at {r.failedStep ?? 'a step'}:</b> {r.error}</div></div>}
              </div>)}
              <h4>Timeline</h4>
              <ol className="timeline">{[...i.history].reverse().map((h, k) => <li key={k}><span className="t-dot" /><div><b>{h.by}</b> {h.action}{h.note && <span className="muted"> — {h.note}</span>}<div className="muted small">{when(h.at)}</div></div></li>)}</ol>
            </div>}
          </li>)}</ul>}
      </section>
      {ids && <IdsModal item={ids} onClose={() => setIds(null)} />}
    </div>
  );
}

function IdsModal({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [d, setD] = useState<IdPage | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api<IdPage>(`/cohorts/${item.cohortId}/ids?page=${page}&pageSize=50&q=${encodeURIComponent(q)}`).then(setD).catch(e => toast('bad', e.message)), 150);
    return () => clearTimeout(t);
  }, [item.cohortId, page, q, toast]);
  const download = async () => {
    try {
      const res = await fetch(`/api/cohorts/${item.cohortId}/ids.csv`, { headers: { 'X-User': currentUserId() } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Download failed');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob()); a.download = `${item.segmentName}_fynd_user_ids.csv`; a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast('bad', (e as Error).message); }
  };
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  return <Modal title={`Fynd user IDs · ${item.segmentName}`} onClose={onClose} footer={<>
    <button className="btn ghost" onClick={download}><Icon name="upload" size={14} />Download CSV</button>
    <button className="btn primary" onClick={onClose}>Close</button></>}>
    <p className="muted small">{d ? `${d.tagged.toLocaleString()} tagged · ${d.control.toLocaleString()} in the control group (not tagged)` : 'Loading…'}</p>
    <div className="search wide"><Icon name="search" size={16} /><input autoFocus placeholder="Find a Fynd user ID or customer ID" value={q} onChange={e => { setQ(e.target.value); setPage(1); }} /></div>
    <table className="results compact"><thead><tr><th>Fynd user ID</th><th>Customer ID</th><th>Group</th></tr></thead>
      <tbody>{d?.rows.map(r => <tr key={`${r.group}-${r.fynd_user_id}`}><td className="mono">{r.fynd_user_id}</td><td>{r.customer_id}</td>
        <td>{r.group === 'tagged' ? <span className="badge ok mini">tagged</span> : <span className="badge muted mini">control</span>}</td></tr>)}</tbody></table>
    {d && d.total === 0 && <p className="muted small">No match.</p>}
    <div className="pager">
      <span className="muted small">{d ? `${d.total.toLocaleString()} rows` : ''}</span>
      <div className="row tight">
        <button className="btn ghost sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button>
        <span className="muted small">Page {page} / {pages}</span>
        <button className="btn ghost sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</button>
      </div>
    </div>
  </Modal>;
}
