import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zMonth, zDate, zDateTime, zOptText, zOptId, paramId, zText } from '../lib/validate.js';
import { requirePerm, requireEmployee, scopeSql } from '../middleware/auth.js';
import { SHIFT_COLUMNS, SHIFT_JOINS } from '../lib/serialize.js';
import { computeAttendance } from '../lib/attendance.js';
import { addDays, addMinutes, nowLocal, todayLocal, hhmm } from '../lib/time.js';
import { audit } from '../services/audit.js';
import { notifyPermission } from '../services/notify.js';
import { getShift } from './shifts.js';
import { monthRange } from '../lib/time.js';
import { buildPayroll } from '../services/payroll.js';
import { payrollWorkbook, sendWorkbook, slipJson } from '../services/payrollExport.js';

const router = Router();
const EARLY_CLOCK_IN_MINUTES = 60;

const geoSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  accuracy: z.coerce.number().min(0).max(100000).optional(),
}).default({});

/** Great-circle distance in metres. */
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Location check for clock-in/out. The branch is the shift's location, else the employee's.
 * Returns the distance (or null when it can't be measured). Throws when the branch requires
 * location and the employee is clearly outside the allowed radius (GPS accuracy is forgiven up to 100 m).
 */
function checkLocation(shift, body) {
  const db = getDb();
  const locId = shift.location_id ?? db.prepare('SELECT location_id FROM employees WHERE id = ?').get(shift.employee_id)?.location_id;
  const loc = locId ? db.prepare('SELECT * FROM locations WHERE id = ?').get(locId) : null;
  const geo = validate(geoSchema, body || {});
  const hasGeo = geo.lat != null && geo.lng != null;
  const hasLoc = loc && loc.latitude != null && loc.longitude != null;
  const dist = hasGeo && hasLoc ? distanceM(geo.lat, geo.lng, loc.latitude, loc.longitude) : null;
  if (loc?.require_location && hasLoc) {
    if (!hasGeo) throw badRequest(`ההחתמה בסניף ${loc.name} מחייבת שיתוף מיקום. אשר/י גישה למיקום בטלפון ונסה/י שוב.`, { code: 'location_required' });
    const slack = Math.min(geo.accuracy || 0, 100);
    if (dist > loc.radius_m + slack) throw badRequest(`נראה שאת/ה לא נמצא/ת בסניף ${loc.name} (מרחק ${dist} מ׳, מותר עד ${loc.radius_m} מ׳). יש להחתים מהסניף.`, { code: 'location_far' });
  }
  return dist;
}

const withAttendance = (rows, now = nowLocal()) => rows.map((s) => ({ ...s, ...computeAttendance(s, now) }));

function summarize(rows) {
  const count = (st) => rows.filter((r) => r.attendance_status === st).length;
  return {
    total: rows.length,
    not_started: count('not_started'),
    on_shift: count('on_shift'),
    finished: count('finished'),
    late: rows.filter((r) => r.is_late).length,
    absent: count('absent'),
  };
}

// ---------- daily board (managers) ----------
router.get('/', requirePerm('attendance.manage'), ah((req, res) => {
  const q = validate(z.object({ date: zDate.optional(), department_id: zOptId }), req.query);
  const date = q.date || todayLocal();
  const params = { from: `${date}T00:00`, to: `${addDays(date, 1)}T00:00` };
  let extra = '';
  if (q.department_id) { extra = 'AND e.department_id = @dep'; params.dep = q.department_id; }
  const scope = scopeSql(req);
  const rows = withAttendance(getDb().prepare(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS}
     WHERE s.status = 'scheduled' AND s.start_at >= @from AND s.start_at < @to ${extra} ${scope.sql} ORDER BY s.start_at, e.first_name`,
  ).all({ ...params, ...scope.params }));
  res.json({ date, rows, summary: summarize(rows), lead_scope: req.user.lead_scope || null });
}));

// ---------- my monthly hours slip (employee) ----------
router.get('/me/slip', requireEmployee, ah(async (req, res) => {
  const q = validate(z.object({ month: zMonth, format: z.enum(['xlsx', 'json']).default('json') }), req.query);
  if (!q.month) q.month = todayLocal().slice(0, 7);
  const { from, to } = monthRange(`${q.month}-01`);
  const data = buildPayroll({ from, to, employee_id: req.user.employee_id });
  if (q.format === 'xlsx') return sendWorkbook(res, await payrollWorkbook(data, { single: true, period: q.month }), `my_hours_${q.month}`);
  res.json(slipJson(data));
}));

// ---------- my attendance (employee) ----------
router.get('/me', requireEmployee, (req, res) => {
  const db = getDb();
  const now = nowLocal();
  const empId = req.user.employee_id;
  const active = withAttendance(db.prepare(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS}
     WHERE s.employee_id = ? AND s.status = 'scheduled' AND (
       (a.clock_in_at IS NOT NULL AND a.clock_out_at IS NULL AND s.end_at > ?) OR
       (s.start_at <= ? AND s.end_at > ?)
     ) ORDER BY s.start_at LIMIT 1`,
  ).all(empId, addMinutes(now, -240), addMinutes(now, EARLY_CLOCK_IN_MINUTES), now), now)[0] || null;
  const next = withAttendance(db.prepare(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS}
     WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.start_at > ? ORDER BY s.start_at LIMIT 1`,
  ).all(empId, now), now)[0] || null;
  const history = withAttendance(db.prepare(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS}
     WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.start_at >= ? AND s.start_at <= ? ORDER BY s.start_at DESC`,
  ).all(empId, `${addDays(todayLocal(), -30)}T00:00`, now), now);
  const sum = (k) => history.reduce((t, r) => t + r[k], 0);
  res.json({
    now, active, next, history,
    stats: {
      worked_minutes: sum('worked_minutes'), overtime_minutes: sum('overtime_minutes'),
      late_count: history.filter((r) => r.late_minutes > 0).length,
      absent_count: history.filter((r) => r.attendance_status === 'absent').length,
    },
  });
});

