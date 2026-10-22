import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ctConfigured, pbiConfigured } from './config.js';
import { keysReady } from './crypto.js';
import { analytics, withDerived, CATALOG, CUSTOMER_TYPES, customConditions, fieldValue, matches, OPS, RuleError, validateRules, type CustomSets, type RuleEnv } from './filter.js';
import { applyDelivery, cleanDelivery, SORTS, sortRows } from './delivery.js';
import type { Cohort, CustomFilter, CustomerRow, Dataset, Delivery, FilterDefinition, Group, Run, SortKey, Snapshot } from './model.js';
import { store } from './store.js';
import { ingestExcel } from './sources/excel.js';
import { loadMapping, mappedFields, buildDax } from './sources/dax.js';
import { PBI_REQUIREMENTS, lastRefresh, pbiCount, pbiFetchProtected, testConnection } from './sources/powerbi.js';
import { pushToCleverTap } from './clevertap.js';
import { checkDefinition, filters, forgetDataset, PARAM_TYPES, placeholders, renderDax, runSql, SCHEMA, seedExamples, validateCustomCondition } from './customFilters.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024, files: 1 } });

// ── Demo users. Replace with company SSO (Entra ID / Google) before real use. ──
const USERS = [
  { id: 'priya', name: 'Priya (Marketing)', role: 'creator' },
  { id: 'rahul', name: 'Rahul (Approver)', role: 'approver' },
  { id: 'dev', name: 'Dev (Analytics)', role: 'developer' },
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
const freshness = (iso?: string) => {
  if (!iso) return { dataAsOf: null, daysOld: null, level: 'warn' };      // unknown age: warn, don't block
  const d = (Date.now() - Date.parse(iso)) / 864e5;
  return { dataAsOf: iso, daysOld: Math.floor(d), level: d > config.staleBlockDays ? 'blocked' : d > config.staleWarnDays ? 'warn' : 'ok' };
};
const log = (msg: string) => console.log(`[${now()}] ${msg}`);   // counts only, never emails

// ── Health / setup ──
app.get('/api/health', (_req, res) => res.json({
  keysReady: keysReady(), clevertap: ctConfigured() ? 'live' : 'dry-run', ctBaseUrl: config.ct.baseUrl,
  powerbi: pbiConfigured() ? 'configured' : 'not-configured', users: USERS,
}));
app.get('/api/catalog', (_req, res) => res.json({ fields: CATALOG, ops: OPS, sorts: SORTS, customerTypes: CUSTOMER_TYPES }));

// ── Data sources ──
app.post('/api/sources/excel', upload.single('file'), h(async (req, res) => {
  const u = userOf(req); can(u, 'creator', 'developer');
  if (!req.file) return res.status(400).json({ error: 'Attach an .xlsx or .csv file' });
  const dataAsOf = String(req.body.dataAsOf ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataAsOf)) return res.status(400).json({ error: 'Enter the date the Excel was exported' });
  if (dataAsOf > now().slice(0, 10)) return res.status(400).json({ error: 'Export date cannot be in the future' });
  try {
    const ds = await ingestExcel(req.file.buffer, req.file.originalname, u.id, dataAsOf);
    req.file.buffer.fill(0);                                     // wipe the original upload from memory
    store.saveDataset(ds);
    log(`excel dataset ${ds.id}: ${ds.report.validRows}/${ds.report.totalRows} rows valid, ${ds.orderLines?.length ?? 0} order lines`);
    const { rows, orderLines, ...meta } = ds;
    res.json({ dataset: meta, freshness: freshness(dataAsOf) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message, report: (e as { report?: unknown }).report });
  }
}));
app.get('/api/sources/excel', h((req, res) => {
  userOf(req);
  res.json(store.listDatasets().map(d => ({ ...d, fieldsAvailable: withDerived(d.fieldsAvailable), freshness: freshness(d.dataAsOf) })));
}));
app.delete('/api/sources/excel/:id', h((req, res) => { can(userOf(req), 'creator', 'developer'); store.deleteDataset(req.params.id); forgetDataset(req.params.id); res.json({ ok: true }); }));

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

