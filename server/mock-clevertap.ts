/**
 * Local stand-in for CleverTap's Custom List API, for testing without a CleverTap account.
 * Run: npm run mock:clevertap   then set CT_BASE_URL=http://localhost:4010, CT_ACCOUNT_ID=TEST, CT_PASSCODE=TEST
 * About 90% of emails "have a profile", so you can see uploaded vs matched.
 */
import express from 'express';
import crypto from 'node:crypto';

const app = express();
const PORT = 4010;
const uploads = new Map<string, string | 'USED' | null>();
const segments: Record<string, { uploaded: number; matched: number; at: string }> = {};
const hasProfile = (email: string) => crypto.createHash('md5').update(email).digest()[0] < 230;
const auth = (req: express.Request) => req.header('X-CleverTap-Account-Id') === 'TEST' && req.header('X-CleverTap-Passcode') === 'TEST';

app.post('/get_custom_list_segment_url', (req, res) => {
  if (!auth(req)) return res.status(401).json({ status: 'fail', error: 'Invalid credentials' });
  const t = crypto.randomUUID();
  uploads.set(t, null);
  res.json({ status: 'success', presignedS3URL: `http://localhost:${PORT}/s3/${t}` });
});
app.put('/s3/:t', express.text({ type: '*/*', limit: '200mb' }), (req, res) => {
  const u = uploads.get(req.params.t);
  if (u === undefined) return res.status(403).send('AccessDenied');
  if (u === 'USED') return res.status(400).json({ error: 'url_already_used' });
  uploads.set(req.params.t, req.body);
  res.sendStatus(200);
});
app.post('/upload_custom_list_segment_completed', express.json(), (req, res) => {
  if (!auth(req)) return res.status(401).json({ status: 'fail', error: 'Invalid credentials' });
  const missing = ['name', 'email', 'filename', 'creator', 'url'].filter(k => !(k in req.body));
  if (missing.length) return res.status(400).json({ status: 'fail', error: 'missing_fields', fields: missing });
  const t = String(req.body.url).split('/').pop()!;
  const csv = uploads.get(t);
  if (!csv || csv === 'USED') return res.status(400).json({ status: 'fail', error: 'file_not_found' });
  if (segments[req.body.name] && !req.body.replace) return res.status(400).json({ status: 'fail', error: 'duplicate_name' });
  const ids = csv.trim().split('\n').slice(1);
  segments[req.body.name] = { uploaded: ids.length, matched: ids.filter(hasProfile).length, at: new Date().toISOString() };
  uploads.set(t, 'USED');
  console.log(`[mock-clevertap] segment "${req.body.name}": ${ids.length} uploaded, ${segments[req.body.name].matched} matched`);
  res.json({ status: 'success' });
});
app.get('/_segments', (_req, res) => res.json(segments));   // mock only: see what "CleverTap" received

app.listen(PORT, () => console.log(`Mock CleverTap on http://localhost:${PORT}  (GET /_segments to inspect)`));
