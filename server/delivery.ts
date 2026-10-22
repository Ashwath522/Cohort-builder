/**
 * Business rules applied after filtering — who actually gets the message:
 *   matched → minus recently-messaged (suppression) → sorted → top N → minus holdout (control group) → send.
 */
import crypto from 'node:crypto';
import { fieldValue } from './filter.js';
import type { CustomerRow, Delivery, SortKey } from './model.js';
import { store } from './store.js';

export const SORTS: Record<SortKey, string> = {
  last_purchase_date: 'Last purchase date',
  first_purchase_date: 'First purchase date',
  registered_at: 'Registered on',
  lifetime_gmv: 'Lifetime spend',
  lifetime_order_count: 'Number of orders',
  aov: 'Avg order value',
  days_since_last_purchase: 'Days since last purchase',
};
export const DEFAULT_DELIVERY: Delivery = { sortBy: 'lifetime_gmv', dir: 'desc', holdoutPct: 0, suppressDays: 0 };

export function cleanDelivery(d: Partial<Delivery> | undefined, source: 'excel' | 'powerbi'): Delivery {
  const x = { ...DEFAULT_DELIVERY, ...(d ?? {}) };
  if (!(x.sortBy in SORTS)) throw new Error('Unknown sort');
  if (x.dir !== 'asc' && x.dir !== 'desc') x.dir = 'desc';
  const limit = x.limit === undefined || x.limit === null || (x.limit as unknown) === '' ? undefined : Math.floor(Number(x.limit));
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error('Audience limit must be a positive number');
  if (limit !== undefined && source === 'powerbi') throw new Error('"Send to top N" works on Excel data for now; Power BI fetches only ID + email');
  const holdoutPct = Number(x.holdoutPct) || 0;
  if (holdoutPct < 0 || holdoutPct > 50) throw new Error('Control group must be 0–50%');
  const suppressDays = Number(x.suppressDays) || 0;
  if (suppressDays < 0 || suppressDays > 365) throw new Error('Suppression must be 0–365 days');
  return { sortBy: x.sortBy, dir: x.dir, limit, holdoutPct, suppressDays };
}

/** Sort; blanks always last, whatever the direction. */
export function sortRows(rows: CustomerRow[], by: SortKey, dir: 'asc' | 'desc', asOf: string) {
  const k = rows.map(r => ({ r, v: fieldValue(r, by, asOf) as string | number | undefined }));
  k.sort((a, b) => {
    if (a.v === undefined && b.v === undefined) return a.r.customer_id.localeCompare(b.r.customer_id);
    if (a.v === undefined) return 1;
    if (b.v === undefined) return -1;
    const c = a.v < b.v ? -1 : a.v > b.v ? 1 : a.r.customer_id.localeCompare(b.r.customer_id);
    return dir === 'asc' ? c : -c;
  });
  return k.map(x => x.r);
}

/** Email fingerprints of everyone actually sent in another cohort within the last N days. */
export function recentlyMessaged(days: number, exceptCohortId?: string): Set<string> {
  const out = new Set<string>();
  if (!days) return out;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  for (const c of store.cohorts()) {
    if (c.id === exceptCohortId) continue;
    const s = store.getSnapshot(c.id);
    if (s?.pushedAt && s.pushedAt >= since) for (const a of s.audience) out.add(a.email_hash);
  }
  return out;
}

/** Deterministic control-group pick, seeded by the segment name: preview, approval and re-runs pick the same people. */
const inHoldout = (seed: string, emailHash: string, pct: number) =>
  pct > 0 && crypto.createHash('sha256').update(seed + emailHash).digest().readUInt16BE(0) % 100 < pct;

export function applyDelivery(rows: CustomerRow[], d: Delivery, asOf: string, seed: string, exceptCohortId?: string) {
  const funnel: Array<{ step: string; count: number; aside?: boolean }> = [{ step: 'Matched the filters', count: rows.length }];
  let r = rows;
  if (d.suppressDays) {
    const recent = recentlyMessaged(d.suppressDays, exceptCohortId);
    r = r.filter(x => !recent.has(x.email_hash));
    funnel.push({ step: `Not messaged in the last ${d.suppressDays} days`, count: r.length });
  }
  r = sortRows(r, d.sortBy, d.dir, asOf);
  if (d.limit && r.length > d.limit) {
    r = r.slice(0, d.limit);
    const isDate = ['last_purchase_date', 'first_purchase_date', 'registered_at'].includes(d.sortBy);
    const order = isDate ? (d.dir === 'desc' ? 'newest first' : 'oldest first') : (d.dir === 'desc' ? 'highest first' : 'lowest first');
    funnel.push({ step: `Top ${d.limit.toLocaleString()} by ${SORTS[d.sortBy].toLowerCase()} (${order})`, count: r.length });
  }
  const send: CustomerRow[] = [], holdout: CustomerRow[] = [];
  for (const x of r) (inHoldout(seed, x.email_hash, d.holdoutPct) ? holdout : send).push(x);
  if (d.holdoutPct) funnel.push({ step: `Control group kept aside (${d.holdoutPct}%, not sent)`, count: holdout.length, aside: true });
  funnel.push({ step: 'Will be sent to CleverTap', count: send.length });
  return { send, holdout, funnel };
}
