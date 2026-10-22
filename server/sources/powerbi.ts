import { config, pbiConfigured } from '../config.js';
import { encrypt, hashEmail, isValidEmail, maskEmail, normaliseEmail } from '../crypto.js';
import type { CustomerRow, Group } from '../model.js';
import { buildDax, loadMapping } from './dax.js';

let token: { value: string; expires: number } | null = null;

/** Requirements shown in the UI until Power BI is configured. */
export const PBI_REQUIREMENTS = [
  { item: 'Power BI admin enables the tenant setting "Dataset Execute Queries REST API" (Integration settings)', env: null },
  { item: 'Power BI admin enables "Allow service principals to use Power BI APIs" (or we use a dedicated PPU-licensed service user)', env: null },
  { item: 'App registration in Microsoft Entra ID with a client secret; Directory (tenant) ID', env: 'PBI_TENANT_ID' },
  { item: 'Application (client) ID of that app registration', env: 'PBI_CLIENT_ID' },
  { item: 'Client secret value', env: 'PBI_CLIENT_SECRET' },
  { item: 'App added to the workspace (Member or Contributor) and given Build permission on the semantic model', env: null },
  { item: 'Workspace ID (from the report URL: app.powerbi.com/groups/<workspaceId>/...)', env: 'PBI_WORKSPACE_ID' },
  { item: 'Semantic model (dataset) ID (open the model in the workspace: .../datasets/<datasetId>/...)', env: 'PBI_DATASET_ID' },
  { item: 'Table, column and measure names from the Data pane → config/powerbi-mapping.json', env: null },
  { item: 'Confirm whether the model uses row-level security (service principals are not supported on RLS models)', env: null },
];

async function getToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const p = config.pbi;
  const res = await fetch(`${p.loginBase}/${encodeURIComponent(p.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: p.clientId, client_secret: p.clientSecret,
      scope: 'https://analysis.windows.net/powerbi/api/.default',
    }),
  });
  if (!res.ok) throw new Error(`Microsoft sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = await res.json() as { access_token: string; expires_in: number };
  token = { value: j.access_token, expires: Date.now() + j.expires_in * 1000 };
  return token.value;
}

const dsUrl = () => `${config.pbi.apiBase}/v1.0/myorg/groups/${config.pbi.workspaceId}/datasets/${config.pbi.datasetId}`;

export async function executeQuery(dax: string): Promise<Array<Record<string, unknown>>> {
  if (!pbiConfigured()) throw new Error('Power BI is not configured');
  const res = await fetch(`${dsUrl()}/executeQueries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [{ query: dax }], serializerSettings: { includeNulls: true } }),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? ' — check the "Dataset Execute Queries REST API" tenant setting, workspace access and Build permission'
      : res.status === 404 ? ' — check PBI_WORKSPACE_ID / PBI_DATASET_ID' : res.status === 429 ? ' — rate limit (120 queries/min)' : '';
    throw new Error(`Power BI ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text).results?.[0]?.tables?.[0]?.rows ?? []) as Array<Record<string, unknown>>;
}

export async function testConnection() {
  const rows = await executeQuery('EVALUATE ROW("connected", 1)');
  return { connected: rows[0]?.['[connected]'] === 1, lastRefresh: await lastRefresh().catch(() => null) };
}

/** Data freshness = end time of the latest successful refresh. */
export async function lastRefresh(): Promise<string | null> {
  const res = await fetch(`${dsUrl()}/refreshes?$top=5`, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (!res.ok) return null;
  const j = await res.json() as { value?: Array<{ status: string; endTime?: string }> };
  return j.value?.find(r => r.status === 'Completed')?.endTime ?? null;
}

export async function pbiCount(rules: Group): Promise<number> {
  const rows = await executeQuery(buildDax(rules, loadMapping(), 'count'));
  return Number(rows[0]?.['[Audience]'] ?? 0);
}

/** Paged fetch of Customer ID + Email; each email is protected the moment it arrives. */
export async function pbiFetchProtected(rules: Group) {
  const m = loadMapping();
  const pageSize = config.pbi.pageSize;
  const out: CustomerRow[] = [];
  const seen = new Set<string>();
  const stats = { received: 0, invalidEmail: 0, internalDomain: 0, duplicateEmail: 0, pages: 0 };
  let after: string | number | undefined;
  for (;;) {
    const rows = await executeQuery(buildDax(rules, m, 'fetch', { afterId: after, pageSize }));
    stats.pages++;
    for (const r of rows) {
      stats.received++;
      const email = normaliseEmail(r['[email]']);
      if (!isValidEmail(email)) { stats.invalidEmail++; continue; }
      if (config.excludeDomains.includes(email.split('@')[1])) { stats.internalDomain++; continue; }
      const h = hashEmail(email);
      if (seen.has(h)) { stats.duplicateEmail++; continue; }
      seen.add(h);
      out.push({ customer_id: String(r['[customer_id]']), email_hash: h, email_enc: encrypt(email), email_masked: maskEmail(email) });
    }
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1]['[customer_id]'] as string | number;
    if (stats.pages > 200) throw new Error('Too many pages; stopping for safety');
  }
  return { rows: out, stats };
}