/** Branch managers and on-duty shift leads may only touch shifts inside their scope. */
function assertInScope(req, shiftId) {
  const scope = scopeSql(req);
  if (!scope.sql) return;
  const ok = getDb().prepare(`SELECT 1 FROM shifts s JOIN employees e ON e.id = s.employee_id WHERE s.id = @id ${scope.sql}`).get({ id: shiftId, ...scope.params });
  if (!ok) throw forbidden(req.user.lead_scope ? 'כאחמ״ש אפשר לעדכן רק את המשמרת שלך' : 'המשמרת שייכת לסניף אחר');
}

function upsertAttendance(shiftId, fields, userId) {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM attendance WHERE shift_id = ?').get(shiftId);
  if (exists) {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE attendance SET ${sets}, updated_by = @updated_by, updated_at = datetime('now') WHERE shift_id = @shift_id`)
      .run({ ...fields, updated_by: userId, shift_id: shiftId });
  } else {
    const cols = Object.keys(fields);
    db.prepare(`INSERT INTO attendance (shift_id, updated_by, ${cols.join(', ')}) VALUES (@shift_id, @updated_by, ${cols.map((c) => `@${c}`).join(', ')})`)
      .run({ ...fields, updated_by: userId, shift_id: shiftId });
  }
}

// ---------- clock in ----------
router.post('/clock-in', requireEmployee, ah((req, res) => {
  const now = nowLocal();
  const db = getDb();
  const shift = db.prepare(
    `SELECT s.* FROM shifts s LEFT JOIN attendance a ON a.shift_id = s.id
     WHERE s.employee_id = ? AND s.status = 'scheduled' AND a.clock_in_at IS NULL AND COALESCE(a.marked_absent, 0) = 0
       AND s.start_at <= ? AND s.end_at > ? ORDER BY s.start_at LIMIT 1`,
  ).get(req.user.employee_id, addMinutes(now, EARLY_CLOCK_IN_MINUTES), now);
  if (!shift) throw badRequest(`אין משמרת שניתן להתחיל כעת. ניתן להתחיל משמרת עד ${EARLY_CLOCK_IN_MINUTES} דקות לפני תחילתה.`);
  const dist = checkLocation(shift, req.body);
  upsertAttendance(shift.id, { clock_in_at: now, clock_in_distance_m: dist }, req.user.id);
  const full = withAttendance([getShift(shift.id)], now)[0];
  audit(req, { action: 'attendance.clock_in', entityType: 'shift', entityId: shift.id, description: `${full.employee_name} נכנס/ה למשמרת ב-${hhmm(now)}${full.late_minutes ? ` (איחור של ${full.late_minutes} דק׳)` : ''}`, newValue: { clock_in_at: now } });
  if (full.late_minutes > 0) {
    notifyPermission('attendance.manage', { type: 'employee_late', title: `${full.employee_name} איחר/ה למשמרת`, body: `נכנס/ה ב-${hhmm(now)} במקום ${hhmm(full.start_at)} (${full.late_minutes} דק׳)`, link: '/attendance' });
  }
  res.json({ shift: full, message: full.late_minutes ? `נרשמה כניסה למשמרת (איחור של ${full.late_minutes} דקות)` : 'נרשמה כניסה למשמרת. משמרת טובה!' });
}));

// ---------- clock out ----------
router.post('/clock-out', requireEmployee, ah((req, res) => {
  const now = nowLocal();
  const shift = getDb().prepare(
    `SELECT s.* FROM shifts s JOIN attendance a ON a.shift_id = s.id
     WHERE s.employee_id = ? AND a.clock_in_at IS NOT NULL AND a.clock_out_at IS NULL ORDER BY s.start_at DESC LIMIT 1`,
  ).get(req.user.employee_id);
  if (!shift) throw badRequest('לא נמצאה משמרת פתוחה לסיום');
  const dist = checkLocation(shift, req.body);
  upsertAttendance(shift.id, { clock_out_at: now, clock_out_distance_m: dist }, req.user.id);
  const full = withAttendance([getShift(shift.id)], now)[0];
  const h = (full.worked_minutes / 60).toFixed(1);
  audit(req, { action: 'attendance.clock_out', entityType: 'shift', entityId: shift.id, description: `${full.employee_name} סיים/ה משמרת ב-${hhmm(now)} (${h} שעות)`, newValue: { clock_out_at: now } });
  res.json({ shift: full, message: `המשמרת הסתיימה. עבדת ${h} שעות` });
}));

// ---------- manager correction ----------
router.put('/:shiftId', requirePerm('attendance.manage'), ah((req, res) => {
  const shiftId = paramId(req.params.shiftId);
  const before = getShift(shiftId);
  if (!before) throw notFound('המשמרת לא נמצאה');
  assertInScope(req, shiftId);
  const optDT = z.union([zDateTime, z.null(), z.literal('')]).optional().transform((v) => (v === '' || v == null ? null : v));
  const data = validate(z.object({
    clock_in_at: optDT, clock_out_at: optDT, marked_absent: z.boolean().optional().default(false), note: zOptText(500),
  }), req.body);
  if (data.clock_out_at && !data.clock_in_at) throw badRequest('לא ניתן להזין שעת יציאה ללא שעת כניסה');
  if (data.clock_out_at && data.clock_in_at && data.clock_out_at < data.clock_in_at) throw badRequest('שעת היציאה חייבת להיות אחרי שעת הכניסה');
  if (data.marked_absent) { data.clock_in_at = null; data.clock_out_at = null; }
  upsertAttendance(shiftId, { clock_in_at: data.clock_in_at, clock_out_at: data.clock_out_at, marked_absent: data.marked_absent ? 1 : 0, note: data.note }, req.user.id);
  const after = withAttendance([getShift(shiftId)])[0];
  audit(req, {
    action: 'attendance.update', entityType: 'shift', entityId: shiftId,
    description: `${req.user.display_name} עדכן/ה נוכחות של ${after.employee_name} למשמרת ${before.start_at.slice(0, 10)}`,
    oldValue: { clock_in_at: before.clock_in_at, clock_out_at: before.clock_out_at, marked_absent: !!before.marked_absent, note: before.attendance_note },
    newValue: { clock_in_at: data.clock_in_at, clock_out_at: data.clock_out_at, marked_absent: data.marked_absent, note: data.note },
  });
  res.json({ shift: after, message: 'הנוכחות עודכנה בהצלחה' });
}));

// ---------- incidents ----------
router.get('/incidents/list', requirePerm('incidents.report', 'attendance.manage'), (req, res) => {
  const rows = getDb().prepare(
    `SELECT i.*, u.display_name AS reported_by_name FROM incidents i LEFT JOIN users u ON u.id = i.reported_by
     ORDER BY i.occurred_at DESC LIMIT 100`,
  ).all();
  res.json({ incidents: rows });
});

router.post('/incidents', requirePerm('incidents.report'), ah((req, res) => {
  const data = validate(z.object({
    title: zText(120), description: zOptText(2000), severity: z.enum(['low', 'medium', 'high']).default('medium'),
    shift_id: zOptId, occurred_at: zDateTime.optional(),
  }), req.body);
  const occurred = data.occurred_at || nowLocal();
  const id = getDb().prepare('INSERT INTO incidents (shift_id, reported_by, title, description, severity, occurred_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(data.shift_id, req.user.id, data.title, data.description, data.severity, occurred).lastInsertRowid;
  audit(req, { action: 'incident.create', entityType: 'incident', entityId: id, description: `${req.user.display_name} דיווח/ה על אירוע: ${data.title}`, newValue: data });
  if (data.severity === 'high') notifyPermission('settings.manage', { type: 'incident', title: 'דווח אירוע בחומרה גבוהה', body: data.title, link: '/attendance' }, { exceptUserId: req.user.id });
  res.status(201).json({ id, message: 'האירוע דווח בהצלחה' });
}));

export default router;
