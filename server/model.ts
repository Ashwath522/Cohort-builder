/** The ONE internal format every source must produce (Excel and Power BI alike). */
export interface CustomerRow {
  customer_id: string;
  email_hash: string;      // HMAC-SHA256 of the normalised email (one-way, keyed)
  email_enc: string;       // AES-256-GCM ciphertext, base64 (reversible only with ENC_KEY)
  email_masked: string;    // r***@gmail.com, safe to show
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
  | 'lifetime_order_count' | 'lifetime_gmv' | 'last_channel' | 'city' | 'categories';

export interface Condition { field: FieldKey; op: string; value?: unknown }
export interface Group { logic: 'AND' | 'OR'; conditions: Array<Condition | Group> }
export const isGroup = (c: Condition | Group): c is Group => (c as Group).logic !== undefined;

export interface ValidationReport {
  totalRows: number;
  validRows: number;
  columnsFound: Record<string, string>;     // internal field -> Excel header
  ignoredColumns: string[];
  errors: string[];                          // file-level problems (reject)
  warnings: string[];
  rowIssues: { missingId: number; invalidEmail: number; internalDomain: number; duplicateEmail: number; badDate: number; badNumber: number };
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
}

export type CohortStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'pushing' | 'pushed' | 'failed';

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
  snapshotCount?: number;   // locked audience size
  history: Array<{ at: string; by: string; action: string; note?: string }>;
}

export interface Snapshot {
  cohortId: string;
  rulesVersion: number;
  source: string;
  dataAsOf?: string;
  createdAt: string;
  audience: Array<Pick<CustomerRow, 'customer_id' | 'email_hash' | 'email_enc'>>;
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
  rowsSent?: number;
  csvBytes?: number;
  csvSha256?: string;
  steps: Array<{ at: string; step: string; ok: boolean; detail?: string }>;
  error?: string;
}
