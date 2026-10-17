// Join links: a manager creates a link, a new employee opens it and creates their own account.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { ah, badRequest, conflict, notFound } from '../lib/errors.js';
import { validate, z, zText, zOptId, zEmail, zPhone, zPassword, paramId } from '../lib/validate.js';
import { requirePerm, startSession, hashToken, newToken } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notifyPermission } from '../services/notify.js';
import { getSetting } from '../services/settings.js';

// ---------- manager side (mounted under the authenticated API) ----------
export const invitesRouter = Router();

invitesRouter.get('/', requirePerm('employees.manage'), (req, res) => {
  const invites = getDb().prepare(
    `SELECT i.id, i.label, i.max_uses, i.uses, i.expires_at, i.revoked, i.created_at, u.display_name AS created_by_name,
            d.name AS department_name, p.name AS position_name, l.name AS location_name
     FROM invites i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN departments d ON d.id = i.department_id
     LEFT JOIN positions p ON p.id = i.position_id LEFT JOIN locations l ON l.id = i.location_id
     ORDER BY i.id DESC LIMIT 50`,
  ).all().map((i) => ({ ...i, active: !i.revoked && i.uses < i.max_uses && i.expires_at > new Date().toISOString() }));
  res.json({ invites });
});

invitesRouter.post('/', requirePerm('employees.manage'), ah((req, res) => {
  const d = validate(z.object({
    label: z.string().trim().max(80).optional().default(''),
    max_uses: z.coerce.number().int().min(1).max(200).default(1),
    expires_days: z.coerce.number().int().min(1).max(30).default(7),
    department_id: zOptId, position_id: zOptId, location_id: zOptId,
  }), req.body);
  if (req.user.location_id && d.location_id && d.location_id !== req.user.location_id) throw badRequest('ניתן להזמין עובדים רק לסניף שלך');
  const token = newToken();
  const expires = new Date(Date.now() + d.expires_days * 86400000).toISOString();
  const id = getDb().prepare(
    `INSERT INTO invites (token_hash, label, created_by, department_id, position_id, location_id, max_uses, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), d.label || null, req.user.id, d.department_id, d.position_id, d.location_id || req.user.location_id || null, d.max_uses, expires).lastInsertRowid;
  audit(req, { action: 'invite.create', entityType: 'invite', entityId: id, description: `${req.user.display_name} יצר/ה קישור הצטרפות לעובדים${d.label ? ` (${d.label})` : ''}`, newValue: { ...d, expires_at: expires } });
  res.status(201).json({ id, link: `${config.appUrl}/join/${token}`, path: `/join/${token}`, expires_at: expires, message: 'קישור ההצטרפות נוצר' });
}));

invitesRouter.delete('/:id', requirePerm('employees.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const r = getDb().prepare('UPDATE invites SET revoked = 1 WHERE id = ?').run(id);
  if (!r.changes) throw notFound('הקישור לא נמצא');
  audit(req, { action: 'invite.revoke', entityType: 'invite', entityId: id, description: `${req.user.display_name} ביטל/ה קישור הצטרפות` });
  res.json({ ok: true, message: 'הקישור בוטל' });
}));

// ---------- public side (no login) ----------
export const joinRouter = Router();
const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'בוצעו יותר מדי ניסיונות. נסו שוב מאוחר יותר.' } });

function findInvite(token) {
  const inv = getDb().prepare(
    `SELECT i.*, d.name AS department_name, p.name AS position_name, l.name AS location_name FROM invites i
     LEFT JOIN departments d ON d.id = i.department_id LEFT JOIN positions p ON p.id = i.position_id LEFT JOIN locations l ON l.id = i.location_id
     WHERE i.token_hash = ?`,
  ).get(hashToken(String(token || '')));
  if (!inv || inv.revoked || inv.uses >= inv.max_uses || inv.expires_at <= new Date().toISOString()) return null;
  return inv;
}

joinRouter.get('/:token', joinLimiter, (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv) return res.status(404).json({ error: 'הקישור אינו תקף או שפג תוקפו. בקשו מהמנהל קישור חדש.' });
  res.json({ business_name: getSetting('business_name'), logo: getSetting('logo') || null, department_name: inv.department_name, position_name: inv.position_name, location_name: inv.location_name });
});

function nextEmployeeCode(db) {
  const rows = db.prepare("SELECT employee_code FROM employees WHERE employee_code LIKE 'EMP-%'").all();
  const max = rows.reduce((m, r) => Math.max(m, Number(r.employee_code.slice(4)) || 0), 1000);
  return `EMP-${max + 1}`;
}

joinRouter.post('/:token', joinLimiter, ah(async (req, res) => {
  const inv = findInvite(req.params.token);
  if (!inv) throw badRequest('הקישור אינו תקף או שפג תוקפו. בקשו מהמנהל קישור חדש.');
  const d = validate(z.object({
    first_name: zText(60), last_name: zText(60), phone: zPhone, email: zEmail,
    username: z.string().trim().min(3, 'לפחות 3 תווים').max(40).regex(/^[A-Za-z0-9._-]+$/, 'אותיות באנגלית, ספרות ו-._- בלבד'),
    password: zPassword,
  }), req.body);
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(d.username)) throw conflict('שם המשתמש תפוס, בחרו שם אחר', { fields: { username: 'שם המשתמש תפוס' } });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(d.email) || db.prepare('SELECT 1 FROM employees WHERE email = ?').get(d.email)) {
    throw conflict('כתובת האימייל כבר רשומה במערכת', { fields: { email: 'האימייל כבר רשום' } });
  }
  const hash = await bcrypt.hash(d.password, 12);
  const roleId = db.prepare("SELECT id FROM roles WHERE key = 'employee'").get().id;
  const today = new Date().toISOString().slice(0, 10);
  const { employeeId, userId, code } = db.transaction(() => {
    const fresh = db.prepare('SELECT uses, max_uses FROM invites WHERE id = ?').get(inv.id);
    if (fresh.uses >= fresh.max_uses) throw badRequest('הקישור כבר נוצל');
    const employeeCode = nextEmployeeCode(db);
    const eId = db.prepare(
      `INSERT INTO employees (employee_code, first_name, last_name, phone, email, position_id, department_id, location_id, start_date, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(employeeCode, d.first_name, d.last_name, d.phone, d.email, inv.position_id, inv.department_id, inv.location_id, today).lastInsertRowid;
    const uId = db.prepare('INSERT INTO users (username, email, display_name, password_hash, role_id, employee_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(d.username, d.email, `${d.first_name} ${d.last_name}`, hash, roleId, eId).lastInsertRowid;
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(inv.id);
    return { employeeId: eId, userId: uId, code: employeeCode };
  })();
  const name = `${d.first_name} ${d.last_name}`;
  audit({ user: { id: userId, display_name: name }, ip: req.ip }, {
    action: 'employee.joined', entityType: 'employee', entityId: employeeId, description: `${name} הצטרף/ה למערכת דרך קישור הזמנה`,
    newValue: { employee_code: code, username: d.username, email: d.email, phone: d.phone },
  });
  notifyPermission('employees.manage', {
    type: 'employee_joined', title: `עובד/ת חדש/ה הצטרף/ה: ${name}`,
    body: `שם משתמש: ${d.username} · טלפון: ${d.phone} · ${d.email}`, link: `/employees/${employeeId}`,
  });
  startSession(req, res, userId, true);
  res.status(201).json({ ok: true, message: `ברוכים הבאים, ${d.first_name}!` });
}));
