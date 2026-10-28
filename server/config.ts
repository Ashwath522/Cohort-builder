import 'dotenv/config';
import path from 'node:path';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

export const config = {
  port: Number(env('PORT', '4000')),
  dataDir: path.resolve(env('DATA_DIR', './data')),
  retentionDays: Number(env('RETENTION_DAYS', '7')),
  // Segment log (who created/approved, when tagged, the Fynd user IDs added). Never less than 90 days.
  logRetentionDays: Math.max(90, Number(env('LOG_RETENTION_DAYS', '90')) || 90),
  dateOrder: env('DATE_ORDER', 'DMY') as 'DMY' | 'MDY',
  staleWarnDays: Number(env('STALE_WARN_DAYS', '3')),
  staleBlockDays: Number(env('STALE_BLOCK_DAYS', '14')),
  ct: {
    accountId: env('CT_ACCOUNT_ID'),
    passcode: env('CT_PASSCODE'),
    baseUrl: env('CT_BASE_URL') || `https://${env('CT_REGION', 'in1')}.api.clevertap.com`,
    adminEmail: env('CT_ADMIN_EMAIL', 'crm-admin@example.com'),
  },
  pbi: {
    tenantId: env('PBI_TENANT_ID'),
    clientId: env('PBI_CLIENT_ID'),
    clientSecret: env('PBI_CLIENT_SECRET'),
    workspaceId: env('PBI_WORKSPACE_ID'),
    datasetId: env('PBI_DATASET_ID'),
    loginBase: env('PBI_LOGIN_BASE', 'https://login.microsoftonline.com'),
    apiBase: env('PBI_API_BASE', 'https://api.powerbi.com'),
    pageSize: Number(env('PBI_PAGE_SIZE', '100000')),
  },
};

export const ctConfigured = () => Boolean(config.ct.accountId && config.ct.passcode);
export const pbiConfigured = () =>
  Boolean(config.pbi.tenantId && config.pbi.clientId && config.pbi.clientSecret && config.pbi.workspaceId && config.pbi.datasetId);
