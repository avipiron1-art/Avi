// Users & permissions, audit log, settings and reference data (departments / positions / locations)
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';
import { ah, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zText, zOptText, zEmail, zPassword, zOptId, paramId } from '../lib/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { scopeWhere, describeScope, SCOPES, SCOPE_KEYS, clearScopeCache, resolveScope, employeeInScope as employeeInScopeFn } from '../services/scope.js';
import {
  PERMISSIONS, permissionsForRole, permissionsForUser, setRolePermissions, setUserPermissions, userOverrides, clearPermissionCache,
} from '../services/permissions.js';
import { getSetting, loadSettings, updateSettings, DEFAULT_SETTINGS, SECRET_SETTINGS } from '../services/settings.js';

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
    roles: db.prepare('SELECT id, key, name, description, scope FROM roles ORDER BY id').all(),
    employees: req.can('employees.view') || req.can('shifts.view_all') || req.can('tasks.manage')
      ? db.prepare(`SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.status, e.avatar, e.department_id, e.position_id, e.location_id FROM employees e
          WHERE 1 ${scopeWhere(req.user.scope, { e: 'e' })} ORDER BY e.first_name`).all()
      // regular employees get a minimal colleague list (for shift-swap requests)
      : db.prepare("SELECT id, first_name || ' ' || last_name AS name FROM employees WHERE status = 'active' ORDER BY first_name").all(),
    settings: {
      business_name: getSetting('business_name'), currency: getSetting('currency'),
      late_grace_minutes: Number(getSetting('late_grace_minutes')), overtime_daily_hours: Number(getSetting('overtime_daily_hours')),
      brand_color: getSetting('brand_color'), logo: getSetting('logo') || null,
      vapid_public: getSetting('vapid_public') || null,
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
    schema: z.object({
      name: zText(80), address: zOptText(200), is_active: z.boolean().default(true).transform((b) => (b ? 1 : 0)),
      latitude: z.union([z.coerce.number().min(-90).max(90), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v == null ? null : v)),
      longitude: z.union([z.coerce.number().min(-180).max(180), z.literal(''), z.null()]).optional().transform((v) => (v === '' || v == null ? null : v)),
      radius_m: z.coerce.number().int().min(30, 'רדיוס מינימלי 30 מ׳').max(5000).default(150),
      require_location: z.boolean().default(false).transform((b) => (b ? 1 : 0)),
    }).refine((d) => !d.require_location || (d.latitude != null && d.longitude != null), { message: 'כדי לחייב החתמה לפי מיקום יש להגדיר קואורדינטות', path: ['latitude'] }),
    cols: ['name', 'address', 'is_active', 'latitude', 'longitude', 'radius_m', 'require_location'],
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
  brand_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'צבע לא תקין').optional(),
  logo: z.union([
    z.string().max(400_000, 'הלוגו גדול מדי (עד 300KB)').regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'קובץ תמונה לא נתמך'),
    z.literal(''),
  ]).optional(),
  ot_tier1_hours: z.coerce.number().min(0).max(12).optional(),
  rate_ot1: z.coerce.number().min(1).max(3).optional(),
  rate_ot2: z.coerce.number().min(1).max(3).optional(),
  rate_rest_day: z.coerce.number().min(1).max(3).optional(),
  rest_day: z.coerce.number().int().min(0).max(6).optional(),
  shift_end_reminder_minutes: z.coerce.number().int().min(0).max(240).optional(),
  backup_keep: z.coerce.number().int().min(1).max(365).optional(),
});

const publicSettings = () => Object.fromEntries(Object.entries(loadSettings()).filter(([k]) => !SECRET_SETTINGS.includes(k) && !k.startsWith('gdrive_') && !k.startsWith('vapid_') && !k.startsWith('smtp_')));

router.get('/settings', requirePerm('settings.manage'), (req, res) => res.json({ settings: publicSettings() }));

router.put('/settings', requirePerm('settings.manage'), ah((req, res) => {
  const data = validate(settingsSchema, req.body);
  const before = loadSettings();
  const after = updateSettings(data);
  const changed = Object.keys(DEFAULT_SETTINGS).filter((k) => String(before[k]) !== String(after[k]));
  if (changed.length) {
    audit(req, { action: 'settings.update', entityType: 'settings', description: `${req.user.display_name} עדכן/ה הגדרות מערכת`,
      oldValue: Object.fromEntries(changed.map((k) => [k, k === 'logo' ? (before[k] ? '(תמונה)' : '') : before[k]])),
      newValue: Object.fromEntries(changed.map((k) => [k, k === 'logo' ? (after[k] ? '(תמונה)' : '') : after[k]])) });
  }
  res.json({ settings: publicSettings(), message: 'ההגדרות נשמרו בהצלחה' });
}));

