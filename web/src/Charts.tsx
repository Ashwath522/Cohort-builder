import { useState, type ReactNode } from 'react';

/** Validated palette (dataviz reference instance, light mode). Slots 1–3 pass all-pairs CVD checks. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const INK = '#0b0b0b', INK2 = '#52514e', MUTED = '#898781', GRID = '#e9e8e4', SURFACE = '#fcfcfb';

export interface Datum { label: string; count: number }

export const inr = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : n >= 1e3 ? `₹${(n / 1e3).toFixed(1)}k` : `₹${Math.round(n)}`;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(a / b < 0.1 ? 1 : 0)}%` : '—');

/** Hover tooltip shared by all charts. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const show = (e: React.MouseEvent, body: ReactNode) => {
    const box = (e.currentTarget as Element).closest('.chart')!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, body });
  };
  const el = tip && <div className="tip" style={{ left: tip.x + 12, top: tip.y - 8 }}>{tip.body}</div>;
  return { show, hide: () => setTip(null), el };
}

export function Kpi({ label, value, sub, hero }: { label: string; value: string; sub?: string; hero?: boolean }) {
  return <div className={`kpi ${hero ? 'hero' : ''}`}><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div>{sub && <div className="kpi-sub">{sub}</div>}</div>;
}

/** Part-to-whole for ≤ 3 classes. Legend carries label, count and share (colour is never the only cue). */
export function Donut({ title, data, note, onSelect }: { title: string; data: Datum[]; note?: string; onSelect?: (label: string) => void }) {
  const { show, hide, el } = useTip();
  const total = data.reduce((s, d) => s + d.count, 0);
  const R = 70, r = 46, C = 90;
  let a0 = -Math.PI / 2;
  const arcs = data.map((d, i) => {
    const frac = total ? d.count / total : 0;
    const a1 = a0 + frac * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, a: number) => `${C + rad * Math.cos(a)} ${C + rad * Math.sin(a)}`;
    const path = frac >= 0.9999
      ? `M ${C} ${C - R} A ${R} ${R} 0 1 1 ${C - 0.01} ${C - R} L ${C - 0.01} ${C - r} A ${r} ${r} 0 1 0 ${C} ${C - r} Z`
      : `M ${p(R, a0)} A ${R} ${R} 0 ${large} 1 ${p(R, a1)} L ${p(r, a1)} A ${r} ${r} 0 ${large} 0 ${p(r, a0)} Z`;
    const out = { d, i, path, show: frac > 0 };
    a0 = a1;
    return out;
  });
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <div className="donut-wrap">
        <svg viewBox="0 0 180 180" width="150" height="150" role="img" aria-label={`${title}: ${data.map(d => `${d.label} ${d.count}`).join(', ')}`}>
          {arcs.filter(a => a.show).map(a =>
            <path key={a.d.label} d={a.path} fill={SERIES[a.i % SERIES.length]} stroke={SURFACE} strokeWidth={2} className={onSelect ? 'clickable' : ''}
              onClick={() => onSelect?.(a.d.label)}
              onMouseMove={e => show(e, <><b>{a.d.label}</b><br />{a.d.count.toLocaleString()} · {pct(a.d.count, total)}{onSelect && <><br /><i>Click to filter</i></>}</>)} onMouseLeave={hide} />)}
          <text x={C} y={C - 2} textAnchor="middle" fontSize="20" fontWeight="600" fill={INK}>{total.toLocaleString()}</text>
          <text x={C} y={C + 16} textAnchor="middle" fontSize="11" fill={INK2}>customers</text>
        </svg>
        <ul className="legend">
          {data.map((d, i) => <li key={d.label} className={onSelect ? 'clickable' : ''} onClick={() => onSelect?.(d.label)} title={onSelect ? 'Click to filter' : undefined}><span className="swatch" style={{ background: SERIES[i % SERIES.length] }} />
            <span className="lg-label">{d.label}</span><span className="lg-val">{d.count.toLocaleString()}</span><span className="lg-pct">{pct(d.count, total)}</span></li>)}
        </ul>
      </div>
      {note && <p className="chart-note">{note}</p>}
      {el}
    </figure>
  );
}

/** Rounded data-end on the value side, square at the baseline. */
const barPath = (x: number, y: number, w: number, h: number, horizontal: boolean) => {
  const r = Math.min(4, horizontal ? w : h, horizontal ? h / 2 : w / 2);
  if (r <= 0) return '';
  return horizontal
    ? `M ${x} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x} Z`
    : `M ${x} ${y + h} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h} Z`;
};

