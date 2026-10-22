import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { config, ctConfigured, pbiConfigured } from './config.js';
import { keysReady } from './crypto.js';
import { breakdowns, CATALOG, matches, OPS, RuleError, validateRules } from './filter.js';
import type { Cohort, CustomerRow, FieldKey, Group, Run, Snapshot } from './model.js';
import { store } from './store.js';
import { ingestExcel } from './sources/excel.js';
import { loadMapping, mappedFields, buildDax } from './sources/dax.js';
import { PBI_REQUIREMENTS, lastRefresh, pbiCount, pbiFetchProtected, testConnection } from './sources/powerbi.js';
import { pushToCleverTap } from './clevertap.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 1 } });

// ── Demo users. Replace with company SSO (Entra ID / Google) before real use. ──
const USERS = [
  { id: 'priya', name: 'Priya (Marketing)', role: 'creator' },
  { id: 'rahul', name: 'Rahul (Approver)', role: 'approver' },
  { id: 'admin', name: 'Admin', role: 'admin' },
] as const;
type User = (typeof USERS)[number];
const userOf = (req: Request): User => {
  const u = USERS.find(x => x.id === req.header('X-User'));
  if (!u) throw Object.assign(new Error('Pick a user'), { status: 401 });
  return u;
};
const can = (u: User, ...roles: string[]) => {
  if (u.role !== 'admin' && !roles.includes(u.role)) throw Object.assign(new Error(`${u.name} is not allowed to do this`), { status: 403 });
};
const h = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const now = () => new Date().toISOString();
const daysOld = (iso?: string) => (iso ? (Date.now() - Date.parse(iso)) / 864e5 : Infinity);
const freshness = (iso?: string) => {
  const d = daysOld(iso);
  if (!iso) return { dataAsOf: null, daysOld: null, level: 'warn' };      // unknown age: warn, don't block
  return { dataAsOf: iso, daysOld: Math.floor(d),
    level: d > config.staleBlockDays ? 'blocked' : d > config.staleWarnDays ? 'warn' : 'ok' };
};
const log = (msg: string) => console.log(`[${now()}] ${msg}`);   // counts only, never emails

// ── Health / setup ──
app.get('/api/health', (_req, res) => res.json({
  keysReady: keysReady(), clevertap: ctConfigured() ? 'live' : 'dry-run', ctBaseUrl: config.ct.baseUrl,
  powerbi: pbiConfigured() ? 'configured' : 'not-configured', users: USERS,
}));
app.get('/api/catalog', (_req, res) => res.json({ fields: CATALOG, ops: OPS }));

// ── Data sources ──
app.post('/api/sources/excel', upload.single('file'), h(async (req, res) => {
  const u = userOf(req); can(u, 'creator');
  if (!req.file) return res.status(400).json({ error: 'Attach an .xlsx or .csv file' });
  const dataAsOf = String(req.body.dataAsOf ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataAsOf)) return res.status(400).json({ error: 'Enter the date the Excel was exported' });
  if (dataAsOf > now().slice(0, 10)) return res.status(400).json({ error: 'Export date cannot be in the future' });
  try {
    const ds = await ingestExcel(req.file.buffer, req.file.originalname, u.id, dataAsOf);
    req.file.buffer.fill(0);                                     // wipe the original upload from memory
    store.saveDataset(ds);
    log(`excel dataset ${ds.id}: ${ds.report.validRows}/${ds.report.totalRows} rows valid`);
    const { rows, ...meta } = ds;
    res.json({ dataset: meta, freshness: freshness(dataAsOf) });
  } catch (e) {
    const report = (e as { report?: unknown }).report;
    res.status(400).json({ error: (e as Error).message, report });
  }
}));
app.get('/api/sources/excel', h((req, res) => { userOf(req); res.json(store.listDatasets().map(d => ({ ...d, freshness: freshness(d.dataAsOf) }))); }));
app.delete('/api/sources/excel/:id', h((req, res) => { can(userOf(req), 'creator'); store.deleteDataset(req.params.id); res.json({ ok: true }); }));

app.get('/api/sources/powerbi', h((req, res) => {
  userOf(req);
  const m = loadMapping();
  res.json({
    configured: pbiConfigured(),
    requirements: PBI_REQUIREMENTS.map(r => ({ ...r, done: r.env ? Boolean(process.env[r.env]) : null })),
    fieldsAvailable: mappedFields(m), choices: m.choices,
  });
}));
app.post('/api/sources/powerbi/test', h(async (req, res) => { userOf(req); res.json(await testConnection()); }));
app.post('/api/sources/powerbi/dax', h((req, res) => {                // shows the generated DAX (count) for transparency
  userOf(req); const rules = req.body.rules as Group;
  validateRules(rules, mappedFields(loadMapping()));
  res.json({ count: buildDax(rules, loadMapping(), 'count'), fetch: buildDax(rules, loadMapping(), 'fetch', { pageSize: config.pbi.pageSize }) });
}));