// =========================== roles & permissions ===========================
const BUILT_IN_ROLES = ['admin', 'shift_manager', 'employee'];
const onlyMainAdmin = (req) => { if (req.user.role !== 'admin') throw forbidden('רק מנהל ראשי יכול לנהל תפקידים והרשאות'); };
const roleRow = (key) => getDb().prepare('SELECT * FROM roles WHERE key = ?').get(key);

router.get('/permissions', requirePerm('users.manage'), (req, res) => {
  const roles = getDb().prepare('SELECT r.key, r.name, r.description, r.scope, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS users FROM roles r ORDER BY r.id').all();
  res.json({
    catalog: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    scopes: SCOPE_KEYS.map((key) => ({ key, label: SCOPES[key] })),
    can_edit: req.user.role === 'admin',
    roles: roles.map((r) => ({ ...r, scope: r.key === 'admin' ? 'all' : r.scope, locked: r.key === 'admin', custom: !BUILT_IN_ROLES.includes(r.key), permissions: [...permissionsForRole(r.key)] })),
  });
});

const roleSchema = z.object({
  name: zText(40),
  description: zOptText(200),
  permissions: z.array(z.enum(Object.keys(PERMISSIONS))).optional(),
  scope: z.enum(SCOPE_KEYS).optional(), // who the permissions apply to
});

function checkRoleName(name, exceptKey = '') {
  if (getDb().prepare('SELECT 1 FROM roles WHERE name = ? AND key != ?').get(name, exceptKey)) throw conflict('כבר יש תפקיד בשם הזה', { fields: { name: 'השם תפוס' } });
}

router.post('/roles', requirePerm('users.manage'), ah((req, res) => {
  onlyMainAdmin(req);
  const d = validate(roleSchema, req.body);
  checkRoleName(d.name);
  const db = getDb();
  if (db.prepare('SELECT COUNT(*) c FROM roles').get().c >= 30) throw badRequest('אפשר להגדיר עד 30 תפקידים');
  const key = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  db.prepare('INSERT INTO roles (key, name, description, scope) VALUES (?, ?, ?, ?)').run(key, d.name, d.description, d.scope || 'branch');
  setRolePermissions(key, d.permissions || []);
  clearScopeCache();
  audit(req, { action: 'role.create', entityType: 'role', description: `${req.user.display_name} יצר/ה תפקיד חדש: ${d.name}`, newValue: { name: d.name, permissions: (d.permissions || []).map((p) => PERMISSIONS[p]) } });
  res.status(201).json({ key, message: `התפקיד "${d.name}" נוצר` });
}));

router.put('/roles/:key', requirePerm('users.manage'), ah((req, res) => {
  onlyMainAdmin(req);
  const before = roleRow(req.params.key);
  if (!before) throw notFound('התפקיד לא נמצא');
  const d = validate(roleSchema, req.body);
  checkRoleName(d.name, before.key);
  const oldPerms = [...permissionsForRole(before.key)];
  getDb().prepare('UPDATE roles SET name = ?, description = ?, scope = ? WHERE key = ?')
    .run(d.name, d.description, before.key === 'admin' ? 'all' : d.scope || before.scope, before.key);
  clearScopeCache();
  if (d.permissions && before.key !== 'admin') setRolePermissions(before.key, d.permissions); // the main admin always has everything
  audit(req, {
    action: 'role.update', entityType: 'role', description: `${req.user.display_name} עדכן/ה את התפקיד ${d.name}`,
    oldValue: { name: before.name, scope: SCOPES[before.scope], permissions: oldPerms.map((p) => PERMISSIONS[p]) },
    newValue: { name: d.name, scope: SCOPES[before.key === 'admin' ? 'all' : d.scope || before.scope], permissions: [...permissionsForRole(before.key)].map((p) => PERMISSIONS[p]) },
  });
  res.json({ message: 'התפקיד עודכן' });
}));