// ── Source helpers ──
function excelDataset(id?: string): Dataset {
  const ds = id ? store.getDataset(id) : undefined;
  if (!ds) throw Object.assign(new Error('Dataset not found (it may have expired). Upload the Excel again.'), { status: 404 });
  ds.fieldsAvailable = withDerived(ds.fieldsAvailable);          // datasets uploaded before derived fields existed
  return ds;
}
function envFor(source: 'excel' | 'powerbi', ds?: Dataset): RuleEnv {
  return {
    fieldsAvailable: source === 'powerbi' ? mappedFields(loadMapping()) : ds!.fieldsAvailable,
    validateCustom: c => validateCustomCondition(c, source, ds),
  };
}
/** Runs every custom filter in the rules against the uploaded data, once. */
async function resolveCustom(rules: Group, ds: Dataset): Promise<CustomSets> {
  const sets: CustomSets = new Map();
  for (const c of customConditions(rules)) sets.set(c, (await runSql(ds, filters.version(c.filterId!, c.version)!, c.params ?? {})).ids);
  return sets;
}
async function evaluateExcel(rules: Group, ds: Dataset): Promise<CustomerRow[]> {
  const sets = await resolveCustom(rules, ds);
  return ds.rows.filter(r => matches(r, rules, { sets, asOf: ds.dataAsOf }));
}
function prepare(body: { source: 'excel' | 'powerbi'; datasetId?: string; rules: Group }) {
  if (body.source !== 'excel' && body.source !== 'powerbi') throw new RuleError('Pick a data source');
  const ds = body.source === 'excel' ? excelDataset(body.datasetId) : undefined;
  validateRules(body.rules, envFor(body.source, ds));
  return ds;
}

app.post('/api/sources/powerbi/dax', h((req, res) => {          // the DAX the filters would send, for transparency
  userOf(req);
  const rules = req.body.rules as Group;
  validateRules(rules, envFor('powerbi'));
  res.json({ count: buildDax(rules, loadMapping(), 'count'), fetch: buildDax(rules, loadMapping(), 'fetch', { pageSize: config.pbi.pageSize }) });
}));

// ── Preview: KPIs, charts and the delivery funnel. Counts only, no identities. ──
app.post('/api/preview', h(async (req, res) => {
  userOf(req);
  const ds = prepare(req.body);
  const { source, rules } = req.body as { source: 'excel' | 'powerbi'; rules: Group };
  const delivery = cleanDelivery(req.body.delivery, source);
  if (source === 'powerbi') {
    if (!pbiConfigured()) return res.status(400).json({ error: 'Power BI is not configured yet. Use Excel upload for now.' });
    const [count, refreshed] = await Promise.all([pbiCount(rules), lastRefresh().catch(() => null)]);
    return res.json({ count, total: null, analytics: null, funnel: null, freshness: freshness(refreshed ?? undefined) });
  }
  const hit = await evaluateExcel(rules, ds!);
  const { funnel } = applyDelivery(hit, delivery, ds!.dataAsOf, String(req.body.segmentName ?? ''));
  res.json({ count: hit.length, total: ds!.rows.length, analytics: analytics(hit, ds!.rows.length, ds!.dataAsOf), funnel, freshness: freshness(ds!.dataAsOf) });
}));

/** The matching customers as a sortable, paged table. Emails are masked. */
app.post('/api/preview/rows', h(async (req, res) => {
  userOf(req);
  const ds = prepare(req.body);
  if (!ds) return res.status(400).json({ error: 'The customer table is available for Excel data; Power BI preview shows counts only.' });
  const sortBy = (req.body.sortBy in SORTS ? req.body.sortBy : 'lifetime_gmv') as SortKey;
  const dir = req.body.dir === 'asc' ? 'asc' : 'desc';
  const pageSize = Math.min(Math.max(Number(req.body.pageSize) || 25, 5), 100);
  const sorted = sortRows(await evaluateExcel(req.body.rules, ds), sortBy, dir, ds.dataAsOf);
  const page = Math.min(Math.max(Number(req.body.page) || 1, 1), Math.max(1, Math.ceil(sorted.length / pageSize)));
  res.json({
    total: sorted.length, page, pageSize, sortBy, dir,
    rows: sorted.slice((page - 1) * pageSize, page * pageSize).map(r => ({
      customer_id: r.customer_id, email: r.email_masked, city: r.city ?? null, last_channel: r.last_channel ?? null,
      registered_at: r.registered_at ?? null, first_purchase_date: r.first_purchase_date ?? null, last_purchase_date: r.last_purchase_date ?? null,
      days_since_last_purchase: fieldValue(r, 'days_since_last_purchase', ds.dataAsOf) ?? null,
      lifetime_order_count: r.lifetime_order_count ?? null, lifetime_gmv: r.lifetime_gmv ?? null,
      aov: fieldValue(r, 'aov', ds.dataAsOf) ?? null, categories: r.categories ?? [],
    })),
  });
}));

