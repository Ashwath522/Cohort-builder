import { useCallback, useEffect, useState } from 'react';
import { api, setUser, type Catalog, type Cohort, type DatasetMeta, type FilterButton } from './api';
import Builder, { type Preset } from './Builder';
import Cohorts from './Cohorts';
import DataSource from './DataSource';
import Home from './Home';
import Runs from './Runs';
import { Avatar, Icon, ToastProvider } from './ui';

interface Health { clevertap: string; identity?: string; logRetentionDays?: number; ctBaseUrl: string; powerbi: string; users: Array<{ id: string; name: string; role: string }> }
const ROUTES = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'build', label: 'Build audience', icon: 'filter' },
  { id: 'cohorts', label: 'Audiences', icon: 'users' },
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'data', label: 'Data sources', icon: 'data' },
] as const;
type Route = (typeof ROUTES)[number]['id'];
const routeFromHash = (): Route => (ROUTES.find(r => `#/${r.id}` === location.hash)?.id ?? 'home');

export default function App() { return <ToastProvider><Shell /></ToastProvider>; }

function Shell() {
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [user, setU] = useState('priya');
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [buttons, setButtons] = useState<FilterButton[]>([]);
  const [pending, setPending] = useState(0);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [openCohort, setOpenCohort] = useState<string | null>(null);
  const [down, setDown] = useState(false);

  const go = useCallback((r: string) => { location.hash = `#/${r}`; }, []);
  useEffect(() => { const h = () => setRoute(routeFromHash()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h); }, []);
  const loadDatasets = useCallback(() => api<DatasetMeta[]>('/sources/excel').then(setDatasets).catch(() => {}), []);
  const loadPending = useCallback(() => api<Cohort[]>('/cohorts').then(l => setPending(l.filter(c => c.status === 'pending_approval').length)).catch(() => {}), []);
  useEffect(() => {
    api<Health>('/health').then(h => { setHealth(h); setDown(false); }).catch(() => setDown(true));
    api<Catalog>('/catalog').then(setCatalog).catch(() => {});
    loadDatasets(); loadPending();
  }, [loadDatasets, loadPending]);
  useEffect(() => { api<FilterButton[]>('/filters').then(setButtons).catch(() => {}); loadPending(); if (route !== 'cohorts') setOpenCohort(null); }, [route, user, loadPending]);

  const users = health?.users.filter(u => u.role !== 'developer') ?? [];
  const me = users.find(u => u.id === user);
  const roleLabel = me?.role === 'creator' ? 'Marketing · creator' : me?.role === 'approver' ? 'Approver' : me?.role === 'admin' ? 'Admin' : '';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo">CB</span><div><b>Cohort Builder</b><span>Purchase-history segments</span></div></div>
        <nav>{ROUTES.map(r => <a key={r.id} href={`#/${r.id}`} className={route === r.id ? 'active' : ''}>
          <Icon name={r.icon} /><span>{r.label}</span>{r.id === 'cohorts' && pending > 0 && <span className="nav-count">{pending}</span>}
        </a>)}</nav>
        <div className="sidebar-foot">
          {health && <div className="sys">
            <div><span className={`led ${health.clevertap === 'live' ? 'on' : 'warn'}`} />CleverTap: {health.clevertap === 'live' ? 'connected' : 'dry run'}</div>
            <div><span className={`led ${health.powerbi === 'configured' ? 'on' : 'off'}`} />Power BI: {health.powerbi === 'configured' ? 'connected' : 'not set up'}</div>
          </div>}
          <div className="muted tiny"><Icon name="shield" size={13} /> Fynd user IDs only · no email or phone</div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="crumb">{ROUTES.find(r => r.id === route)?.label}</div>
          <div className="who">
            {me && <Avatar name={me.name} />}
            <div className="who-text"><select aria-label="Acting as" value={user} onChange={e => { setU(e.target.value); setUser(e.target.value); }}>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select><span className="muted tiny">{roleLabel} · demo sign-in</span></div>
          </div>
        </header>
        {down && <div className="alert bad banner"><Icon name="alert" size={16} />Can't reach the API. Is <code>npm run dev</code> running? Check the <code>[api]</code> lines in your terminal.</div>}
        <main key={user}>
          {route === 'home' && <Home userName={me?.name ?? ''} role={me?.role} datasets={datasets} go={go}
            startPreset={p => { setPreset(p); go('build'); }} openCohort={id => { setOpenCohort(id); go('cohorts'); }} />}
          {route === 'build' && catalog && <Builder catalog={catalog} datasets={datasets} role={me?.role} buttons={buttons}
            preset={preset} onPresetUsed={() => setPreset(null)} onSaved={() => { loadPending(); go('cohorts'); }} />}
          {route === 'cohorts' && catalog && <Cohorts catalog={catalog} userId={user} role={me?.role} buttons={buttons} ctMode={health?.clevertap ?? 'dry-run'}
            onChanged={loadPending} openId={openCohort} />}
          {route === 'history' && catalog && <Runs catalog={catalog} buttons={buttons} />}
          {route === 'data' && <DataSource datasets={datasets} reload={loadDatasets} role={me?.role} />}
        </main>
      </div>
    </div>
  );
}
