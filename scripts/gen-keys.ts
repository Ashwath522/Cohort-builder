/** Creates .env from .env.example (if missing) and fills in ENC_KEY / HMAC_KEY if they are empty. */
import fs from 'node:fs';
import crypto from 'node:crypto';

if (!fs.existsSync('.env')) fs.copyFileSync('.env.example', '.env');
let env = fs.readFileSync('.env', 'utf8');
for (const k of ['ENC_KEY', 'HMAC_KEY']) {
  const re = new RegExp(`^${k}=\\s*$`, 'm');
  if (re.test(env)) { env = env.replace(re, `${k}=${crypto.randomBytes(32).toString('base64')}`); console.log(`Generated ${k}`); }
  else console.log(`${k} already set — kept (changing it makes existing snapshots unreadable)`);
}
fs.writeFileSync('.env', env);