// ── Developer: filter buttons (SQL / DAX) ──
const publicFilter = (f: CustomFilter) => {
  const latest = f.versions.at(-1);
  return { id: f.id, status: f.status, latestVersion: latest?.version ?? null, label: latest?.label ?? f.draft.label,
    description: latest?.description ?? f.draft.description, params: latest?.params ?? [],
    worksOn: { excel: true, powerbi: Boolean(latest?.dax?.trim()) }, needsOrderLines: /\border_lines\b/i.test(latest?.sql ?? '') };
};
// Marketing: published buttons only, no query text.
app.get('/api/filters', h((req, res) => { userOf(req); res.json(filters.all().filter(f => f.status === 'published').map(publicFilter)); }));

// Developer: full definitions.
app.get('/api/dev/filters', h((req, res) => { can(userOf(req), 'developer'); res.json({ filters: filters.all(), schema: SCHEMA, paramTypes: PARAM_TYPES }); }));

const readDef = (b: Partial<FilterDefinition>): FilterDefinition => ({
  label: String(b.label ?? '').trim(), description: String(b.description ?? '').trim().slice(0, 300),
  params: (Array.isArray(b.params) ? b.params : []).map(p => ({ name: String(p.name ?? '').trim(), label: String(p.label ?? '').trim(), type: p.type })),
  sql: String(b.sql ?? ''), dax: String(b.dax ?? ''),
});

