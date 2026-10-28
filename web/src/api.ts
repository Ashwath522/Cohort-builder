export type FieldKey = 'registered_at' | 'first_purchase_date' | 'last_purchase_date' | 'lifetime_order_count' | 'lifetime_gmv' | 'last_channel' | 'city' | 'categories' | 'days_since_last_purchase' | 'aov' | 'customer_type';
export type SortKey = 'last_purchase_date' | 'first_purchase_date' | 'registered_at' | 'lifetime_gmv' | 'lifetime_order_count' | 'aov' | 'days_since_last_purchase';
export interface Delivery { sortBy: SortKey; dir: 'asc' | 'desc'; limit?: number; holdoutPct: number; suppressDays: number; seed?: string }
export type FieldType = 'date' | 'number' | 'choice' | 'categories';
export interface Condition { field: FieldKey | 'custom'; op: string; value?: unknown; filterId?: string; version?: number; params?: Record<string, unknown> }
export type ParamType = 'number' | 'date' | 'text' | 'category' | 'channel' | 'city';
export interface FilterParam { name: string; label: string; type: ParamType }
/** A developer-made filter button, as marketing sees it (no query text). */
export interface FilterButton { id: string; status: string; latestVersion: number | null; label: string; description: string; params: FilterParam[]; worksOn: { excel: boolean; powerbi: boolean }; needsOrderLines: boolean }
export interface FilterDefinition { label: string; description: string; params: FilterParam[]; sql: string; dax?: string }
export interface CustomFilter { id: string; draft: FilterDefinition; versions: Array<FilterDefinition & { version: number; publishedBy: string; publishedAt: string }>; status: 'draft' | 'published' | 'archived'; createdBy: string; updatedAt: string }
export interface Group { logic: 'AND' | 'OR'; conditions: Array<Condition | Group> }
export const isGroup = (c: Condition | Group): c is Group => (c as Group).logic !== undefined;

export interface Catalog { fields: Record<FieldKey, { label: string; type: FieldType }>; ops: Record<FieldType, Record<string, string>>; sorts: Record<SortKey, string>; customerTypes: string[] }
export interface Freshness { dataAsOf: string | null; daysOld: number | null; level: 'ok' | 'warn' | 'blocked' }
export interface DatasetMeta {
  id: string; fileName?: string; uploadedBy: string; uploadedAt: string; dataAsOf: string; expiresAt: string;
  hasOrderLines?: boolean; fieldsAvailable: FieldKey[]; choices: { last_channel: string[]; city: string[]; categories: string[] };
  report: { totalRows: number; validRows: number; columnsFound: Record<string, string>; ignoredColumns: string[]; warnings: string[]; errors: string[] };
  freshness?: Freshness;
}
export interface Cohort {
  id: string; name: string; segmentName: string; rules: Group; rulesVersion: number; source: 'excel' | 'powerbi';
  datasetId?: string; dataAsOf?: string; status: string; createdBy: string; createdAt: string; previewCount?: number;
  approvedBy?: string; approvedAt?: string; rejectedReason?: string; snapshotCount?: number; holdoutCount?: number;
  delivery?: Delivery; funnel?: Array<{ step: string; count: number; aside?: boolean }>;
  history: Array<{ at: string; by: string; action: string; note?: string }>;
}
export interface Run {
  id: string; cohortId: string; segmentName: string; mode: string; startedBy: string; startedAt: string; finishedAt?: string;
  status: string; rowsTagged?: number; csvBytes?: number; csvSha256?: string; error?: string; failedStep?: string; attempt: number;
  steps: Array<{ at: string; step: string; ok: boolean; detail?: string }>;
}

let currentUser = location.pathname.startsWith('/developer') ? 'dev' : 'priya';
export const setUser = (u: string) => { currentUser = u; };
export const currentUserId = () => currentUser;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-User': currentUser };
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `Request failed (${res.status})`), { data: json });
  return json as T;
}
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