/** Ordered buckets (recency, spend bands) as columns, one hue. */
export function Columns({ title, data, note, onSelect }: { title: string; data: Datum[]; note?: string; onSelect?: (label: string) => void }) {
  const { show, hide, el } = useTip();
  const total = data.reduce((s, d) => s + d.count, 0);
  const max = Math.max(1, ...data.map(d => d.count));
  const W = 360, H = 190, padL = 8, padB = 34, padT = 18;
  const slot = (W - padL * 2) / data.length, bw = Math.min(40, slot * 0.62);
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title}: ${data.map(d => `${d.label} ${d.count}`).join(', ')}`}>
        <line x1={padL} x2={W - padL} y1={H - padB} y2={H - padB} stroke={MUTED} strokeWidth={1} />
        {data.map((d, i) => {
          const h = ((H - padB - padT) * d.count) / max;
          const x = padL + i * slot + (slot - bw) / 2, y = H - padB - h;
          return <g key={d.label} className={onSelect && d.count ? 'clickable' : ''} onClick={() => d.count && onSelect?.(d.label)} onMouseMove={e => show(e, <><b>{d.label}</b><br />{d.count.toLocaleString()} · {pct(d.count, total)}{onSelect && d.count > 0 && <><br /><i>Click to filter</i></>}</>)} onMouseLeave={hide}>
            <rect x={padL + i * slot} y={padT} width={slot} height={H - padB - padT} fill="transparent" />
            {d.count > 0 && <path d={barPath(x, y, bw, h, false)} fill={SERIES[0]} />}
            <text x={x + bw / 2} y={y - 5} textAnchor="middle" fontSize="10.5" fill={INK2}>{d.count.toLocaleString()}</text>
            <text x={x + bw / 2} y={H - padB + 14} textAnchor="middle" fontSize="10.5" fill={INK2}>{d.label.split(' ')[0]}</text>
            <text x={x + bw / 2} y={H - padB + 26} textAnchor="middle" fontSize="10.5" fill={MUTED}>{d.label.split(' ').slice(1).join(' ')}</text>
          </g>;
        })}
      </svg>
      {note && <p className="chart-note">{note}</p>}
      {el}
    </figure>
  );
}

/** Ranked categories (categories, cities) as horizontal bars, one hue, value at the bar end. */
export function HBars({ title, data, base, note, onSelect }: { title: string; data: Datum[]; base: number; note?: string; onSelect?: (label: string) => void }) {
  const { show, hide, el } = useTip();
  const max = Math.max(1, ...data.map(d => d.count));
  const rowH = 22, labelW = 110, W = 360, H = Math.max(rowH, data.length * rowH) + 6;
  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      {data.length === 0 ? <p className="muted small">No data in this source.</p> :
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${title}: ${data.map(d => `${d.label} ${d.count}`).join(', ')}`}>
          <line x1={labelW} x2={labelW} y1={0} y2={H} stroke={GRID} />
          {data.map((d, i) => {
            const w = ((W - labelW - 70) * d.count) / max, y = i * rowH + 4;
            return <g key={d.label} className={onSelect ? 'clickable' : ''} onClick={() => onSelect?.(d.label)} onMouseMove={e => show(e, <><b>{d.label}</b><br />{d.count.toLocaleString()} customers · {pct(d.count, base)} of audience{onSelect && <><br /><i>Click to filter</i></>}</>)} onMouseLeave={hide}>
              <rect x={0} y={y - 2} width={W} height={rowH} fill="transparent" />
              <text x={labelW - 8} y={y + 12} textAnchor="end" fontSize="11" fill={INK2}>{d.label.length > 16 ? d.label.slice(0, 15) + '…' : d.label}</text>
              <path d={barPath(labelW, y, w, 14, true)} fill={SERIES[0]} />
              <text x={labelW + w + 6} y={y + 11} fontSize="10.5" fill={INK2}>{d.count.toLocaleString()} · {pct(d.count, base)}</text>
            </g>;
          })}
        </svg>}
      {note && <p className="chart-note">{note}</p>}
      {el}
    </figure>
  );
}

/** Delivery funnel: each step's bar is to scale against the matched count. */
export function Funnel({ steps }: { steps: Array<{ step: string; count: number; aside?: boolean }> }) {
  const max = Math.max(1, steps[0]?.count ?? 1);
  return (
    <div className="funnel">
      {steps.map((s, i) => <div key={i} className={`fstep ${s.aside ? 'aside' : ''} ${i === steps.length - 1 ? 'final' : ''}`}>
        <span className="fs-label">{s.step}</span>
        <span className="fs-track"><span style={{ width: `${(s.count / max) * 100}%` }} /></span>
        <span className="fs-num">{s.count.toLocaleString()}</span>
      </div>)}
    </div>
  );
}
