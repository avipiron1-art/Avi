import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { ah, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { validate, z, zPassword } from '../lib/validate.js';
import { startSession, endSession, requireAuth, hashToken, newToken, csrf } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { sendMail, renderEmail, mailEnabled } from '../services/mailer.js';
import QRCode from 'qrcode';
import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import {
  newTotpSecret, verifyTotp, otpauthUrl, newRecoveryCodes, useRecoveryCode, putChallenge, getChallenge, dropChallenge, relyingParty,
} from '../services/mfa.js';
import { getSetting } from '../services/settings.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'בוצעו יותר מדי ניסיונות התחברות. נסו שוב בעוד מספר דקות.' },
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'בוצעו יותר מדי בקשות. נסו שוב מאוחר יותר.' },
});

// Constant hash used to equalize timing when the user does not exist
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    role_name: user.role_name,
    employee_id: user.employee_id,
    location_id: user.location_id ?? null,
    lead_scope: user.lead_scope || null, // on duty as shift lead right now (temporary rights)
    permissions: [...user.permissions],
  };
}

router.post('/login', loginLimiter, ah(async (req, res) => {
  const body = validate(z.object({
    identifier: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(200),
    remember: z.boolean().optional().default(false),
  }), req.body);
  const db = getDb();
  const user = db.prepare(
    `SELECT u.*, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.email = ? OR u.username = ?`,
  ).get(body.identifier, body.identifier);

  const generic = 'שם המשתמש או הסיסמה שגויים';
  if (!user) {
    await bcrypt.compare(body.password, DUMMY_HASH);
    throw unauthorized(generic);
  }
  const nowIso = new Date().toISOString();
  if (user.locked_until && user.locked_until > nowIso) {
    throw unauthorized('החשבון ננעל זמנית עקב ניסיונות כושלים. נסו שוב בעוד מספר דקות.');
  }
  const ok = await bcrypt.compare(body.password, user.password_hash);
  if (!ok) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= config.login.maxFailedAttempts
      ? new Date(Date.now() + config.login.lockMinutes * 60000).toISOString() : null;
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(lock ? 0 : attempts, lock, user.id);
    if (lock) audit({ user: { id: user.id, display_name: user.display_name }, ip: req.ip }, {
      action: 'auth.locked', entityType: 'user', entityId: user.id,
      description: `החשבון של ${user.display_name} ננעל לאחר ${attempts} ניסיונות התחברות כושלים`,
    });
    throw unauthorized(generic);
  }
  if (!user.is_active) throw unauthorized('החשבון אינו פעיל. פנו למנהל המערכת.');

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  if (user.totp_enabled) {
    // Step 2: the password was right, now ask for the code from the authenticator app.
    const mfaToken = putChallenge({ kind: 'mfa', userId: user.id, remember: body.remember, tries: 0 });
    return res.json({ mfa_required: true, mfa_token: mfaToken });
  }
  finishLogin(req, res, user, body.remember, 'סיסמה');
}));

function finishLogin(req, res, user, remember, method) {
  const db = getDb();
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  // Drop expired sessions opportunistically
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  endSession(req, res);
  startSession(req, res, user.id, remember);
  audit({ user: { id: user.id, display_name: user.display_name }, ip: req.ip }, {
    action: 'auth.login', entityType: 'user', entityId: user.id, description: `${user.display_name} התחבר/ה למערכת (${method})`,
  });
  res.json({ ok: true });
}

