// Two-step login helpers: TOTP codes (Google Authenticator, Microsoft Authenticator…),
// recovery codes, and short-lived in-memory challenges for the login / passkey flows.
import crypto from 'node:crypto';
import { config } from '../config.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/** RFC 6238 code for a time step (30 s, 6 digits, SHA-1 – what every authenticator app uses). */
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const currentStep = (ms = Date.now()) => Math.floor(ms / 30000);

/**
 * Check a 6-digit code (±1 step for clock drift). Returns the matched step, or null.
 * `lastStep` blocks re-using a code that was already accepted.
 */
export function verifyTotp(secret, code, lastStep = null, now = Date.now()) {
  if (!/^\d{6}$/.test(code || '')) return null;
  const s = currentStep(now);
  for (const step of [s - 1, s, s + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    const expected = totpAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---- recovery codes (shown once, stored hashed) ----
const hashCode = (c) => crypto.createHash('sha256').update(c.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
export function newRecoveryCodes(n = 8) {
  const plain = Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  return { plain, stored: JSON.stringify(plain.map(hashCode)) };
}
/** Returns the remaining stored list if `code` matched one, else null. */
export function useRecoveryCode(stored, code) {
  let list = [];
  try { list = JSON.parse(stored || '[]'); } catch { return null; }
  const h = hashCode(code || '');
  const i = list.indexOf(h);
  if (i < 0) return null;
  list.splice(i, 1);
  return JSON.stringify(list);
}

// ---- short-lived challenges (login step 2, WebAuthn) ----
const challenges = new Map();
export function putChallenge(data, ttlMs = 5 * 60 * 1000) {
  const id = crypto.randomBytes(24).toString('base64url');
  challenges.set(id, { ...data, expires: Date.now() + ttlMs });
  if (challenges.size > 5000) for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  return id;
}
export function getChallenge(id) {
  const c = id && challenges.get(id);
  if (!c) return null;
  if (c.expires < Date.now()) { challenges.delete(id); return null; }
  return c;
}
export const dropChallenge = (id) => challenges.delete(id);

/** Relying party for passkeys: the public address of the app. */
export function relyingParty(req) {
  let origin = config.appUrl;
  // Without APP_URL (local dev) fall back to the address the browser used.
  if (!process.env.APP_URL && !process.env.RENDER_EXTERNAL_URL) origin = `${req.protocol}://${req.get('host')}`;
  const u = new URL(origin);
  return { rpID: u.hostname, origin: u.origin };
}