router.delete('/roles/:key', requirePerm('users.manage'), ah((req, res) => {
  onlyMainAdmin(req);
  const role = roleRow(req.params.key);
  if (!role) throw notFound('התפקיד לא נמצא');
  if (BUILT_IN_ROLES.includes(role.key)) throw forbidden('לא ניתן למחוק תפקיד מובנה');
  const db = getDb();
  const count = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(role.id).c;
  let target = null;
  if (count) {
    const moveTo = String(req.query.move_to || '');
    target = moveTo && moveTo !== role.key ? roleRow(moveTo) : null;
    if (!target || target.key === 'admin') throw conflict(`ל-${count} משתמשים יש את התפקיד הזה. בחרו לאיזה תפקיד להעביר אותם.`, { users: count });
  }
  db.transaction(() => {
    if (target) {
      db.prepare('UPDATE users SET role_id = ? WHERE role_id = ?').run(target.id, role.id);
      db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role_id = ?)').run(target.id);
    }
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  })();
  clearPermissionCache();
  clearScopeCache();
  audit(req, { action: 'role.delete', entityType: 'role', description: `${req.user.display_name} מחק/ה את התפקיד ${role.name}${target ? ` (${count} משתמשים הועברו ל"${target.name}")` : ''}` });
  res.json({ message: 'התפקיד נמחק' });
}));

// kept for older clients: permissions of one role
router.put('/permissions/:role', requirePerm('users.manage'), ah((req, res) => {
  onlyMainAdmin(req);
  const role = roleRow(req.params.role);
  if (!role) throw notFound('התפקיד לא נמצא');
  if (role.key === 'admin') throw forbidden('לא ניתן לשנות את הרשאות המנהל הראשי');
  const { permissions } = validate(z.object({ permissions: z.array(z.enum(Object.keys(PERMISSIONS))) }), req.body);
  const before = [...permissionsForRole(role.key)];
  setRolePermissions(role.key, permissions);
  audit(req, { action: 'permissions.update', entityType: 'role', description: `${req.user.display_name} עדכן/ה הרשאות לתפקיד ${role.name}`, oldValue: before, newValue: permissions });
  res.json({ message: 'ההרשאות עודכנו' });
}));

// =========================== users ===========================
const USER_COLUMNS = `u.id, u.username, u.email, u.display_name, u.employee_id, u.is_active, u.last_login_at, u.created_at,
  u.location_id, ul.name AS location_name, u.department_id, u.totp_enabled, r.scope AS role_scope,
  (SELECT group_concat(x.location_id) FROM user_locations x WHERE x.user_id = u.id) AS location_ids, (SELECT COUNT(*) FROM webauthn_credentials w WHERE w.user_id = u.id) AS passkeys,
  r.key AS role, r.name AS role_name, e.first_name || ' ' || e.last_name AS employee_name`;
const USER_JOINS = 'JOIN roles r ON r.id = u.role_id LEFT JOIN employees e ON e.id = u.employee_id LEFT JOIN locations ul ON ul.id = u.location_id';
const getUser = (id) => getDb().prepare(`SELECT ${USER_COLUMNS} FROM users u ${USER_JOINS} WHERE u.id = ?`).get(id);

/** Users a (delegated) user manager may see / manage: those whose employee card is in their scope, plus themself. */
function userScope(req) {
  const sc = req.user.scope;
  if (sc.all) return '';
  return `AND (u.id = ${Number(req.user.id)} OR (e.id IS NOT NULL ${scopeWhere(sc, { e: 'e', includeSelf: false })}))`;
}
const withScope = (u) => {
  const scope = resolveScope({ id: u.id, role: u.role, employee_id: u.employee_id });
  return { ...u, location_ids: u.location_ids ? String(u.location_ids).split(',').map(Number) : [], scope_label: describeScope(scope), scope_missing: scope.missing || null };
};

router.get('/users', requirePerm('users.manage'), (req, res) => {
  const users = getDb().prepare(`SELECT ${USER_COLUMNS} FROM users u ${USER_JOINS} WHERE 1 ${userScope(req)} ORDER BY r.id, u.display_name`).all();
  res.json({ users: users.map((u) => withScope({ ...u, custom_permissions: u.role === 'admin' ? 0 : Object.keys(userOverrides(u.id)).length })) });
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
  guardAdminTarget(req, u);
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
  role: z.string().trim().min(1, 'יש לבחור תפקיד').max(40),
  employee_id: zOptId,
  location_id: zOptId,   // branch the user is responsible for (empty = taken from the employee card)
  department_id: zOptId, // department the user is responsible for (empty = taken from the employee card)
  location_ids: z.array(z.coerce.number().int().positive()).max(100).optional().default([]), // for roles responsible for several branches
  is_active: z.boolean().default(true),
});