// ── Resolve a source: rows (Excel) or a Power BI query ──
function excelDataset(id?: string) {
  const ds = id ? store.getDataset(id) : undefined;
  if (!ds) throw Object.assign(new Error('Dataset not found (it may have expired). Upload the Excel again.'), { status: 404 });
  return ds;
}
function fieldsFor(source: string, datasetId?: string): FieldKey[] {
  return source === 'powerbi' ? mappedFields(loadMapping()) : excelDataset(datasetId).fieldsAvailable;
}

// ── Preview: counts and breakdowns only ──
app.post('/api/preview', h(async (req, res) => {
  userOf(req);
  const { source, datasetId, rules } = req.body as { source: 'excel' | 'powerbi'; datasetId?: string; rules: Group };
  validateRules(rules, fieldsFor(source, datasetId));
  if (source === 'powerbi') {
    if (!pbiConfigured()) return res.status(400).json({ error: 'Power BI is not configured yet. Use Excel upload for now.' });
    const [count, refreshed] = await Promise.all([pbiCount(rules), lastRefresh().catch(() => null)]);
    return res.json({ count, total: null, breakdowns: null, sample: [], freshness: freshness(refreshed ?? undefined) });
  }
  const ds = excelDataset(datasetId);
  const hit = ds.rows.filter(r => matches(r, rules));
  res.json({
    count: hit.length, total: ds.rows.length, breakdowns: breakdowns(hit),
    sample: hit.slice(0, 5).map(r => ({ customer_id: r.customer_id, email: r.email_masked, last_purchase_date: r.last_purchase_date ?? null })),
    freshness: freshness(ds.dataAsOf),
  });
}));

// ── Cohorts: draft → pending_approval → approved (snapshot locked) → pushed ──
const SEGMENT_RE = /^[A-Za-z0-9_-]{3,80}$/;
app.get('/api/cohorts', h((req, res) => { userOf(req); res.json(store.cohorts()); }));

app.post('/api/cohorts', h(async (req, res) => {
  const u = userOf(req); can(u, 'creator');
  const { name, segmentName, source, datasetId, rules } = req.body as Partial<Cohort>;
  if (!name || name.length > 120) return res.status(400).json({ error: 'Give the cohort a name' });
  if (!segmentName || !SEGMENT_RE.test(segmentName)) return res.status(400).json({ error: 'Segment name: 3–80 letters, numbers, _ or -' });
  if (store.cohorts().some(c => c.segmentName === segmentName)) return res.status(400).json({ error: 'That segment name is already used' });
  if (source !== 'excel' && source !== 'powerbi') return res.status(400).json({ error: 'Pick a data source' });
  validateRules(rules as Group, fieldsFor(source, datasetId));
  const ds = source === 'excel' ? excelDataset(datasetId) : undefined;
  const c: Cohort = {
    id: `c_${crypto.randomUUID().slice(0, 8)}`, name, segmentName, rules: rules as Group, rulesVersion: 1,
    source, datasetId: ds?.id, dataAsOf: ds?.dataAsOf, status: 'draft', createdBy: u.id, createdAt: now(),
    previewCount: ds ? ds.rows.filter(r => matches(r, rules as Group)).length : undefined,
    history: [{ at: now(), by: u.id, action: 'created' }],
  };
  store.saveCohort(c);
  res.json(c);
}));

const getCohort = (id: string) => {
  const c = store.getCohort(id);
  if (!c) throw Object.assign(new Error('Cohort not found'), { status: 404 });
  return c;
};

app.post('/api/cohorts/:id/submit', h((req, res) => {
  const u = userOf(req); can(u, 'creator');
  const c = getCohort(req.params.id);
  if (!['draft', 'rejected'].includes(c.status)) return res.status(409).json({ error: `Cannot submit a cohort that is ${c.status}` });
  c.status = 'pending_approval'; c.submittedAt = now(); c.history.push({ at: now(), by: u.id, action: 'submitted' });
  store.saveCohort(c); res.json(c);
}));

app.post('/api/cohorts/:id/reject', h((req, res) => {
  const u = userOf(req); can(u, 'approver');
  const c = getCohort(req.params.id);
  if (c.status !== 'pending_approval') return res.status(409).json({ error: 'Only cohorts waiting for approval can be rejected' });
  c.status = 'rejected'; c.rejectedReason = String(req.body.reason ?? '').slice(0, 300);
  c.history.push({ at: now(), by: u.id, action: 'rejected', note: c.rejectedReason });
  store.saveCohort(c); res.json(c);
}));

