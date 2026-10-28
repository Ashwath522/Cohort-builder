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
/** Data saved before the switch to Fynd user IDs (rows with encrypted emails) is treated as gone. */
const legacy = (rows?: Array<Record<string, unknown>>) => Boolean(rows?.length && !('fynd_user_id' in rows[0]));
const STATUS_RENAMES: Record<string, string> = { pushing: 'tagging', pushed: 'tagged' };

const writeJson = (file: string, data: unknown) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
};

export const store = {
  saveDataset: (d: Dataset) => writeJson(dir('datasets', `${d.id}.json`), d),
  getDataset: (id: string): Dataset | undefined => {
    const d = /^[\w-]+$/.test(id) ? readJson<Dataset | undefined>(dir('datasets', `${id}.json`), undefined) : undefined;
    return d && !legacy(d.rows as unknown as Array<Record<string, unknown>>) ? d : undefined;
  },
  listDatasets: (): Array<Omit<Dataset, 'rows' | 'orderLines'> & { hasOrderLines: boolean }> =>
    fs.readdirSync(dir('datasets')).filter(f => f.endsWith('.json')).flatMap(f => {
      const { rows, orderLines, ...meta } = readJson<Dataset>(dir('datasets', f), {} as Dataset);
      return legacy(rows as unknown as Array<Record<string, unknown>>) ? [] : [{ ...meta, hasOrderLines: Boolean(orderLines?.length) }];
    }).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
  deleteDataset: (id: string) => { if (/^[\w-]+$/.test(id)) fs.rmSync(dir('datasets', `${id}.json`), { force: true }); },

  cohorts: (): Cohort[] => readJson<Cohort[]>(dir('cohorts.json'), [])
    .map(c => ({ ...c, status: (STATUS_RENAMES[c.status] ?? c.status) as Cohort['status'] })),
  saveCohort: (c: Cohort) => {
    const all = store.cohorts().filter(x => x.id !== c.id);
    writeJson(dir('cohorts.json'), [c, ...all]);
  },
  getCohort: (id: string) => store.cohorts().find(c => c.id === id),

  saveSnapshot: (s: Snapshot) => writeJson(dir('snapshots', `${s.cohortId}.json`), s),
  getSnapshot: (cohortId: string): Snapshot | undefined => {
    const s = readJson<Snapshot & { pushedAt?: string } | undefined>(dir('snapshots', `${cohortId}.json`), undefined);
    if (!s) return undefined;
    if (legacy(s.audience as unknown as Array<Record<string, unknown>>)) return { ...s, audience: [], holdout: [], idsPurged: true };
    return { ...s, taggedAt: s.taggedAt ?? s.pushedAt };
  },

  runs: (): Run[] => readJson<Array<Run & { rowsSent?: number }>>(dir('runs.json'), [])
    .map(r => ({ ...r, rowsTagged: r.rowsTagged ?? r.rowsSent, attempt: r.attempt ?? 1 })),
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

  /** Segment log retention: after LOG_RETENTION_DAYS (≥ 90) drop the ID lists and runs; the cohort record stays. */
  purgeOldLogs: (days: number) => {
    const before = new Date(Date.now() - days * 864e5).toISOString();
    let n = 0;
    for (const c of store.cohorts()) {
      const s = store.getSnapshot(c.id);
      const last = c.history.at(-1)?.at ?? c.createdAt;
      if (s && !s.idsPurged && last < before) {
        store.saveSnapshot({ ...s, audience: [], holdout: [], idsPurged: true }); n++;
      }
    }
    const runs = store.runs();
    const keep = runs.filter(r => r.startedAt >= before);
    if (keep.length !== runs.length) writeJson(dir('runs.json'), keep);
    return n + runs.length - keep.length;
  },
};
