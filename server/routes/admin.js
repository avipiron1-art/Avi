// Users & permissions, audit log, settings and reference data (departments / positions / locations)
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zText, zOptText, zEmail, zPassword, zOptId, paramId } from '../lib/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import {
  PERMISSIONS, permissionsForRole, permissionsForUser, setRolePermissions, setUserPermissions, userOverrides,
} from '../services/permissions.js';
import { getSetting, loadSettings, updateSettings, DEFAULT_SETTINGS } from '../services/settings.js';

const router = Router();

// =========================== reference data ===========================
router.get('/meta', (req, res) => {
  const db = getDb();
  res.json({
    departments: db.prepare(
      'SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS employee_count FROM departments d ORDER BY d.name',
    ).all(),
    positions: db.prepare('SELECT p.*, d.name AS department_name FROM positions p LEFT JOIN departments d ON d.id = p.department_id ORDER BY p.name').all(),
    locations: db.prepare('SELECT * FROM locations ORDER BY name').all(),
    roles: db.prepare('SELECT id, key, name, description FROM roles ORDER BY id').all(),
    employees: req.can('employees.view') || req.can('shifts.view_all') || req.can('tasks.manage')
      ? db.prepare("SELECT id, first_name || ' ' || last_name AS name, status, avatar, department_id, position_id FROM employees ORDER BY first_name").all()
      // regular employees get a minimal colleague list (for shift-swap requests)
      : db.prepare("SELECT id, first_name || ' ' || last_name AS name FROM employees WHERE status = 'active' ORDER BY first_name").all(),
    settings: {
      business_name: getSetting('business_name'), currency: getSetting('currency'),
      late_grace_minutes: Number(getSetting('late_grace_minutes')), overtime_daily_hours: Number(getSetting('overtime_daily_hours')),
    },
  });
});

