import crypto from 'node:crypto';
import { config, ctConfigured } from './config.js';
import type { Run, Snapshot } from './model.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** One column, "identity", holding Fynd user IDs. Built in memory; never written to disk. */
function buildCsv(s: Snapshot): Buffer {
  const lines = ['identity'];
  for (const a of s.audience) lines.push(/[",\n]/.test(a.fynd_user_id) ? `"${a.fynd_user_id.replace(/"/g, '""')}"` : a.fynd_user_id);
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

/** Retries network errors, rate limits, server errors and "another upload is still processing". */
async function withRetry<T extends { status: number; json: Record<string, unknown> }>(fn: () => Promise<T>, note: (s: string) => void, waitMs = 2000) {
  for (let attempt = 1; ; attempt++) {
    let r: T | undefined; let netErr: Error | undefined;
    try { r = await fn(); } catch (e) { netErr = e as Error; }
    const err = r ? String(r.json.error ?? r.json.code ?? '') : netErr!.message;
    const retryable = !r || r.status === 429 || r.status >= 500 || /segment_in_progress|rate_limit/i.test(err);
    if (!retryable || attempt >= 4) { if (r) return r; throw new Error(`CleverTap not reachable: ${netErr!.message}`); }
    const wait = waitMs * 2 ** (attempt - 1);
    note(`attempt ${attempt} failed (${r ? r.status : 'network'} ${err}); retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

class StepError extends Error { constructor(public step: string, msg: string) { super(msg); } }

/**
 * CleverTap Custom List API, 3 steps:
 *  1. POST /get_custom_list_segment_url        → pre-signed upload URL (single use)
 *  2. PUT  <url>  (text/csv, column "identity" = Fynd user ID)
 *  3. POST /upload_custom_list_segment_completed { name, email, filename, creator, url, replace: true }
 * replace: true means a retry overwrites the same segment instead of creating a duplicate.
 * Without CT_ACCOUNT_ID the run is a dry run: the CSV is built and measured, nothing is sent.
 */
export async function tagInCleverTap(s: Snapshot, run: Run, creator: string, onStep: () => void, opts: { retryWaitMs?: number } = {}) {
  const step = (name: string, ok: boolean, detail?: string) => { run.steps.push({ at: new Date().toISOString(), step: name, ok, detail }); onStep(); };
  let csv: Buffer | null = buildCsv(s);
  run.rowsTagged = s.audience.length;
  run.csvBytes = csv.length;
  run.csvSha256 = crypto.createHash('sha256').update(csv).digest('hex');
  step('Build list of Fynd user IDs', true, `${run.rowsTagged.toLocaleString()} IDs, ${(csv.length / 1024).toFixed(1)} KB (in memory only)`);

  try {
    if (!ctConfigured()) { step('Dry run', true, 'CT_ACCOUNT_ID not set: nothing was sent to CleverTap'); return; }

    let current = '1. Get upload link';
    try {
      const r1 = await withRetry(() => ctPost('/get_custom_list_segment_url'), d => step(current, false, d), opts.retryWaitMs);
      const url = (r1.json.presignedS3URL ?? r1.json.url ?? r1.json.presigned_url ?? r1.json.uploadUrl) as string | undefined;
      if (r1.status !== 200 || !url) throw new Error(`CleverTap answered ${r1.status}: ${JSON.stringify(r1.json).slice(0, 200)}`);
      step(current, true);

      current = '2. Upload ID list';
      const r2 = await withRetry(async () => {
        const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/csv' }, body: csv! });
        return { status: r.status, json: {} as Record<string, unknown> };
      }, d => step(current, false, d), opts.retryWaitMs);
      if (r2.status < 200 || r2.status >= 300) throw new Error(`Upload rejected (${r2.status})`);
      step(current, true, `${run.csvBytes} bytes`);

      current = '3. Create / replace segment';
      const r3 = await withRetry(() => ctPost('/upload_custom_list_segment_completed', {
        name: run.segmentName, email: config.ct.adminEmail, filename: `${run.id}.csv`, creator, url, replace: true,
      }), d => step(current, false, d), opts.retryWaitMs);
      if (r3.status !== 200 || (r3.json.status && r3.json.status !== 'success'))
        throw new Error(`CleverTap answered ${r3.status}: ${JSON.stringify(r3.json).slice(0, 200)}`);
      step(current, true, `Segment “${run.segmentName}” accepted; CleverTap matches the IDs to profiles and emails the result to CT_ADMIN_EMAIL`);
    } catch (e) {
      step(current, false, (e as Error).message);
      throw new StepError(current, (e as Error).message);
    }
  } finally {
    csv = null;
  }
}
export { StepError };