function roleIdFor(key) {
  const r = getDb().prepare('SELECT id FROM roles WHERE key = ?').get(key);
  if (!r) throw badRequest('התפקיד שנבחר לא קיים', { fields: { role: 'תפקיד לא קיים' } });
  return r.id;
}

/** Only a main admin may create, edit or manage main-admin accounts (protects against delegated users.manage). */
function guardAdminTarget(req, target, newRole) {
  if (req.user.role === 'admin') return;
  if (target?.role === 'admin' || newRole === 'admin') throw forbidden('רק מנהל ראשי יכול לנהל חשבונות של מנהלים ראשיים');
  if (target && !getDb().prepare(`SELECT 1 FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ? ${userScope(req)}`).get(target.id)) {
    throw forbidden('המשתמש לא באחריותך');
  }
}

/** A delegated user manager can only hand out responsibility inside their own scope. */
function fitResponsibility(req, data) {
  const sc = req.user.scope;
  if (data.role === 'admin') { data.location_id = null; data.department_id = null; data.location_ids = []; return; }
  if (sc.all) return;
  const okLoc = (l) => !sc.locs || sc.locs.includes(Number(l));
  if (data.location_id && !okLoc(data.location_id)) throw forbidden('הסניף שנבחר לא באחריותך');
  if (data.location_ids.some((l) => !okLoc(l))) throw forbidden('אחד הסניפים שנבחרו לא באחריותך');
  if (sc.dep && data.department_id && Number(data.department_id) !== sc.dep) throw forbidden('המחלקה שנבחרה לא באחריותך');
  if (sc.locs && !data.location_id && sc.locs.length === 1) data.location_id = sc.locs[0];
  if (sc.dep && !data.department_id) data.department_id = sc.dep;
}

/**
 * A role that works on a branch / department needs one, or the person would see nobody.
 * Taken from the user, else from their employee card; refuse to save without it.
 */
function requireResponsibility(data) {
  const db = getDb();
  const scope = db.prepare('SELECT scope FROM roles WHERE key = ?').get(data.role)?.scope;
  if (!scope || !db.prepare('SELECT 1 FROM locations LIMIT 1').get()) return;
  const emp = data.employee_id ? db.prepare('SELECT location_id, department_id FROM employees WHERE id = ?').get(data.employee_id) : null;
  const loc = data.location_id || emp?.location_id;
  const dep = data.department_id || emp?.department_id;
  if (scope === 'branch' && !loc) throw badRequest('לתפקיד הזה צריך לבחור את הסניף שבאחריותו (אין סניף בכרטיס העובד)', { fields: { location_id: 'יש לבחור סניף' } });
  if (scope === 'branches' && !data.location_ids.length && !loc) throw badRequest('יש לבחור לפחות סניף אחד שבאחריותו', { fields: { location_ids: 'יש לבחור סניפים' } });
  if (scope === 'department' && !loc) throw badRequest('לתפקיד הזה צריך לבחור סניף', { fields: { location_id: 'יש לבחור סניף' } });
  if ((scope === 'department' || scope === 'department_all') && !dep) throw badRequest('לתפקיד הזה צריך לבחור את המחלקה שבאחריותו', { fields: { department_id: 'יש לבחור מחלקה' } });
}

