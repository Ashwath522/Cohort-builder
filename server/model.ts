/** The ONE internal format every source must produce (Excel and Power BI alike). */
export interface CustomerRow {
  customer_id: string;     // key inside the data (joins order lines and filter buttons)
  fynd_user_id: string;    // the CleverTap identity: the only thing ever uploaded. No email or phone is read.
  registered_at?: string;  // YYYY-MM-DD
  first_purchase_date?: string;
  last_purchase_date?: string;
  lifetime_order_count?: number;
  lifetime_gmv?: number;
  last_channel?: string;
  city?: string;
  categories?: string[];
}

export type FieldKey =
  | 'registered_at' | 'first_purchase_date' | 'last_purchase_date'
  | 'lifetime_order_count' | 'lifetime_gmv' | 'last_channel' | 'city' | 'categories'
  | 'days_since_last_purchase' | 'aov' | 'customer_type';          // derived from the fields above

/** Business rules applied after filtering, at approval: who actually gets the message. */
export type SortKey = 'last_purchase_date' | 'first_purchase_date' | 'registered_at' | 'lifetime_gmv' | 'lifetime_order_count' | 'aov' | 'days_since_last_purchase';
export interface Delivery {
  sortBy: SortKey;
  dir: 'asc' | 'desc';
  limit?: number;          // tag only the top N after sorting (Excel source)
  holdoutPct: number;      // 0–50: random control group kept aside to measure lift
  suppressDays: number;    // 0 = off; skip people tagged in another segment in the last N days
  seed?: string;           // picks the control group; fixed when the audience is first built, so preview = approval
}

/** Built-in filter, or a developer-defined ("custom") filter button. */
export interface Condition {
  field: FieldKey | 'custom';
  op: string;                       // custom: 'include' | 'exclude'
  value?: unknown;
  filterId?: string;                // custom only
  version?: number;                 // custom only: the published version the cohort was built with
  params?: Record<string, unknown>; // custom only
}

export interface OrderLine { customer_id: string; order_date?: string; category?: string; amount?: number }

export type ParamType = 'number' | 'date' | 'text' | 'category' | 'channel' | 'city';
export interface FilterParam { name: string; label: string; type: ParamType }
export interface FilterDefinition {
  label: string;           // the button marketing sees, e.g. "Not bought"
  description: string;
  params: FilterParam[];
  sql: string;             // runs on uploaded data (tables: customers, customer_categories, order_lines); returns customer_id
  dax?: string;            // optional: DAX table expression of customer IDs, for the Power BI source
}
export interface CustomFilter {
  id: string;
  draft: FilterDefinition;
  versions: Array<FilterDefinition & { version: number; publishedBy: string; publishedAt: string }>;
  status: 'draft' | 'published' | 'archived';
  createdBy: string; createdAt: string; updatedAt: string;
}
export interface Group { logic: 'AND' | 'OR'; conditions: Array<Condition | Group> }
export const isGroup = (c: Condition | Group): c is Group => (c as Group).logic !== undefined;

export interface ValidationReport {
  totalRows: number;
  validRows: number;
  columnsFound: Record<string, string>;     // internal field -> Excel header
  ignoredColumns: string[];
  errors: string[];                          // file-level problems (reject)
  warnings: string[];
  rowIssues: { missingId: number; duplicateId: number; badDate: number; badNumber: number };
  orderLines?: { sheet: string; rows: number; skipped: number };
}

export interface Dataset {
  id: string;
  source: 'excel' | 'powerbi';
  fileName?: string;
  uploadedBy: string;
  uploadedAt: string;
  dataAsOf: string;                          // when the data was exported / refreshed
  expiresAt: string;
  fieldsAvailable: FieldKey[];
  choices: { last_channel: string[]; city: string[]; categories: string[] };
  report: ValidationReport;
  rows: CustomerRow[];
  orderLines?: OrderLine[];
}

export type CohortStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'tagging' | 'tagged' | 'failed';

export interface Cohort {
  id: string;
  name: string;
  segmentName: string;
  rules: Group;
  rulesVersion: number;
  source: 'excel' | 'powerbi';
  datasetId?: string;
  dataAsOf?: string;
  status: CohortStatus;
  createdBy: string;
  createdAt: string;
  previewCount?: number;
  submittedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedReason?: string;
  snapshotCount?: number;   // locked audience size (people who will be tagged)
  holdoutCount?: number;    // control group kept aside
  delivery?: Delivery;
  funnel?: Array<{ step: string; count: number; aside?: boolean }>;
  history: Array<{ at: string; by: string; action: string; note?: string }>;
}

export interface Snapshot {
  cohortId: string;
  rulesVersion: number;
  source: string;
  dataAsOf?: string;
  createdAt: string;
  audience: Array<Pick<CustomerRow, 'customer_id' | 'fynd_user_id'>>;
  holdout?: Array<Pick<CustomerRow, 'customer_id' | 'fynd_user_id'>>;  // not tagged; for measuring lift
  taggedAt?: string;
  idsPurged?: boolean;      // ID lists removed after LOG_RETENTION_DAYS
}

export interface Run {
  id: string;
  cohortId: string;
  segmentName: string;
  mode: 'clevertap' | 'dry-run';
  startedBy: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'success' | 'failed';
  rowsTagged?: number;
  csvBytes?: number;
  csvSha256?: string;
  steps: Array<{ at: string; step: string; ok: boolean; detail?: string }>;
  error?: string;
  failedStep?: string;      // which step stopped the run
  attempt: number;          // 1 = first try, 2+ = retries of the same locked audience
}
