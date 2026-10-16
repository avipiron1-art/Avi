import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, forbidden, notFound, conflict } from '../lib/errors.js';
import {
  validate, z, zText, zOptText, zDate, zEmail, zPhone, zAvatar, zOptId, paramId,
} from '../lib/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { EMPLOYEE_COLUMNS, EMPLOYEE_JOINS, SHIFT_COLUMNS, SHIFT_JOINS, scrubEmployee } from '../lib/serialize.js';
import { computeAttendance } from '../lib/attendance.js';
import { nowLocal, monthRange, todayLocal, addDays } from '../lib/time.js';
import { audit, diff } from '../services/audit.js';

const router = Router();

const STATUS_LABEL = { active: 'פעיל', inactive: 'לא פעיל', vacation: 'בחופשה' };
const SORTABLE = {
  name: "e.first_name || ' ' || e.last_name", code: 'e.employee_code', position: 'p.name',
  department: 'd.name', status: 'e.status', start_date: 'e.start_date', wage: 'e.hourly_wage',
};

const employeeSchema = z.object({
  employee_code: zText(20),
  first_name: zText(60),
  last_name: zText(60),
  phone: z.union([zPhone, z.literal(''), z.null()]).optional().transform((v) => v || null),
  email: z.union([zEmail, z.literal(''), z.null()]).optional().transform((v) => v || null),
  avatar: zAvatar,
  position_id: zOptId,
  department_id: zOptId,
  location_id: zOptId,
  start_date: zDate,
  status: z.enum(['active', 'inactive', 'vacation']).default('active'),
  hourly_wage: z.union([z.coerce.number().min(0).max(10000), z.null(), z.literal('')]).optional()
    .transform((v) => (v === '' || v == null ? null : v)),
});

/** Can the current user view this employee's profile? */
function canViewEmployee(req, id) {
  return req.can('employees.view') || req.user.employee_id === id;
}

function getEmployee(id) {
  return getDb().prepare(`SELECT ${EMPLOYEE_COLUMNS} FROM employees e ${EMPLOYEE_JOINS} WHERE e.id = ?`).get(id);
}

function uniqueCheck(data, exceptId = 0) {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM employees WHERE employee_code = ? AND id != ?').get(data.employee_code, exceptId)) {
    throw conflict('מזהה העובד כבר קיים במערכת', { fields: { employee_code: 'מזהה העובד כבר קיים' } });
  }
  if (data.email && db.prepare('SELECT 1 FROM employees WHERE email = ? AND id != ?').get(data.email, exceptId)) {
    throw conflict('כתובת האימייל כבר קיימת במערכת', { fields: { email: 'האימייל כבר בשימוש' } });
  }
}

// ---------- list ----------
router.get('/', requirePerm('employees.view'), (req, res) => {
  const { search = '', department_id, position_id, status, sort = 'name', dir = 'asc' } = req.query;
  const where = [];
  const params = {};
  if (search) {
    where.push(`(e.first_name || ' ' || e.last_name LIKE @q OR e.employee_code LIKE @q OR e.email LIKE @q OR e.phone LIKE @q)`);
    params.q = `%${String(search).slice(0, 80)}%`;
  }
  if (department_id) { where.push('e.department_id = @department_id'); params.department_id = Number(department_id); }
  if (position_id) { where.push('e.position_id = @position_id'); params.position_id = Number(position_id); }
  if (status && STATUS_LABEL[status]) { where.push('e.status = @status'); params.status = status; }
  let orderCol = SORTABLE[sort] || SORTABLE.name;
  if (sort === 'wage' && !req.can('employees.wage')) orderCol = SORTABLE.name;
  const orderDir = dir === 'desc' ? 'DESC' : 'ASC';
  const rows = getDb().prepare(
    `SELECT ${EMPLOYEE_COLUMNS}, u.id AS user_id, r.name AS user_role_name
     FROM employees e ${EMPLOYEE_JOINS}
     LEFT JOIN users u ON u.employee_id = e.id LEFT JOIN roles r ON r.id = u.role_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${orderCol} ${orderDir}, e.id ASC`,
  ).all(params);
  res.json({ employees: rows.map((r) => scrubEmployee(r, req)) });
});