function saveUserLocations(userId, ids) {
  const db = getDb();
  const valid = new Set(db.prepare('SELECT id FROM locations').all().map((l) => l.id));
  db.prepare('DELETE FROM user_locations WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT OR IGNORE INTO user_locations (user_id, location_id) VALUES (?, ?)');
  for (const l of ids) if (valid.has(l)) ins.run(userId, l);
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
  const roleId = roleIdFor(data.role);
  const hash = await bcrypt.hash(data.password, 12);
  fitResponsibility(req, data);
  requireResponsibility(data);
  if (data.employee_id && !req.user.scope.all && !employeeInScopeFn(req.user.scope, data.employee_id)) throw forbidden('העובד שנבחר לא באחריותך');
  const id = db.prepare('INSERT INTO users (username, email, display_name, password_hash, role_id, employee_id, is_active, location_id, department_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.username, data.email, data.display_name, hash, roleId, data.employee_id, data.is_active ? 1 : 0, data.location_id, data.department_id).lastInsertRowid;
  saveUserLocations(id, data.location_ids);
  const { password, ...logged } = data;
  audit(req, { action: 'user.create', entityType: 'user', entityId: id, description: `${req.user.display_name} יצר/ה משתמש ${data.display_name} (${data.role})`, newValue: logged });
  res.status(201).json({ user: withScope(getUser(id)), message: 'המשתמש נוצר בהצלחה' });
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
  const roleId = roleIdFor(data.role);
  fitResponsibility(req, data);
  requireResponsibility(data);
  if (data.employee_id && data.employee_id !== before.employee_id && !req.user.scope.all && !employeeInScopeFn(req.user.scope, data.employee_id)) throw forbidden('העובד שנבחר לא באחריותך');
  db.prepare("UPDATE users SET username=?, email=?, display_name=?, role_id=?, employee_id=?, is_active=?, location_id=?, department_id=?, updated_at=datetime('now') WHERE id=?")
    .run(data.username, data.email, data.display_name, roleId, data.employee_id, data.is_active ? 1 : 0, data.location_id, data.department_id, id);
  saveUserLocations(id, data.location_ids);
  if (!data.is_active || before.role !== data.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  const after = getUser(id);
  audit(req, {
    action: before.role !== data.role ? 'user.role_change' : 'user.update', entityType: 'user', entityId: id,
    description: before.role !== data.role
      ? `${req.user.display_name} שינה/תה את ההרשאה של ${after.display_name} מ"${before.role_name}" ל"${after.role_name}"`
      : `${req.user.display_name} עדכן/ה את המשתמש ${after.display_name}`,
    oldValue: { username: before.username, email: before.email, role: before.role, employee_id: before.employee_id, is_active: !!before.is_active, location_id: before.location_id, department_id: before.department_id, location_ids: before.location_ids },
    newValue: { username: data.username, email: data.email, role: data.role, employee_id: data.employee_id, is_active: data.is_active, location_id: data.location_id, department_id: data.department_id, location_ids: data.location_ids.join(',') || null },
  });
  res.json({ user: withScope(after), message: 'המשתמש עודכן בהצלחה' });
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

// Lost phone: turn off two-step login and remove passkeys so the user can sign in with the password.
router.post('/users/:id/reset-mfa', requirePerm('users.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const u = getUser(id);
  if (!u) throw notFound('המשתמש לא נמצא');
  guardAdminTarget(req, u);
  const db = getDb();
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last_step = NULL WHERE id = ?').run(id);
  db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(id);
  audit(req, { action: 'user.mfa_reset', entityType: 'user', entityId: id, description: `${req.user.display_name} איפס/ה אימות דו-שלבי וכניסה ביומטרית למשתמש ${u.display_name}` });
  res.json({ message: 'האימות הדו-שלבי והכניסה הביומטרית אופסו' });
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

// Delete activity history – main admin only, with the password. The log is otherwise immutable
// (database triggers); they are lifted only inside this transaction. The deletion itself stays recorded.
router.post('/audit/purge', ah(async (req, res) => {
  if (req.user.role !== 'admin') throw forbidden('רק מנהל ראשי יכול למחוק היסטוריית פעילות');
  const b = validate(z.object({
    keep_days: z.coerce.number().int().refine((n) => [0, 30, 90, 365].includes(n), 'טווח לא תקין'),
    password: z.string().max(200).default(''),
  }), req.body);
  const db = getDb();
  const me = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!b.password || !(await bcrypt.compare(b.password, me.password_hash))) throw badRequest('הסיסמה שגויה', { fields: { password: 'הסיסמה שגויה' } });
  const cutoff = b.keep_days ? `AND created_at < datetime('now', '-${b.keep_days} day')` : '';
  let deleted = 0;
  db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS audit_logs_no_delete');
    deleted = db.prepare(`DELETE FROM audit_logs WHERE 1 = 1 ${cutoff}`).run().changes;
    db.exec(`CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;`);
  })();
  const what = b.keep_days ? `שישנה מ-${b.keep_days} ימים` : 'כולה';
  audit(req, { action: 'audit.purge', entityType: 'audit', description: `${req.user.display_name} מחק/ה את היסטוריית הפעילות ${what} (${deleted} רשומות)` });
  res.json({ deleted, message: deleted ? `נמחקו ${deleted} רשומות מההיסטוריה` : 'לא היו רשומות למחיקה בטווח שנבחר' });
}));

export default router;
