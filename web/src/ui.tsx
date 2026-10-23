import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

// ───────────────────────── Icons (inline SVG, stroke = currentColor) ─────────────────────────
const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  filter: 'M4 5h16l-6 8v5l-4 2v-7z',
  users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4l3 2',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
  plus: 'M12 5v14M5 12h14',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 3-4.3-4.3',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  lock: 'M6 11V8a6 6 0 1 1 12 0v3M5 11h14v10H5z',
  chevron: 'M9 6l6 6-6 6',
  shield: 'M12 3 4 6v6c0 5 3.4 8.3 8 9 4.6-.7 8-4 8-9V6z',
};
export function Icon({ name, size = 18, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name] ?? ''} /></svg>;
}

// ───────────────────────── Toasts ─────────────────────────
type Toast = { id: number; kind: 'ok' | 'bad' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setList(l => [...l, { id, kind, text }]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), kind === 'bad' ? 7000 : 4000);
  }, []);
  return <ToastCtx.Provider value={push}>
    {children}
    <div className="toasts" role="status" aria-live="polite">
      {list.map(t => <div key={t.id} className={`toast ${t.kind}`}>
        <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'bad' ? 'alert' : 'spark'} size={16} />
        <span>{t.text}</span>
        <button className="icon-btn" aria-label="Dismiss" onClick={() => setList(l => l.filter(x => x.id !== t.id))}><Icon name="x" size={14} /></button>
      </div>)}
    </div>
  </ToastCtx.Provider>;
}

// ───────────────────────── Modal & drawer ─────────────────────────
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
}
export function Modal({ title, children, footer, onClose, wide }: { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }) {
  useEscape(onClose);
  return <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-head"><h3>{title}</h3><button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  </div>;
}
export function Drawer({ title, children, onClose, subtitle }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; onClose: () => void }) {
  useEscape(onClose);
  return <div className="overlay right" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <aside className="drawer" role="dialog" aria-modal="true">
      <div className="drawer-head"><div><h3>{title}</h3>{subtitle && <div className="muted small">{subtitle}</div>}</div><button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button></div>
      <div className="drawer-body">{children}</div>
    </aside>
  </div>;
}

// ───────────────────────── Small pieces ─────────────────────────
const STATUS: Record<string, [string, string]> = {
  draft: ['Draft', 'muted'], pending_approval: ['Waiting for approval', 'warn'], approved: ['Approved · locked', 'info'],
  rejected: ['Rejected', 'bad'], pushing: ['Pushing…', 'warn'], pushed: ['Sent to CleverTap', 'ok'], failed: ['Push failed', 'bad'],
  success: ['Success', 'ok'], running: ['Running', 'warn'],
};
export const StatusBadge = ({ status }: { status: string }) => {
  const [label, tone] = STATUS[status] ?? [status, 'muted'];
  return <span className={`badge ${tone}`}><span className="dot" />{label}</span>;
};
export const Empty = ({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) =>
  <div className="empty"><div className="empty-icon"><Icon name={icon} size={26} /></div><h4>{title}</h4>{children && <div className="muted">{children}</div>}</div>;
export const Skeleton = ({ h = 16, w = '100%' }: { h?: number; w?: number | string }) => <div className="skeleton" style={{ height: h, width: w }} />;
export const Avatar = ({ name }: { name: string }) => <span className="avatar" aria-hidden="true">{name.split(/[\s(]/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase()}</span>;
export const timeAgo = (iso?: string) => {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'segment';
