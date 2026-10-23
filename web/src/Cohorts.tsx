import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, post, type Catalog, type Cohort, type FilterButton, type Run } from './api';
import { Funnel } from './Charts';
import { describe } from './rules';
import { Drawer, Empty, Icon, Modal, StatusBadge, timeAgo, useToast } from './ui';

const TABS: Array<[string, string[]]> = [
  ['All', []], ['Drafts', ['draft', 'rejected']], ['Waiting for approval', ['pending_approval']],
  ['Ready to send', ['approved', 'failed']], ['Sent', ['pushed']],
];

export default function Cohorts({ catalog, userId, role, buttons, ctMode, onChanged, openId }: {
  catalog: Catalog; userId: string; role?: string; buttons: FilterButton[]; ctMode: string; onChanged: () => void; openId?: string | null;
}) {
  const toast = useToast();
  const [list, setList] = useState<Cohort[] | null>(null);
  const [tab, setTab] = useState(role === 'approver' ? 'Waiting for approval' : 'All');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [confirm, setConfirm] = useState<null | 'push' | 'reject' | 'approve'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api<Cohort[]>('/cohorts').then(setList).catch(e => toast('bad', e.message)), [toast]);
  useEffect(() => { load(); }, [load]);

  const isCreator = role === 'creator' || role === 'admin';
  const isApprover = role === 'approver' || role === 'admin';
  const shown = useMemo(() => (list ?? []).filter(c => {
    const statuses = TABS.find(t => t[0] === tab)?.[1] ?? [];
    return (!statuses.length || statuses.includes(c.status)) && (!q || `${c.name} ${c.segmentName}`.toLowerCase().includes(q.toLowerCase()));
  }), [list, tab, q]);
  const count = (s: string[]) => (list ?? []).filter(c => !s.length || s.includes(c.status)).length;
  const cur = list?.find(c => c.id === open);

  async function act(c: Cohort, action: string, body?: unknown) {
    setBusy(true);
    try {
      const r = await post<Cohort | { cohort: Cohort; run: Run }>(`/cohorts/${c.id}/${action}`, body);
      if ('run' in r) toast(r.run.status === 'success' ? 'ok' : 'bad', r.run.status === 'success'
        ? `${r.run.mode === 'dry-run' ? 'Dry run done' : 'Sent to CleverTap'}: ${r.run.rowsSent?.toLocaleString()} customers → “${r.run.segmentName}”`
        : `Push failed: ${r.run.error}`);
      else toast('ok', { submit: 'Submitted for approval', approve: `Approved: ${r.snapshotCount?.toLocaleString()} customers locked`, reject: 'Rejected and sent back to the creator' }[action] ?? 'Done');
    } catch (e) { toast('bad', (e as Error).message); }
    setBusy(false); setConfirm(null); setReason(''); load(); onChanged();
  }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Audiences</h1><p className="muted">Creator submits → a second person approves (locks the list) → send to CleverTap.</p></div>
        <div className="search"><Icon name="search" size={16} /><input placeholder="Search audiences" value={q} onChange={e => setQ(e.target.value)} /></div>
      </div>
      <div className="tabs">
        {TABS.map(([t, s]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}<span className="tab-count">{count(s)}</span></button>)}
      </div>
      <section className="card flush">
        {!list ? <div className="pad muted">Loading…</div> : shown.length === 0 ? <Empty icon="users" title="Nothing here">{tab === 'All' ? 'Build an audience to get started.' : 'No audiences in this state.'}</Empty> : (
          <table className="list">
            <thead><tr><th>Audience</th><th>Status</th><th>Source</th><th className="num">Customers</th><th>Updated</th><th /></tr></thead>
            <tbody>{shown.map(c => {
              const last = c.history.at(-1);
              const mine = c.createdBy === userId;
              return <tr key={c.id} className="clickable" onClick={() => setOpen(c.id)}>
                <td><div className="strong">{c.name}</div><div className="muted small mono">{c.segmentName}</div></td>
                <td><StatusBadge status={c.status} />{isApprover && c.status === 'pending_approval' && !mine && <span className="badge warn mini">needs you</span>}</td>
                <td className="muted">{c.source === 'excel' ? 'File' : 'Power BI'}</td>
                <td className="num">{c.snapshotCount !== undefined
                  ? <><b>{c.snapshotCount.toLocaleString()}</b><div className="muted small">to send{c.holdoutCount ? ` · +${c.holdoutCount} control` : ''}</div></>
                  : <>{c.previewCount?.toLocaleString() ?? '—'}<div className="muted small">matched</div></>}</td>
                <td className="muted small">{last ? `${last.action} ${timeAgo(last.at)}` : ''}<div>by {last?.by}</div></td>
                <td><Icon name="chevron" size={16} className="muted" /></td>
              </tr>;
            })}</tbody>
          </table>
        )}
      </section>

      {cur && <Drawer title={cur.name} subtitle={<span className="mono">{cur.segmentName}</span>} onClose={() => setOpen(null)}>
        <div className="row"><StatusBadge status={cur.status} />{cur.rejectedReason && cur.status === 'rejected' && <span className="bad-text small">“{cur.rejectedReason}”</span>}</div>
        <div className="mini-kpis">
          <div><span className="muted small">Matched</span><b>{(cur.funnel?.[0]?.count ?? cur.previewCount)?.toLocaleString() ?? '—'}</b></div>
          <div><span className="muted small">To send</span><b>{cur.snapshotCount?.toLocaleString() ?? '—'}</b></div>
          <div><span className="muted small">Control group</span><b>{cur.holdoutCount?.toLocaleString() ?? (cur.delivery?.holdoutPct ? `${cur.delivery.holdoutPct}%` : '—')}</b></div>
        </div>
        <h4>Filters <span className="muted small">v{cur.rulesVersion}</span></h4>
        <p className="rules-text">{describe(cur.rules, catalog, buttons) || 'Everyone'}</p>
        {cur.delivery && <><h4>Delivery rules</h4><ul className="plain">
          <li>Ordered by {catalog.sorts[cur.delivery.sortBy]?.toLowerCase()} ({['last_purchase_date', 'first_purchase_date', 'registered_at'].includes(cur.delivery.sortBy)
            ? (cur.delivery.dir === 'desc' ? 'newest first' : 'oldest first') : (cur.delivery.dir === 'desc' ? 'highest first' : 'lowest first')})</li>
          <li>{cur.delivery.limit ? `Only the top ${cur.delivery.limit.toLocaleString()}` : 'Everyone matched'}</li>
          <li>{cur.delivery.holdoutPct ? `${cur.delivery.holdoutPct}% control group, not sent` : 'No control group'}</li>
          <li>{cur.delivery.suppressDays ? `Skip anyone messaged in the last ${cur.delivery.suppressDays} days` : 'No skip rule'}</li>
        </ul></>}
        {cur.funnel && <><h4>Locked at approval</h4><Funnel steps={cur.funnel} /></>}
        <h4>Timeline</h4>
        <ol className="timeline">{[...cur.history].reverse().map((h, i) => <li key={i}><span className="t-dot" /><div><b>{h.by}</b> {h.action}{h.note && <span className="muted"> — {h.note}</span>}<div className="muted small">{h.at.replace('T', ' ').slice(0, 16)}</div></div></li>)}</ol>

        <div className="drawer-actions">
          {isCreator && ['draft', 'rejected'].includes(cur.status) && <button className="btn primary" disabled={busy} onClick={() => act(cur, 'submit')}><Icon name="send" size={15} />Submit for approval</button>}
          {isApprover && cur.status === 'pending_approval' && (cur.createdBy === userId
            ? <p className="muted small">You created this audience, so someone else must approve it.</p>
            : <><button className="btn primary" disabled={busy} onClick={() => setConfirm('approve')}><Icon name="lock" size={15} />Approve & lock</button>
                <button className="btn danger-ghost" disabled={busy} onClick={() => setConfirm('reject')}>Reject…</button></>)}
          {isApprover && ['approved', 'failed', 'pushed'].includes(cur.status) && <button className="btn primary" disabled={busy} onClick={() => setConfirm('push')}>
            <Icon name="send" size={15} />{cur.status === 'approved' ? 'Send to CleverTap…' : cur.status === 'failed' ? 'Retry send…' : 'Send again…'}</button>}
          {!isCreator && !isApprover && <p className="muted small">Read-only for your role.</p>}
        </div>
      </Drawer>}

      {cur && confirm === 'approve' && <Modal title="Approve and lock this audience?" onClose={() => setConfirm(null)} footer={<>
        <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => act(cur, 'approve')}>{busy ? 'Locking…' : 'Approve & lock'}</button></>}>
        <p>The filters and delivery rules are applied <b>now</b>, and the resulting list is frozen. Later data changes won't alter it.</p>
        <p className="rules-text">{describe(cur.rules, catalog, buttons)}</p>
      </Modal>}
      {cur && confirm === 'reject' && <Modal title="Reject this audience" onClose={() => setConfirm(null)} footer={<>
        <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => act(cur, 'reject', { reason })}>Reject</button></>}>
        <label className="form-col">What should the creator change?<textarea rows={3} autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Exclude customers who bought in the last 30 days" /></label>
      </Modal>}
      {cur && confirm === 'push' && <Modal title={ctMode === 'live' ? 'Send to CleverTap?' : 'Run a dry run?'} onClose={() => setConfirm(null)} footer={<>
        <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => act(cur, 'push')}>{busy ? 'Sending…' : ctMode === 'live' ? `Send ${cur.snapshotCount?.toLocaleString()} customers` : 'Run dry run'}</button></>}>
        <div className="big-confirm"><Icon name="send" size={22} /><div><b>{cur.snapshotCount?.toLocaleString()}</b> customers → segment <span className="mono">{cur.segmentName}</span></div></div>
        {ctMode === 'live'
          ? <p className="muted">CleverTap replaces this segment's members with this list. Emails are decrypted only in memory for the upload.</p>
          : <p className="muted">CleverTap isn't configured, so nothing will be sent. The app builds and measures the upload file only.</p>}
        {!!cur.holdoutCount && <p className="muted small">{cur.holdoutCount.toLocaleString()} customers in the control group are not sent.</p>}
      </Modal>}
    </div>
  );
}
