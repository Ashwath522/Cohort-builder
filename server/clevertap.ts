import crypto from 'node:crypto';
import { config, ctConfigured } from './config.js';
import { decrypt } from './crypto.js';
import type { Run, Snapshot } from './model.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Builds the CSV in memory only. Emails are decrypted here and nowhere else. */
function buildCsv(s: Snapshot): Buffer {
  const lines = ['identity'];
  for (const a of s.audience) {
    const e = decrypt(a.email_enc);
    lines.push(/[",\n]/.test(e) ? `"${e.replace(/"/g, '""')}"` : e);
  }
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

async function ctPost(path: string, body?: unknown) {
  const res = await fetch(`${config.ct.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'X-CleverTap-Account-Id': config.ct.accountId, 'X-CleverTap-Passcode': config.ct.passcode,
      'Content-Type': 'application/json', 'Cache-Control': 'no-cache',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

/** Retries rate limits and "another upload is still processing". */
async function withRetry<T extends { status: number; json: Record<string, unknown> }>(fn: () => Promise<T>, log: (s: string) => void) {
  for (let attempt = 1; ; attempt++) {
    const r = await fn();
    const err = String(r.json.error ?? r.json.code ?? '');
    const retryable = r.status === 429 || /segment_in_progress|rate_limit/i.test(err);
    if (!retryable || attempt >= 4) return r;
    const wait = 2000 * 2 ** (attempt - 1);
    log(`retryable (${r.status} ${err}); waiting ${wait / 1000}s`);
    await sleep(wait);
  }
}

/**
 * CleverTap Custom List API, 3 steps:
 *  1. POST /get_custom_list_segment_url        → pre-signed upload URL (24h, single use)
 *  2. PUT  <url>  (text/csv, column "identity")
 *  3. POST /upload_custom_list_segment_completed { name, email, filename, creator, url, replace }
 * Without CT_ACCOUNT_ID the run is a dry run: the CSV is built and measured, nothing is sent.
 */
export async function pushToCleverTap(s: Snapshot, run: Run, creator: string, onStep: () => void) {
  const step = (name: string, ok: boolean, detail?: string) => { run.steps.push({ at: new Date().toISOString(), step: name, ok, detail }); onStep(); };
  let csv: Buffer | null = buildCsv(s);
  run.rowsSent = s.audience.length;
  run.csvBytes = csv.length;
  run.csvSha256 = crypto.createHash('sha256').update(csv).digest('hex');
  step('Decrypt in memory + build CSV', true, `${run.rowsSent} rows, ${(csv.length / 1024).toFixed(1)} KB (never written to disk)`);

  try {
    if (!ctConfigured()) {
      step('Dry run', true, 'CT_ACCOUNT_ID not set: nothing was sent to CleverTap');
      return;
    }
    const r1 = await withRetry(() => ctPost('/get_custom_list_segment_url'), d => step('Get upload URL', false, d));
    const url = (r1.json.presignedS3URL ?? r1.json.url ?? r1.json.presigned_url ?? r1.json.uploadUrl) as string | undefined;
    if (r1.status !== 200 || !url) throw new Error(`Step 1 failed (${r1.status}): ${JSON.stringify(r1.json).slice(0, 200)}`);
    step('1. Get upload URL', true);

    const r2 = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csv });
    if (!r2.ok) throw new Error(`Step 2 upload failed (${r2.status})`);
    step('2. Upload CSV', true, `${run.csvBytes} bytes`);

    const r3 = await withRetry(() => ctPost('/upload_custom_list_segment_completed', {
      name: run.segmentName, email: config.ct.adminEmail, filename: `${run.id}.csv`,
      creator, url, replace: true,
    }), d => step('Confirm upload', false, d));
    if (r3.status !== 200 || (r3.json.status && r3.json.status !== 'success'))
      throw new Error(`Step 3 failed (${r3.status}): ${JSON.stringify(r3.json).slice(0, 200)}`);
    step('3. Confirm upload', true, 'CleverTap is processing the segment; it emails the result to CT_ADMIN_EMAIL');
  } finally {
    csv = null;                                    // drop the plain CSV
  }
}