// Step 2 of login: 6-digit code or a one-time recovery code.
router.post('/login/mfa', loginLimiter, ah(async (req, res) => {
  const body = validate(z.object({ mfa_token: z.string().min(10).max(100), code: z.string().trim().min(6).max(20) }), req.body);
  const ch = getChallenge(body.mfa_token);
  if (!ch || ch.kind !== 'mfa') throw unauthorized('פג הזמן להזנת הקוד. התחברו מחדש.');
  const db = getDb();
  const user = db.prepare('SELECT u.*, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(ch.userId);
  if (!user || !user.is_active || !user.totp_enabled) { dropChallenge(body.mfa_token); throw unauthorized('לא ניתן להשלים את ההתחברות'); }
  const code = body.code.replace(/\s/g, '');
  const step = verifyTotp(user.totp_secret, code, user.totp_last_step);
  let method = 'סיסמה + קוד אימות';
  if (step != null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
  } else {
    const rest = useRecoveryCode(user.recovery_codes, code);
    if (rest == null) {
      ch.tries += 1;
      if (ch.tries >= 5) { dropChallenge(body.mfa_token); throw unauthorized('יותר מדי קודים שגויים. התחברו מחדש.'); }
      throw badRequest('הקוד שגוי. בדקו את הקוד העדכני באפליקציית האימות.', { fields: { code: 'קוד שגוי' } });
    }
    db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(rest, user.id);
    method = 'קוד שחזור';
    audit({ user: { id: user.id, display_name: user.display_name }, ip: req.ip }, { action: 'auth.recovery_code_used', entityType: 'user', entityId: user.id, description: `${user.display_name} התחבר/ה עם קוד שחזור` });
  }
  dropChallenge(body.mfa_token);
  finishLogin(req, res, user, ch.remember, method);
}));

// ------------------------- account security -------------------------
/** Short "was this you?" email after security changes. */
function securityNotice(userId, what) {
  const u = getDb().prepare('SELECT email, display_name FROM users WHERE id = ?').get(userId);
  if (!u?.email) return;
  const mail = renderEmail({ title: what, lines: [`שלום ${u.display_name},`, `${what} (${new Date().toLocaleString('he-IL', { timeZone: getSetting('timezone') || 'Asia/Jerusalem' })}).`, 'אם זה לא היית את/ה – פנו מיד למנהל המערכת.'] });
  sendMail({ to: u.email, subject: what, ...mail }).catch(() => {});
}

router.put('/email-notifications', requireAuth, csrf, ah((req, res) => {
  const { enabled } = validate(z.object({ enabled: z.boolean() }), req.body);
  getDb().prepare('UPDATE users SET email_notifications = ? WHERE id = ?').run(enabled ? 1 : 0, req.user.id);
  res.json({ enabled, message: enabled ? 'התראות חשובות יישלחו גם למייל' : 'התראות במייל כובו' });
}));
const passwordOk = async (userId, password) => {
  const u = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return !!password && bcrypt.compare(password, u.password_hash);
};
const requirePassword = async (req, password) => {
  if (!(await passwordOk(req.user.id, password))) throw badRequest('הסיסמה שגויה', { fields: { password: 'הסיסמה שגויה' } });
};

router.get('/security', requireAuth, (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT totp_enabled, recovery_codes FROM users WHERE id = ?').get(req.user.id);
  let left = 0;
  try { left = JSON.parse(u.recovery_codes || '[]').length; } catch { /* ignore */ }
  const passkeys = db.prepare('SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.json({ totp_enabled: !!u.totp_enabled, recovery_left: left, passkeys });
});

router.post('/2fa/setup', requireAuth, csrf, ah(async (req, res) => {
  const { password } = validate(z.object({ password: z.string().max(200).default('') }), req.body);
  await requirePassword(req, password);
  const db = getDb();
  if (db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id).totp_enabled) throw badRequest('אימות דו-שלבי כבר פעיל');
  const secret = newTotpSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?').run(secret, req.user.id);
  const url = otpauthUrl(secret, req.user.username, getSetting('business_name') || 'Shiftly');
  res.json({ secret, otpauth_url: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
}));

router.post('/2fa/enable', requireAuth, csrf, ah((req, res) => {
  const { code } = validate(z.object({ code: z.string().trim().max(10) }), req.body);
  const db = getDb();
  const u = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (u.totp_enabled) throw badRequest('אימות דו-שלבי כבר פעיל');
  if (!u.totp_secret) throw badRequest('יש להתחיל את ההגדרה מחדש');
  const step = verifyTotp(u.totp_secret, code.replace(/\s/g, ''));
  if (step == null) throw badRequest('הקוד שגוי. ודאו שהשעה בטלפון מכוונת אוטומטית ונסו את הקוד העדכני.', { fields: { code: 'קוד שגוי' } });
  const rc = newRecoveryCodes();
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?').run(step, rc.stored, req.user.id);
  audit(req, { action: 'auth.2fa_enabled', entityType: 'user', entityId: req.user.id, description: `${req.user.display_name} הפעיל/ה אימות דו-שלבי` });
  res.json({ ok: true, recovery_codes: rc.plain, message: 'אימות דו-שלבי הופעל' });
}));

router.post('/2fa/disable', requireAuth, csrf, ah(async (req, res) => {
  const { password } = validate(z.object({ password: z.string().max(200).default('') }), req.body);
  await requirePassword(req, password);
  getDb().prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last_step = NULL WHERE id = ?').run(req.user.id);
  securityNotice(req.user.id, 'אימות דו-שלבי כובה בחשבון שלך');
  audit(req, { action: 'auth.2fa_disabled', entityType: 'user', entityId: req.user.id, description: `${req.user.display_name} כיבה/תה אימות דו-שלבי` });
  res.json({ ok: true, message: 'אימות דו-שלבי כובה' });
}));

router.post('/2fa/recovery', requireAuth, csrf, ah(async (req, res) => {
  const { password } = validate(z.object({ password: z.string().max(200).default('') }), req.body);
  await requirePassword(req, password);
  const db = getDb();
  if (!db.prepare('SELECT totp_enabled FROM users WHERE id = ?').get(req.user.id).totp_enabled) throw badRequest('אימות דו-שלבי לא פעיל');
  const rc = newRecoveryCodes();
  db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(rc.stored, req.user.id);
  audit(req, { action: 'auth.recovery_regenerated', entityType: 'user', entityId: req.user.id, description: `${req.user.display_name} יצר/ה קודי שחזור חדשים` });
  res.json({ recovery_codes: rc.plain });
}));

// ------------------------- passkeys (fingerprint / Face ID) -------------------------
router.post('/passkeys/register/options', requireAuth, csrf, ah(async (req, res) => {
  const { rpID } = relyingParty(req);
  const existing = getDb().prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?').all(req.user.id);
  const options = await generateRegistrationOptions({
    rpName: getSetting('business_name') || 'Shiftly', rpID,
    userName: req.user.username, userDisplayName: req.user.display_name,
    userID: new TextEncoder().encode(`u${req.user.id}`),
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = putChallenge({ kind: 'reg', userId: req.user.id, challenge: options.challenge });
  res.json({ options, challenge_id: challengeId });
}));

router.post('/passkeys/register/verify', requireAuth, csrf, ah(async (req, res) => {
  const body = validate(z.object({ challenge_id: z.string().max(100), name: z.string().trim().max(60).optional(), response: z.any() }), req.body);
  const ch = getChallenge(body.challenge_id);
  if (!ch || ch.kind !== 'reg' || ch.userId !== req.user.id) throw badRequest('פג הזמן. נסו שוב.');
  dropChallenge(body.challenge_id);
  const { rpID, origin } = relyingParty(req);
  let v;
  try {
    v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch (e) { throw badRequest(`לא ניתן לאמת את המכשיר: ${e.message}`); }
  if (!v.verified) throw badRequest('לא ניתן לאמת את המכשיר');
  const c = v.registrationInfo.credential;
  const ua = String(req.get('user-agent') || '');
  const guess = /iPhone|iPad/.test(ua) ? 'אייפון' : /Android/.test(ua) ? 'אנדרואיד' : /Mac/.test(ua) ? 'מק' : /Windows/.test(ua) ? 'מחשב Windows' : 'מכשיר';
  getDb().prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, c.id, Buffer.from(c.publicKey).toString('base64url'), c.counter, JSON.stringify(c.transports || []), body.name || guess);
  audit(req, { action: 'auth.passkey_added', entityType: 'user', entityId: req.user.id, description: `${req.user.display_name} הוסיף/ה כניסה בטביעת אצבע / זיהוי פנים (${body.name || guess})` });
  res.status(201).json({ ok: true, message: 'הכניסה בטביעת אצבע / זיהוי פנים הופעלה במכשיר הזה' });
}));

router.delete('/passkeys/:id', requireAuth, csrf, ah((req, res) => {
  const id = Number(req.params.id);
  const r = getDb().prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(id, req.user.id);
  if (!r.changes) throw badRequest('המכשיר לא נמצא');
  audit(req, { action: 'auth.passkey_removed', entityType: 'user', entityId: req.user.id, description: `${req.user.display_name} הסיר/ה מכשיר לכניסה ביומטרית` });
  res.json({ ok: true, message: 'המכשיר הוסר' });
}));

router.post('/passkeys/login/options', loginLimiter, ah(async (req, res) => {
  const { rpID } = relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  res.json({ options, challenge_id: putChallenge({ kind: 'auth', challenge: options.challenge }) });
}));

router.post('/passkeys/login/verify', loginLimiter, ah(async (req, res) => {
  const body = validate(z.object({ challenge_id: z.string().max(100), remember: z.boolean().optional().default(true), response: z.any() }), req.body);
  const ch = getChallenge(body.challenge_id);
  if (!ch || ch.kind !== 'auth') throw unauthorized('פג הזמן. נסו שוב.');
  dropChallenge(body.challenge_id);
  const db = getDb();
  const cred = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id = ?').get(String(body.response?.id || ''));
  if (!cred) throw unauthorized('המכשיר הזה לא רשום. התחברו עם סיסמה והפעילו כניסה ביומטרית בהגדרות.');
  const { rpID, origin } = relyingParty(req);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: cred.credential_id, publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64url')), counter: cred.counter, transports: JSON.parse(cred.transports || '[]') },
    });
  } catch { throw unauthorized('האימות נכשל'); }
  if (!v.verified) throw unauthorized('האימות נכשל');
  const user = db.prepare('SELECT u.*, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(cred.user_id);
  if (!user?.is_active) throw unauthorized('החשבון אינו פעיל. פנו למנהל המערכת.');
  if (user.locked_until && user.locked_until > new Date().toISOString()) throw unauthorized('החשבון ננעל זמנית. נסו שוב בעוד מספר דקות.');
  db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?").run(v.authenticationInfo.newCounter, cred.id);
  // A passkey with fingerprint / Face ID is already two factors (the device + the biometric).
  finishLogin(req, res, user, body.remember, `טביעת אצבע / זיהוי פנים · ${cred.name}`);
}));

// Public: whether to show the demo quick-login buttons (only in demo installs)
router.get('/options', (req, res) => res.json({ demo: config.demoMode, mail: mailEnabled() }));

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const row = getDb().prepare('SELECT dashboard_prefs, email_notifications FROM users WHERE id = ?').get(req.user.id);
  let prefs = {};
  try { prefs = JSON.parse(row?.dashboard_prefs || '{}'); } catch { /* ignore */ }
  res.json({ user: { ...publicUser(req.user), prefs, email_notifications: !!row?.email_notifications, mail_enabled: mailEnabled() } });
});

// Personal home screen: which page opens first and which dashboard blocks are hidden.
router.put('/preferences', requireAuth, csrf, ah((req, res) => {
  const prefs = validate(z.object({
    start: z.string().regex(/^\/[a-z-]*$/, 'עמוד לא תקין').max(40).default('/'),
    hidden: z.array(z.string().regex(/^[a-z_]+$/).max(30)).max(30).default([]),
  }), req.body);
  getDb().prepare('UPDATE users SET dashboard_prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.user.id);
  res.json({ prefs, message: 'המסך הראשי עודכן' });
}));

router.post('/forgot', resetLimiter, ah(async (req, res) => {
  const { identifier } = validate(z.object({ identifier: z.string().trim().min(1).max(120) }), req.body);
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR username = ?) AND is_active = 1').get(identifier, identifier);
  const response = { ok: true, message: 'אם החשבון קיים, נשלח אליו קישור לאיפוס הסיסמה.' };
  if (user) {
    const token = newToken();
    db.prepare('UPDATE password_resets SET used_at = datetime(\'now\') WHERE user_id = ? AND used_at IS NULL').run(user.id);
    db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))")
      .run(user.id, hashToken(token));
    const link = `${config.appUrl}/reset-password?token=${token}`;
    const mail = renderEmail({
      title: 'איפוס סיסמה', lines: [`שלום ${user.display_name},`, 'קיבלנו בקשה לאיפוס הסיסמה שלך. לחצו על הכפתור כדי לבחור סיסמה חדשה. הקישור בתוקף לשעה אחת.'],
      button: { label: 'בחירת סיסמה חדשה', url: link }, footer: 'לא ביקשת? אפשר להתעלם מהמייל – הסיסמה לא תשתנה.',
    });
    await sendMail({ to: user.email, subject: 'איפוס סיסמה', ...mail });
    audit({ user: { id: user.id, display_name: user.display_name }, ip: req.ip }, {
      action: 'auth.reset_requested', entityType: 'user', entityId: user.id, description: `התבקש איפוס סיסמה עבור ${user.display_name}`,
    });
    if (config.demoMode) response.demo_reset_path = `/reset-password?token=${token}`;
  }
  res.json(response);
}));

