import crypto from 'node:crypto';
import { config } from './config.js';

const key = (b64: string, name: string) => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error(`${name} missing or not 32 bytes. Run: npm run keys`);
  return k;
};
const ENC = () => key(config.encKey, 'ENC_KEY');
const MAC = () => key(config.hmacKey, 'HMAC_KEY');

export const normaliseEmail = (raw: unknown) => String(raw ?? '').trim().toLowerCase();
export const isValidEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e);

/** Keyed one-way fingerprint: for de-duplication, logs and matching. Never reversed. */
export const hashEmail = (email: string) => crypto.createHmac('sha256', MAC()).update(email).digest('hex');

/** AES-256-GCM. Output = base64(iv[12] | tag[16] | ciphertext). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Only the push worker calls this, and only in memory. */
export function decrypt(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

export const keysReady = () => { try { ENC(); MAC(); return true; } catch { return false; } };
