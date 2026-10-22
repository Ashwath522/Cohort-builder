import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Cohort, Dataset, Run, Snapshot } from './model.js';

/** Tiny JSON-file store. Swap for MySQL/Postgres in production; the shapes stay the same. */
const dir = (...p: string[]) => path.join(config.dataDir, ...p);
fs.mkdirSync(dir('datasets'), { recursive: true });
fs.mkdirSync(dir('snapshots'), { recursive: true });

const readJson = <T>(file: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
};
const writeJson = (file: string, data: unknown) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
};

export const store = {
  saveDataset: (d: Dataset) => writeJson(dir('datasets', `${d.id}.json`), d),
  getDataset: (id: string): Dataset | undefined =>
    /^[\w-]+$/.test(id) ? readJson<Dataset | undefined>(dir('datasets', `${id}.json`), undefined) : undefined,
  listDatasets: (): Array<Omit<Dataset, 'rows' | 'orderLines'> & { hasOrderLines: boolean }> =>
    fs.readdirSync(dir('datasets')).filter(f => f.endsWith('.json')).map(f => {
      const { rows, orderLines, ...meta } = readJson<Dataset>(dir('datasets', f), {} as Dataset);
      return { ...meta, hasOrderLines: Boolean(orderLines?.length) };
    }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
  deleteDataset: (id: string) => { if (/^[\w-]+$/.test(id)) fs.rmSync(dir('datasets', `${id}.json`), { force: true }); },

  cohorts: (): Cohort[] => readJson<Cohort[]>(dir('cohorts.json'), []),
  saveCohort: (c: Cohort) => {
    const all = store.cohorts().filter(x => x.id !== c.id);
    writeJson(dir('cohorts.json'), [c, ...all]);
  },
  getCohort: (id: string) => store.cohorts().find(c => c.id === id),

  saveSnapshot: (s: Snapshot) => writeJson(dir('snapshots', `${s.cohortId}.json`), s),
  getSnapshot: (cohortId: string) => readJson<Snapshot | undefined>(dir('snapshots', `${cohortId}.json`), undefined),

  runs: (): Run[] => readJson<Run[]>(dir('runs.json'), []),
  saveRun: (r: Run) => {
    const all = store.runs().filter(x => x.id !== r.id);
    writeJson(dir('runs.json'), [r, ...all]);
  },

  /** Retention: delete uploaded datasets past their expiry. */
  purgeExpired: () => {
    const now = new Date().toISOString();
    let n = 0;
    for (const d of store.listDatasets()) if (d.expiresAt < now) { store.deleteDataset(d.id); n++; }
    return n;
  },
};