const REF = {
  departments: {
    label: 'מחלקה',
    schema: z.object({ name: zText(80), description: zOptText(300), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6366f1') }),
    cols: ['name', 'description', 'color'],
  },
  positions: { label: 'תפקיד', schema: z.object({ name: zText(80), department_id: zOptId }), cols: ['name', 'department_id'] },
  locations: {
    label: 'מיקום',
    schema: z.object({ name: zText(80), address: zOptText(200), is_active: z.boolean().default(true).transform((b) => (b ? 1 : 0)) }),
    cols: ['name', 'address', 'is_active'],
  },
};

router.post('/meta/:kind', requirePerm('settings.manage'), ah((req, res) => {
  const ref = REF[req.params.kind];
  if (!ref) throw notFound();
  const data = validate(ref.schema, req.body);
  const db = getDb();
  if (db.prepare(`SELECT 1 FROM ${req.params.kind} WHERE name = ?`).get(data.name)) throw conflict(`${ref.label} בשם זה כבר קיים/ת`, { fields: { name: 'השם כבר קיים' } });
  const id = db.prepare(`INSERT INTO ${req.params.kind} (${ref.cols.join(',')}) VALUES (${ref.cols.map((c) => `@${c}`).join(',')})`).run(data).lastInsertRowid;
  audit(req, { action: `${req.params.kind}.create`, entityType: req.params.kind, entityId: id, description: `${req.user.display_name} הוסיף/ה ${ref.label}: ${data.name}`, newValue: data });
  res.status(201).json({ id, message: `${ref.label} נוספ/ה בהצלחה` });
}));

router.put('/meta/:kind/:id', requirePerm('settings.manage'), ah((req, res) => {
  const ref = REF[req.params.kind];
  if (!ref) throw notFound();
  const id = paramId(req.params.id);
  const db = getDb();
  const before = db.prepare(`SELECT * FROM ${req.params.kind} WHERE id = ?`).get(id);
  if (!before) throw notFound();
  const data = validate(ref.schema, req.body);
  if (db.prepare(`SELECT 1 FROM ${req.params.kind} WHERE name = ? AND id != ?`).get(data.name, id)) throw conflict('השם כבר קיים', { fields: { name: 'השם כבר קיים' } });
  db.prepare(`UPDATE ${req.params.kind} SET ${ref.cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...data, id });
  audit(req, { action: `${req.params.kind}.update`, entityType: req.params.kind, entityId: id, description: `${req.user.display_name} עדכן/ה ${ref.label}: ${data.name}`, oldValue: before, newValue: data });
  res.json({ message: 'השינויים נשמרו' });
}));

router.delete('/meta/:kind/:id', requirePerm('settings.manage'), ah((req, res) => {
  const ref = REF[req.params.kind];
  if (!ref) throw notFound();
  const id = paramId(req.params.id);
  const db = getDb();
  const before = db.prepare(`SELECT * FROM ${req.params.kind} WHERE id = ?`).get(id);
  if (!before) throw notFound();
  db.prepare(`DELETE FROM ${req.params.kind} WHERE id = ?`).run(id);
  audit(req, { action: `${req.params.kind}.delete`, entityType: req.params.kind, entityId: id, description: `${req.user.display_name} מחק/ה ${ref.label}: ${before.name}`, oldValue: before });
  res.json({ message: `${ref.label} נמחק/ה` });
}));

// =========================== settings ===========================
const settingsSchema = z.object({
  business_name: zText(80),
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }, 'אזור זמן לא תקין'),
  late_grace_minutes: z.coerce.number().int().min(0).max(120),
  early_leave_grace_minutes: z.coerce.number().int().min(0).max(120),
  overtime_daily_hours: z.coerce.number().min(1).max(16),
  currency: zText(5),
  task_due_soon_days: z.coerce.number().int().min(0).max(30),
});

router.get('/settings', requirePerm('settings.manage'), (req, res) => res.json({ settings: loadSettings() }));

router.put('/settings', requirePerm('settings.manage'), ah((req, res) => {
  const data = validate(settingsSchema, req.body);
  const before = loadSettings();
  const after = updateSettings(data);
  const changed = Object.keys(DEFAULT_SETTINGS).filter((k) => String(before[k]) !== String(after[k]));
  if (changed.length) {
    audit(req, { action: 'settings.update', entityType: 'settings', description: `${req.user.display_name} עדכן/ה הגדרות מערכת`,
      oldValue: Object.fromEntries(changed.map((k) => [k, before[k]])), newValue: Object.fromEntries(changed.map((k) => [k, after[k]])) });
  }
  res.json({ settings: after, message: 'ההגדרות נשמרו בהצלחה' });
}));

// =========================== permissions ===========================
router.get('/permissions', requirePerm('users.manage'), (req, res) => {
  const roles = getDb().prepare('SELECT key, name FROM roles ORDER BY id').all();
  res.json({
    catalog: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    roles: roles.map((r) => ({ ...r, locked: r.key === 'admin', permissions: [...permissionsForRole(r.key)] })),
  });
});

router.put('/permissions/:role', requirePerm('users.manage'), ah((req, res) => {
  const role = req.params.role;
  if (!['shift_manager', 'employee'].includes(role)) throw forbidden('לא ניתן לשנות את הרשאות המנהל הראשי');
  const { permissions } = validate(z.object({ permissions: z.array(z.enum(Object.keys(PERMISSIONS))) }), req.body);
  const before = [...permissionsForRole(role)];
  setRolePermissions(role, permissions);
  audit(req, { action: 'permissions.update', entityType: 'role', description: `${req.user.display_name} עדכן/ה הרשאות לתפקיד ${role}`, oldValue: before, newValue: permissions });
  res.json({ message: 'ההרשאות עודכנו' });
}));

// =========================== users ===========================
const USER_COLUMNS = `u.id, u.username, u.email, u.display_name, u.employee_id, u.is_active, u.last_login_at, u.created_at,
  r.key AS role, r.name AS role_name, e.first_name || ' ' || e.last_name AS employee_name`;
const getUser = (id) => getDb().prepare(`SELECT ${USER_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ?`).get(id);

router.get('/users', requirePerm('users.manage'), (req, res) => {
  const users = getDb().prepare(`SELECT ${USER_COLUMNS} FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.id = u.employee_id ORDER BY r.id, u.display_name`).all();
  res.json({ users: users.map((u) => ({ ...u, custom_permissions: u.role === 'admin' ? 0 : Object.keys(userOverrides(u.id)).length })) });
});

// ---------- personal permissions ----------
router.get('/users/:id/permissions', requirePerm('users.manage'), ah((req, res) => {
  const u = getUser(paramId(req.params.id));
  if (!u) throw notFound('המשתמש לא נמצא');
  res.json({
    user: { id: u.id, display_name: u.display_name, role: u.role, role_name: u.role_name },
    locked: u.role === 'admin',
    catalog: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    role_permissions: [...permissionsForRole(u.role)],
    effective: [...permissionsForUser(u.id, u.role)],
  });
}));

router.put('/users/:id/permissions', requirePerm('users.manage'), ah((req, res) => {
  const u = getUser(paramId(req.params.id));
  if (!u) throw notFound('המשתמש לא נמצא');
  if (u.role === 'admin') throw forbidden('למנהל ראשי יש תמיד את כל ההרשאות');
  if (req.user.role !== 'admin' && u.id === req.user.id) throw forbidden('לא ניתן לשנות את ההרשאות של עצמך');
  const { permissions } = validate(z.object({ permissions: z.array(z.enum(Object.keys(PERMISSIONS))) }), req.body);
  const before = [...permissionsForUser(u.id, u.role)];
  setUserPermissions(u.id, u.role, permissions);
  const after = [...permissionsForUser(u.id, u.role)];
  const label = (list) => list.map((p) => PERMISSIONS[p]);
  audit(req, {
    action: 'permissions.user_update', entityType: 'user', entityId: u.id,
    description: `${req.user.display_name} עדכן/ה הרשאות אישיות למשתמש ${u.display_name}`,
    oldValue: label(before), newValue: label(after),
  });
  res.json({ effective: after, message: 'ההרשאות האישיות נשמרו' });
}));

const userSchema = z.object({
  username: z.string().trim().min(3, 'לפחות 3 תווים').max(40).regex(/^[A-Za-z0-9._-]+$/, 'אותיות באנגלית, ספרות ו-._- בלבד'),
  email: zEmail,
  display_name: zText(80),
  role: z.enum(['admin', 'shift_manager', 'employee']),
  employee_id: zOptId,
  is_active: z.boolean().default(true),
});

/** Only a main admin may create, edit or manage main-admin accounts (protects against delegated users.manage). */
function guardAdminTarget(req, target, newRole) {
  if (req.user.role === 'admin') return;
  if (target?.role === 'admin' || newRole === 'admin') throw forbidden('רק מנהל ראשי יכול לנהל חשבונות של מנהלים ראשיים');
}

function checkUserUnique(data, exceptId = 0) {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(data.username, exceptId)) throw conflict('שם המשתמש תפוס', { fields: { username: 'שם המשתמש תפוס' } });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(data.email, exceptId)) throw conflict('האימייל כבר בשימוש', { fields: { email: 'האימייל כבר בשימוש' } });
  if (data.employee_id) {
    if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(data.employee_id)) throw badRequest('העובד לא קיים');
    if (db.prepare('SELECT 1 FROM users WHERE employee_id = ? AND id != ?').get(data.employee_id, exceptId)) throw conflict('לעובד זה כבר יש משתמש', { fields: { employee_id: 'לעובד כבר יש משתמש' } });
  }
}

router.post('/users', requirePerm('users.manage'), ah(async (req, res) => {
  const data = validate(userSchema.extend({ password: zPassword }), req.body);
  guardAdminTarget(req, null, data.role);
  checkUserUnique(data);
  const db = getDb();
  const roleId = db.prepare('SELECT id FROM roles WHERE key = ?').get(data.role).id;
  const hash = await bcrypt.hash(data.password, 12);
  const id = db.prepare('INSERT INTO users (username, email, display_name, password_hash, role_id, employee_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(data.username, data.email, data.display_name, hash, roleId, data.employee_id, data.is_active ? 1 : 0).lastInsertRowid;
  const { password, ...logged } = data;
  audit(req, { action: 'user.create', entityType: 'user', entityId: id, description: `${req.user.display_name} יצר/ה משתמש ${data.display_name} (${data.role})`, newValue: logged });
  res.status(201).json({ user: getUser(id), message: 'המשתמש נוצר בהצלחה' });
}));

router.put('/users/:id', requirePerm('users.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const before = getUser(id);
  if (!before) throw notFound('המשתמש לא נמצא');
  const data = validate(userSchema, req.body);
  guardAdminTarget(req, before, data.role);
  if (id === req.user.id && (data.role !== 'admin' || !data.is_active)) throw forbidden('לא ניתן להסיר הרשאות ניהול או להשבית את המשתמש שלך');
  checkUserUnique(data, id);
  const db = getDb();
  const roleId = db.prepare('SELECT id FROM roles WHERE key = ?').get(data.role).id;
  db.prepare("UPDATE users SET username=?, email=?, display_name=?, role_id=?, employee_id=?, is_active=?, updated_at=datetime('now') WHERE id=?")
    .run(data.username, data.email, data.display_name, roleId, data.employee_id, data.is_active ? 1 : 0, id);
  if (!data.is_active || before.role !== data.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  const after = getUser(id);
  audit(req, {
    action: before.role !== data.role ? 'user.role_change' : 'user.update', entityType: 'user', entityId: id,
    description: before.role !== data.role
      ? `${req.user.display_name} שינה/תה את ההרשאה של ${after.display_name} מ"${before.role_name}" ל"${after.role_name}"`
      : `${req.user.display_name} עדכן/ה את המשתמש ${after.display_name}`,
    oldValue: { username: before.username, email: before.email, role: before.role, employee_id: before.employee_id, is_active: !!before.is_active },
    newValue: { username: data.username, email: data.email, role: data.role, employee_id: data.employee_id, is_active: data.is_active },
  });
  res.json({ user: after, message: 'המשתמש עודכן בהצלחה' });
}));

router.post('/users/:id/password', requirePerm('users.manage'), ah(async (req, res) => {
  const id = paramId(req.params.id);
  const u = getUser(id);
  if (!u) throw notFound('המשתמש לא נמצא');
  guardAdminTarget(req, u);
  const { password } = validate(z.object({ password: zPassword }), req.body);
  const db = getDb();
  db.prepare("UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, updated_at = datetime('now') WHERE id = ?").run(await bcrypt.hash(password, 12), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  audit(req, { action: 'user.password_set', entityType: 'user', entityId: id, description: `${req.user.display_name} הגדיר/ה סיסמה חדשה למשתמש ${u.display_name}` });
  res.json({ message: 'הסיסמה עודכנה. המשתמש נותק מכל המכשירים.' });
}));

router.delete('/users/:id', requirePerm('users.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  if (id === req.user.id) throw forbidden('לא ניתן למחוק את המשתמש שלך');
  const u = getUser(id);
  if (!u) throw notFound('המשתמש לא נמצא');
  guardAdminTarget(req, u);
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(req, { action: 'user.delete', entityType: 'user', entityId: id, description: `${req.user.display_name} מחק/ה את המשתמש ${u.display_name}`, oldValue: u });
  res.json({ message: 'המשתמש נמחק' });
}));

// =========================== audit log (read-only) ===========================
router.get('/audit', requirePerm('audit.view'), (req, res) => {
  const { search = '', entity_type, user_id, from, to } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = 30;
  const where = [];
  const p = {};
  if (search) { where.push('(description LIKE @q OR user_name LIKE @q OR action LIKE @q)'); p.q = `%${String(search).slice(0, 80)}%`; }
  if (entity_type) { where.push('entity_type = @et'); p.et = String(entity_type); }
  if (user_id) { where.push('user_id = @uid'); p.uid = Number(user_id); }
  if (from) { where.push("created_at >= @from"); p.from = String(from); }
  if (to) { where.push("created_at < date(@to, '+1 day')"); p.to = String(to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${w}`).get(p).c;
  const logs = db.prepare(`SELECT * FROM audit_logs ${w} ORDER BY id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`).all(p);
  res.json({ logs, total, page, pages: Math.max(1, Math.ceil(total / size)) });
});

export default router;
