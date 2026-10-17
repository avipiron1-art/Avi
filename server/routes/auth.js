import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { ah, badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { validate, z, zPassword } from '../lib/validate.js';
import { startSession, endSession, requireAuth, hashToken, newToken, csrf } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { sendMail } from '../services/mailer.js';

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

  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").run(user.id);
  // Drop expired sessions opportunistically
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  endSession(req, res);
  startSession(req, res, user.id, body.remember);
  audit({ user: { id: user.id, display_name: user.display_name }, ip: req.ip }, {
    action: 'auth.login', entityType: 'user', entityId: user.id, description: `${user.display_name} התחבר/ה למערכת`,
  });
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

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
    await sendMail({ to: user.email, subject: 'איפוס סיסמה', text: `לאיפוס הסיסמה היכנסו לקישור (בתוקף לשעה):\n${link}` });
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
  res.json({ ok: true });
}));

export default router;
