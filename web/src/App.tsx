import { useCallback, useEffect, useState } from 'react';
import { api, setUser, type Catalog, type DatasetMeta } from './api';
import DataSource from './DataSource';
import Builder from './Builder';
import Cohorts from './Cohorts';
import Runs from './Runs';

interface Health { keysReady: boolean; clevertap: string; ctBaseUrl: string; powerbi: string; users: Array<{ id: string; name: string; role: string }> }
const TABS = ['1. Data source', '2. Build cohort', '3. Cohorts & approval', '4. Push history'] as const;

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [user, setU] = useState('priya');
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [error, setError] = useState('');

  const loadDatasets = useCallback(() => api<DatasetMeta[]>('/sources/excel').then(setDatasets).catch(e => setError(e.message)), []);
  useEffect(() => {
    api<Health>('/health').then(setHealth).catch(() => setError('Cannot reach the API. Is `npm run dev` running?'));
    api<Catalog>('/catalog').then(setCatalog);
    loadDatasets();
  }, [loadDatasets]);

  const me = health?.users.find(u => u.id === user);
  return (
    <div className="app">
      <header>
        <div>
          <h1>Cohort Builder</h1>
          <span className="sub">Historical purchase segments → CleverTap, without raw lists</span>
        </div>
        <div className="header-right">
          {health && <>
            <span className={`pill ${health.clevertap === 'live' ? 'ok' : 'warn'}`} title={health.ctBaseUrl}>CleverTap: {health.clevertap}</span>
            <span className={`pill ${health.powerbi === 'configured' ? 'ok' : 'muted'}`}>Power BI: {health.powerbi}</span>
            {!health.keysReady && <span className="pill bad">Keys missing: run npm run keys</span>}
          </>}
          <label className="acting">Acting as
            <select value={user} onChange={e => { setU(e.target.value); setUser(e.target.value); }}>
              {health?.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        </div>
      </header>
      <nav>{TABS.map(t => <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>)}</nav>
      {error && <div className="alert bad">{error}</div>}
      <main key={user}>
        {tab === TABS[0] && <DataSource datasets={datasets} reload={loadDatasets} role={me?.role} />}
        {tab === TABS[1] && catalog && <Builder catalog={catalog} datasets={datasets} role={me?.role} onSaved={() => setTab(TABS[2])} />}
        {tab === TABS[2] && catalog && <Cohorts catalog={catalog} userId={user} role={me?.role} />}
        {tab === TABS[3] && <Runs />}
      </main>
      <footer>Emails are encrypted (AES-256-GCM) the moment data arrives; only the push step decrypts them, in memory. Phone numbers are never read.</footer>
    </div>
  );
}
