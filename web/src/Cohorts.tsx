import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, post, type Catalog, type Cohort, type FilterButton, type Run } from './api';
import { describe } from './rules';
import { Funnel } from './Charts';

const STATUS_CLASS: Record<string, string> = { draft: 'muted', pending_approval: 'warn', approved: 'ok', rejected: 'bad', pushing: 'warn', pushed: 'ok', failed: 'bad' };

export default function Cohorts({ catalog, userId, role, buttons }: { catalog: Catalog; userId: string; role?: string; buttons: FilterButton[] }) {
  const [list, setList] = useState<Cohort[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(() => api<Cohort[]>('/cohorts').then(setList).catch(e => setMsg({ ok: false, text: e.message })), []);
  useEffect(() => { load(); }, [load]);

  const isCreator = role === 'creator' || role === 'admin';
  const isApprover = role === 'approver' || role === 'admin';
  async function act(c: Cohort, action: string, body?: unknown) {
    setBusy(c.id + action); setMsg(null);
    try {
      const r = await post<Cohort | { cohort: Cohort; run: Run }>(`/cohorts/${c.id}/${action}`, body);
      if ('run' in r) setMsg({ ok: r.run.status === 'success', text: r.run.status === 'success'
        ? `${r.run.mode === 'dry-run' ? 'Dry run' : 'Pushed to CleverTap'}: ${r.run.rowsSent?.toLocaleString()} customers → segment "${r.run.segmentName}"`
        : `Push failed: ${r.run.error}` });
      else setMsg({ ok: true, text: `${c.name}: ${r.status.replace('_', ' ')}` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    setBusy(''); load();
  }

  return (
    <section className="card">
      <h2>Cohorts</h2>
      <p className="muted">Creator saves and submits → a different person approves (this locks the audience) → push to CleverTap.</p>
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      {list.length === 0 ? <p className="muted">No cohorts yet. Build one in step 2.</p> : (
        <table><thead><tr><th>Cohort</th><th>Segment</th><th>Source</th><th>Status</th><th>Audience</th><th>Actions</th></tr></thead><tbody>
          {list.map(c => <Fragment key={c.id}>
            <tr>
              <td><button className="link strong" onClick={() => setOpen(open === c.id ? null : c.id)}>{c.name}</button><div className="muted small">by {c.createdBy} · {c.createdAt.slice(0, 10)}</div></td>
              <td><code>{c.segmentName}</code></td>
              <td>{c.source}{c.dataAsOf && <div className="muted small">as of {c.dataAsOf.slice(0, 10)}</div>}</td>
              <td><span className={`pill ${STATUS_CLASS[c.status]}`}>{c.status.replace('_', ' ')}</span></td>
              <td>{c.snapshotCount !== undefined
                ? <><b>{c.snapshotCount.toLocaleString()}</b> <span className="muted small">to send</span>{!!c.holdoutCount && <div className="muted small">+ {c.holdoutCount.toLocaleString()} control group</div>}</>
                : <>{c.previewCount?.toLocaleString() ?? '—'} <span className="muted small">matched</span></>}</td>
              <td><div className="actions">
                {isCreator && ['draft', 'rejected'].includes(c.status) && <button disabled={!!busy} onClick={() => act(c, 'submit')}>Submit for approval</button>}
                {isApprover && c.status === 'pending_approval' && (c.createdBy === userId
                  ? <span className="muted small">You created this; another approver must approve</span>
                  : <>
                      <button className="primary" disabled={!!busy} onClick={() => act(c, 'approve')}>{busy === c.id + 'approve' ? 'Locking…' : 'Approve'}</button>
                      <button disabled={!!busy} onClick={() => { const reason = prompt('Reason for rejecting?') ?? ''; act(c, 'reject', { reason }); }}>Reject</button>
                    </>)}
                {isApprover && ['approved', 'failed', 'pushed'].includes(c.status) &&
                  <button className="primary" disabled={!!busy} onClick={() => act(c, 'push')}>{busy === c.id + 'push' ? 'Pushing…' : c.status === 'approved' ? 'Push to CleverTap' : c.status === 'failed' ? 'Retry push' : 'Push again'}</button>}
              </div></td>
            </tr>
            {open === c.id && <tr className="details"><td colSpan={6}>
              <div><b>Rules (v{c.rulesVersion}):</b> {describe(c.rules, catalog, buttons)}</div>
              {c.delivery && <div><b>Delivery:</b> ordered by {catalog.sorts[c.delivery.sortBy]?.toLowerCase()} ({c.delivery.dir === 'desc' ? 'high → low / newest' : 'low → high / oldest'})
                {c.delivery.limit ? ` · top ${c.delivery.limit.toLocaleString()}` : ' · everyone'}
                {c.delivery.holdoutPct ? ` · ${c.delivery.holdoutPct}% control group` : ''}
                {c.delivery.suppressDays ? ` · skip if messaged in last ${c.delivery.suppressDays} days` : ''}</div>}
              {c.funnel && <Funnel steps={c.funnel} />}
              {c.rejectedReason && <div className="bad-text">Rejected: {c.rejectedReason}</div>}
              <ul className="history">{c.history.map((h, i) => <li key={i}>{h.at.replace('T', ' ').slice(0, 19)} · <b>{h.by}</b> {h.action}{h.note && ` — ${h.note}`}</li>)}</ul>
            </td></tr>}
          </Fragment>)}
        </tbody></table>
      )}
    </section>
  );
}