/** Approval locks the audience: rules are evaluated once and the result is frozen as the snapshot. */
app.post('/api/cohorts/:id/approve', h(async (req, res) => {
  const u = userOf(req); can(u, 'approver');
  const c = getCohort(req.params.id);
  if (c.status !== 'pending_approval') return res.status(409).json({ error: 'Only cohorts waiting for approval can be approved' });
  if (c.createdBy === u.id) return res.status(403).json({ error: 'The creator cannot approve their own cohort' });

  let audience: CustomerRow[]; let dataAsOf: string | undefined;
  if (c.source === 'excel') {
    const ds = excelDataset(c.datasetId);
    dataAsOf = ds.dataAsOf;
    audience = ds.rows.filter(r => matches(r, c.rules));
  } else {
    dataAsOf = (await lastRefresh().catch(() => null)) ?? undefined;
    const r = await pbiFetchProtected(c.rules);
    audience = r.rows;
    log(`powerbi fetch for ${c.id}: ${JSON.stringify(r.stats)}`);
  }
  const fr = freshness(dataAsOf);
  if (fr.level === 'blocked') return res.status(409).json({ error: `Data is ${fr.daysOld} days old (limit ${config.staleBlockDays}). Refresh / re-export it first.` });
  if (audience.length === 0) return res.status(409).json({ error: 'The audience is empty' });

  const snap: Snapshot = {
    cohortId: c.id, rulesVersion: c.rulesVersion, source: c.source, dataAsOf, createdAt: now(),
    audience: audience.map(({ customer_id, email_hash, email_enc }) => ({ customer_id, email_hash, email_enc })),
  };
  store.saveSnapshot(snap);
  Object.assign(c, { status: 'approved', approvedBy: u.id, approvedAt: now(), snapshotCount: snap.audience.length, dataAsOf });
  c.history.push({ at: now(), by: u.id, action: 'approved', note: `${snap.audience.length} customers locked` });
  store.saveCohort(c);
  log(`cohort ${c.id} approved: ${snap.audience.length} customers`);
  res.json(c);
}));

/** Push the locked snapshot. One run at a time per cohort; a failed run can be retried with the same snapshot. */
app.post('/api/cohorts/:id/push', h(async (req, res) => {
  const u = userOf(req); can(u, 'approver');
  const c = getCohort(req.params.id);
  if (c.status === 'pushing') return res.status(409).json({ error: 'A push for this cohort is already running' });
  if (!['approved', 'failed', 'pushed'].includes(c.status)) return res.status(409).json({ error: 'Approve the cohort first' });
  const snap = store.getSnapshot(c.id);
  if (!snap || snap.rulesVersion !== c.rulesVersion) return res.status(409).json({ error: 'No locked snapshot for this version' });

  const run: Run = {
    id: `run_${crypto.randomUUID().slice(0, 8)}`, cohortId: c.id, segmentName: c.segmentName,
    mode: ctConfigured() ? 'clevertap' : 'dry-run', startedBy: u.id, startedAt: now(), status: 'running', steps: [],
  };
  c.status = 'pushing'; store.saveCohort(c); store.saveRun(run);
  try {
    await pushToCleverTap(snap, run, u.id, () => store.saveRun(run));
    run.status = 'success'; c.status = 'pushed';
    c.history.push({ at: now(), by: u.id, action: run.mode === 'dry-run' ? 'dry run' : 'pushed to CleverTap', note: `${run.rowsSent} rows` });
  } catch (e) {
    run.status = 'failed'; run.error = (e as Error).message; c.status = 'failed';
    c.history.push({ at: now(), by: u.id, action: 'push failed', note: run.error });
  }
  run.finishedAt = now(); store.saveRun(run); store.saveCohort(c);
  log(`run ${run.id} (${run.mode}) ${run.status}: ${run.rowsSent ?? 0} rows`);
  res.json({ cohort: c, run });
}));

app.get('/api/runs', h((req, res) => { userOf(req); res.json(store.runs()); }));

// ── Errors ──
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof RuleError ? 400 : err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

store.purgeExpired();
setInterval(() => { const n = store.purgeExpired(); if (n) log(`retention: deleted ${n} expired datasets`); }, 3600_000).unref();

if (!keysReady()) console.warn('⚠  Encryption keys missing. Run: npm run keys');
app.listen(config.port, () => log(`API on http://localhost:${config.port}  | CleverTap: ${ctConfigured() ? config.ct.baseUrl : 'dry-run'} | Power BI: ${pbiConfigured() ? 'configured' : 'not configured'}`));