// ---------- profile ----------
router.get('/:id', ah((req, res) => {
  const id = paramId(req.params.id);
  if (!canViewEmployee(req, id)) throw forbidden();
  const emp = getEmployee(id);
  if (!emp) throw notFound('העובד לא נמצא');
  const db = getDb();
  const now = nowLocal();
  const { from, to } = monthRange(todayLocal());

  const shifts = db.prepare(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS} WHERE s.employee_id = ? AND s.status = 'scheduled'
     AND s.start_at >= ? ORDER BY s.start_at DESC`,
  ).all(id, addDays(todayLocal(), -120)).map((s) => ({ ...s, ...computeAttendance(s, now) }));

  const upcoming = shifts.filter((s) => s.end_at > now).reverse().slice(0, 10);
  const history = shifts.filter((s) => s.end_at <= now).slice(0, 30);
  const monthShifts = shifts.filter((s) => s.start_at.slice(0, 10) >= from && s.start_at.slice(0, 10) <= to && s.start_at <= now);
  const stats = {
    month_minutes: monthShifts.reduce((t, s) => t + s.worked_minutes, 0),
    month_shifts: monthShifts.length,
    late_count: monthShifts.filter((s) => s.late_minutes > 0).length,
    absence_count: monthShifts.filter((s) => s.attendance_status === 'absent').length,
    overtime_minutes: monthShifts.reduce((t, s) => t + s.overtime_minutes, 0),
  };

  // Worked hours per month (last 6 months)
  const monthly = new Map();
  for (const s of shifts) {
    if (s.start_at > now) continue;
    const m = s.start_at.slice(0, 7);
    monthly.set(m, (monthly.get(m) || 0) + s.worked_minutes);
  }
  const hours_by_month = [...monthly.entries()].sort().slice(-6).map(([month, mins]) => ({ month, hours: +(mins / 60).toFixed(1) }));

  const tasks = db.prepare(
    `SELECT t.*, u.display_name AS created_by_name FROM tasks t LEFT JOIN users u ON u.id = t.created_by
     WHERE t.assignee_id = ? ORDER BY CASE t.status WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 ELSE 1 END, t.due_date`,
  ).all(id);
  const requests = db.prepare(
    `SELECT rq.*, u.display_name AS reviewed_by_name FROM requests rq LEFT JOIN users u ON u.id = rq.reviewed_by
     WHERE rq.employee_id = ? ORDER BY rq.created_at DESC`,
  ).all(id);
  const notes = req.can('employees.notes') || req.can('employees.manage')
    ? db.prepare(
      `SELECT n.id, n.content, n.created_at, u.display_name AS author_name FROM employee_notes n
       LEFT JOIN users u ON u.id = n.author_id WHERE n.employee_id = ? ORDER BY n.created_at DESC`,
    ).all(id)
    : null;
  const account = db.prepare(
    'SELECT u.id, u.username, u.email, u.is_active, u.last_login_at, r.key AS role, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_id = ?',
  ).get(id) || null;

  res.json({
    employee: scrubEmployee(emp, req), stats, upcoming, history, hours_by_month, tasks, requests, notes, account,
  });
}));

// ---------- create ----------
router.post('/', requirePerm('employees.manage'), ah((req, res) => {
  const data = validate(employeeSchema, req.body);
  if (!req.can('employees.wage')) data.hourly_wage = null;
  uniqueCheck(data);
  const info = getDb().prepare(
    `INSERT INTO employees (employee_code, first_name, last_name, phone, email, avatar, position_id, department_id, location_id, start_date, status, hourly_wage)
     VALUES (@employee_code, @first_name, @last_name, @phone, @email, @avatar, @position_id, @department_id, @location_id, @start_date, @status, @hourly_wage)`,
  ).run({ avatar: null, ...data });
  const emp = getEmployee(info.lastInsertRowid);
  const { avatar, ...logged } = data;
  audit(req, { action: 'employee.create', entityType: 'employee', entityId: emp.id, description: `${req.user.display_name} הוסיף/ה את העובד ${emp.full_name}`, newValue: logged });
  res.status(201).json({ employee: scrubEmployee(emp, req) });
}));

// ---------- update ----------
router.put('/:id', requirePerm('employees.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const before = getEmployee(id);
  if (!before) throw notFound('העובד לא נמצא');
  const data = validate(employeeSchema, req.body);
  if (!req.can('employees.wage')) data.hourly_wage = before.hourly_wage;
  if (data.avatar === undefined) data.avatar = before.avatar;
  uniqueCheck(data, id);
  getDb().prepare(
    `UPDATE employees SET employee_code=@employee_code, first_name=@first_name, last_name=@last_name, phone=@phone, email=@email,
     avatar=@avatar, position_id=@position_id, department_id=@department_id, location_id=@location_id, start_date=@start_date,
     status=@status, hourly_wage=@hourly_wage, updated_at=datetime('now') WHERE id=@id`,
  ).run({ ...data, id });
  const after = getEmployee(id);
  const d = diff(before, data, ['employee_code', 'first_name', 'last_name', 'phone', 'email', 'position_id', 'department_id', 'location_id', 'start_date', 'status', 'hourly_wage']);
  if (d || before.avatar !== data.avatar) {
    audit(req, { action: 'employee.update', entityType: 'employee', entityId: id, description: `${req.user.display_name} עדכן/ה את פרטי העובד ${after.full_name}`, ...(d || {}) });
  }
  res.json({ employee: scrubEmployee(after, req) });
}));

// ---------- status (activate / deactivate / vacation) ----------
router.patch('/:id/status', requirePerm('employees.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const { status } = validate(z.object({ status: z.enum(['active', 'inactive', 'vacation']) }), req.body);
  const before = getEmployee(id);
  if (!before) throw notFound('העובד לא נמצא');
  const db = getDb();
  db.prepare("UPDATE employees SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  // An inactive employee cannot log in
  db.prepare('UPDATE users SET is_active = ? WHERE employee_id = ?').run(status === 'inactive' ? 0 : 1, id);
  if (status === 'inactive') db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)').run(id);
  audit(req, {
    action: 'employee.status', entityType: 'employee', entityId: id,
    description: `${req.user.display_name} שינה/תה את סטטוס העובד ${before.full_name} מ"${STATUS_LABEL[before.status]}" ל"${STATUS_LABEL[status]}"`,
    oldValue: { status: before.status }, newValue: { status },
  });
  res.json({ employee: scrubEmployee(getEmployee(id), req) });
}));

// ---------- delete ----------
router.delete('/:id', requirePerm('employees.delete'), ah((req, res) => {
  const id = paramId(req.params.id);
  const before = getEmployee(id);
  if (!before) throw notFound('העובד לא נמצא');
  if (req.user.employee_id === id) throw forbidden('לא ניתן למחוק את כרטיס העובד של המשתמש המחובר');
  const { avatar, ...snapshot } = before;
  getDb().prepare('DELETE FROM employees WHERE id = ?').run(id);
  audit(req, { action: 'employee.delete', entityType: 'employee', entityId: id, description: `${req.user.display_name} מחק/ה את העובד ${before.full_name}`, oldValue: snapshot });
  res.json({ ok: true });
}));

// ---------- manager notes ----------
router.post('/:id/notes', requirePerm('employees.notes', 'employees.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const emp = getEmployee(id);
  if (!emp) throw notFound('העובד לא נמצא');
  const { content } = validate(z.object({ content: zText(2000) }), req.body);
  const info = getDb().prepare('INSERT INTO employee_notes (employee_id, author_id, content) VALUES (?, ?, ?)').run(id, req.user.id, content);
  audit(req, { action: 'employee.note', entityType: 'employee', entityId: id, description: `${req.user.display_name} הוסיף/ה הערה לעובד ${emp.full_name}`, newValue: { content } });
  res.status(201).json({ note: { id: info.lastInsertRowid, content, author_name: req.user.display_name, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19) } });
}));

export default router;
