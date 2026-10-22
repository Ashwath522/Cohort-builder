export type FieldKey = 'registered_at' | 'first_purchase_date' | 'last_purchase_date' | 'lifetime_order_count' | 'lifetime_gmv' | 'last_channel' | 'city' | 'categories';
export type FieldType = 'date' | 'number' | 'choice' | 'categories';
export interface Condition { field: FieldKey; op: string; value?: unknown }
export interface Group { logic: 'AND' | 'OR'; conditions: Array<Condition | Group> }
export const isGroup = (c: Condition | Group): c is Group => (c as Group).logic !== undefined;

export interface Catalog { fields: Record<FieldKey, { label: string; type: FieldType }>; ops: Record<FieldType, Record<string, string>> }
export interface Freshness { dataAsOf: string | null; daysOld: number | null; level: 'ok' | 'warn' | 'blocked' }
export interface DatasetMeta {
  id: string; fileName?: string; uploadedBy: string; uploadedAt: string; dataAsOf: string; expiresAt: string;
  fieldsAvailable: FieldKey[]; choices: { last_channel: string[]; city: string[]; categories: string[] };
  report: { totalRows: number; validRows: number; columnsFound: Record<string, string>; ignoredColumns: string[]; warnings: string[]; errors: string[] };
  freshness?: Freshness;
}
export interface Cohort {
  id: string; name: string; segmentName: string; rules: Group; rulesVersion: number; source: 'excel' | 'powerbi';
  datasetId?: string; dataAsOf?: string; status: string; createdBy: string; createdAt: string; previewCount?: number;
  approvedBy?: string; approvedAt?: string; rejectedReason?: string; snapshotCount?: number;
  history: Array<{ at: string; by: string; action: string; note?: string }>;
}
export interface Run {
  id: string; cohortId: string; segmentName: string; mode: string; startedBy: string; startedAt: string; finishedAt?: string;
  status: string; rowsSent?: number; csvBytes?: number; csvSha256?: string; error?: string;
  steps: Array<{ at: string; step: string; ok: boolean; detail?: string }>;
}

let currentUser = 'priya';
export const setUser = (u: string) => { currentUser = u; };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-User': currentUser };
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error ?? `Request failed (${res.status})`), { data: json });
  return json as T;
}
export const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