app.post('/api/dev/filters', h((req, res) => {
  const u = userOf(req); can(u, 'developer');
  const def = readDef(req.body);
  const errs = checkDefinition(def);
  if (errs.length) return res.status(400).json({ error: errs.join('; '), errors: errs });
  const f: CustomFilter = { id: `f_${crypto.randomUUID().slice(0, 8)}`, draft: def, versions: [], status: 'draft', createdBy: u.id, createdAt: now(), updatedAt: now() };
  filters.save(f); res.json(f);
}));
app.put('/api/dev/filters/:id', h((req, res) => {
  can(userOf(req), 'developer');
  const f = filters.get(req.params.id); if (!f) return res.status(404).json({ error: 'Not found' });
  const def = readDef(req.body);
  const errs = checkDefinition(def);
  if (errs.length) return res.status(400).json({ error: errs.join('; '), errors: errs });
  f.draft = def; f.updatedAt = now(); filters.save(f); res.json(f);
}));
/** Test a draft on an uploaded dataset: count, sample (masked), time taken. Also shows the rendered DAX. */
app.post('/api/dev/filters/test', h(async (req, res) => {
  can(userOf(req), 'developer');
  const def = readDef(req.body.definition ?? {});
  const errs = checkDefinition(def);
  if (errs.length) return res.status(400).json({ error: errs.join('; '), errors: errs });
  const ds = excelDataset(req.body.datasetId);
  const { ids, ms } = await runSql(ds, def, req.body.params ?? {});
  const hit = ds.rows.filter(r => ids.has(r.customer_id));
  res.json({
    count: hit.length, total: ds.rows.length, ms, unknownIds: ids.size - hit.length,
    sample: hit.slice(0, 5).map(r => ({ customer_id: r.customer_id, email: r.email_masked, last_purchase_date: r.last_purchase_date ?? null })),
    dax: def.dax?.trim() ? renderDax(def, req.body.params ?? {}) : null, placeholders: placeholders(def.sql),
  });
}));
app.post('/api/dev/filters/:id/publish', h((req, res) => {
  const u = userOf(req); can(u, 'developer');
  const f = filters.get(req.params.id); if (!f) return res.status(404).json({ error: 'Not found' });
  const errs = checkDefinition(f.draft);
  if (errs.length) return res.status(400).json({ error: errs.join('; ') });
  const version = (f.versions.at(-1)?.version ?? 0) + 1;
  f.versions.push({ ...f.draft, version, publishedBy: u.id, publishedAt: now() });
  f.status = 'published'; f.updatedAt = now(); filters.save(f);
  log(`filter ${f.id} "${f.draft.label}" published v${version} by ${u.id}`);
  res.json(f);
}));
app.post('/api/dev/filters/:id/archive', h((req, res) => {
  can(userOf(req), 'developer');
  const f = filters.get(req.params.id); if (!f) return res.status(404).json({ error: 'Not found' });
  f.status = f.status === 'archived' ? (f.versions.length ? 'published' : 'draft') : 'archived'; f.updatedAt = now(); filters.save(f); res.json(f);
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
  const ds = prepare({ source: source as 'excel' | 'powerbi', datasetId, rules: rules as Group });
  const delivery: Delivery = cleanDelivery(req.body.delivery, source as 'excel' | 'powerbi');
  const c: Cohort = {
    id: `c_${crypto.randomUUID().slice(0, 8)}`, name, segmentName, rules: rules as Group, rulesVersion: 1,
    source: source as 'excel' | 'powerbi', datasetId: ds?.id, dataAsOf: ds?.dataAsOf, status: 'draft', createdBy: u.id, createdAt: now(),
    previewCount: ds ? (await evaluateExcel(rules as Group, ds)).length : undefined, delivery,
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
  c.status = 'pending_approval'; c.history.push({ at: now(), by: u.id, action: 'submitted' });
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
    validateRules(c.rules, envFor('excel', ds));
    dataAsOf = ds.dataAsOf;
    audience = await evaluateExcel(c.rules, ds);
  } else {
    validateRules(c.rules, envFor('powerbi'));
    dataAsOf = (await lastRefresh().catch(() => null)) ?? undefined;
    const r = await pbiFetchProtected(c.rules);
    audience = r.rows;
    log(`powerbi fetch for ${c.id}: ${JSON.stringify(r.stats)}`);
  }
  const fr = freshness(dataAsOf);
  if (fr.level === 'blocked') return res.status(409).json({ error: `Data is ${fr.daysOld} days old (limit ${config.staleBlockDays}). Refresh / re-export it first.` });
  const delivery = cleanDelivery(c.delivery, c.source);
  const { send, holdout, funnel } = applyDelivery(audience, delivery, (dataAsOf ?? now()).slice(0, 10), c.segmentName, c.id);
  if (send.length === 0) return res.status(409).json({ error: 'Nobody left to send to after the delivery rules' });

  const snap: Snapshot = {
    cohortId: c.id, rulesVersion: c.rulesVersion, source: c.source, dataAsOf, createdAt: now(),
    audience: send.map(({ customer_id, email_hash, email_enc }) => ({ customer_id, email_hash, email_enc })),
    holdout: holdout.map(({ customer_id, email_hash }) => ({ customer_id, email_hash })),
  };
  store.saveSnapshot(snap);
  Object.assign(c, { status: 'approved', approvedBy: u.id, approvedAt: now(), snapshotCount: send.length, holdoutCount: holdout.length, funnel, dataAsOf });
  c.history.push({ at: now(), by: u.id, action: 'approved', note: `${send.length} to send${holdout.length ? `, ${holdout.length} in control group` : ''} locked` });
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
    if (run.mode === 'clevertap') { snap.pushedAt = now(); store.saveSnapshot(snap); }   // feeds "not messaged in the last N days"
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

// ── Built web app (npm start). /developer and / both load the same page; the page picks the window. ──
const dist = path.resolve('dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// ── Errors ──
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof RuleError ? 400 : err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message });
});

store.purgeExpired();
seedExamples();
setInterval(() => { const n = store.purgeExpired(); if (n) log(`retention: deleted ${n} expired datasets`); }, 3600_000).unref();

if (!keysReady()) console.warn('⚠  Encryption keys missing. Run: npm run keys');
app.listen(config.port, () => log(`API on http://localhost:${config.port}  | CleverTap: ${ctConfigured() ? config.ct.baseUrl : 'dry-run'} | Power BI: ${pbiConfigured() ? 'configured' : 'not configured'}`));