router.post('/reset', resetLimiter, ah(async (req, res) => {
  const body = validate(z.object({ token: z.string().min(10).max(200), password: zPassword }), req.body);
  const db = getDb();
  const row = db.prepare(
    "SELECT pr.*, u.display_name FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > datetime('now')",
  ).get(hashToken(body.token));
  if (!row) throw badRequest('הקישור לאיפוס אינו תקף או שפג תוקפו. בקשו קישור חדש.');
  const hash = await bcrypt.hash(body.password, 12);
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?").run(hash, row.user_id);
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE id = ?").run(row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id); // sign out everywhere
  })();
  securityNotice(row.user_id, 'הסיסמה שלך אופסה');
  audit({ user: { id: row.user_id, display_name: row.display_name }, ip: req.ip }, {
    action: 'auth.password_reset', entityType: 'user', entityId: row.user_id, description: `${row.display_name} איפס/ה סיסמה`,
  });
  res.json({ ok: true });
}));

// Edit own account details (main admin). The role title stays separate from the person's name.
router.put('/profile', requireAuth, csrf, ah(async (req, res) => {
  if (!req.can('users.manage')) throw forbidden('רק מנהל ראשי יכול לשנות את פרטי החשבון. פנו למנהל המערכת.');
  const body = validate(z.object({
    display_name: z.string().trim().min(1, 'שדה חובה').max(80),
    username: z.string().trim().min(3, 'לפחות 3 תווים').max(40).regex(/^[A-Za-z0-9._-]+$/, 'אותיות באנגלית, ספרות ו-._- בלבד'),
    email: z.string().trim().toLowerCase().email('כתובת אימייל לא תקינה').max(120),
    current_password: z.string().optional().default(''),
  }), req.body);
  const db = getDb();
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const loginChanged = body.username.toLowerCase() !== me.username.toLowerCase() || body.email !== me.email.toLowerCase();
  if (loginChanged && !(await bcrypt.compare(body.current_password, me.password_hash))) {
    throw badRequest('כדי לשנות שם משתמש או אימייל יש להזין את הסיסמה הנוכחית', { fields: { current_password: 'הסיסמה הנוכחית שגויה' } });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(body.username, me.id)) throw badRequest('שם המשתמש תפוס', { fields: { username: 'שם המשתמש תפוס' } });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(body.email, me.id)) throw badRequest('האימייל כבר בשימוש', { fields: { email: 'האימייל כבר בשימוש' } });
  db.prepare("UPDATE users SET display_name = ?, username = ?, email = ?, updated_at = datetime('now') WHERE id = ?")
    .run(body.display_name, body.username, body.email, me.id);
  audit(req, {
    action: 'user.profile', entityType: 'user', entityId: me.id, description: `${body.display_name} עדכן/ה את פרטי החשבון שלו/ה`,
    oldValue: { display_name: me.display_name, username: me.username, email: me.email },
    newValue: { display_name: body.display_name, username: body.username, email: body.email },
  });
  res.json({ ok: true, message: 'פרטי החשבון נשמרו' });
}));

router.post('/change-password', requireAuth, csrf, ah(async (req, res) => {
  const body = validate(z.object({ current_password: z.string().min(1), new_password: zPassword }), req.body);
  const db = getDb();
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await bcrypt.compare(body.current_password, u.password_hash))) {
    throw badRequest('הסיסמה הנוכחית שגויה', { fields: { current_password: 'הסיסמה הנוכחית שגויה' } });
  }
  const hash = await bcrypt.hash(body.new_password, 12);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.user.session_id);
  audit(req, { action: 'auth.password_change', entityType: 'user', entityId: req.user.id, description: `${req.user.display_name} שינה/תה סיסמה` });
  securityNotice(req.user.id, 'הסיסמה שלך שונתה');
  res.json({ ok: true });
}));

export default router;
