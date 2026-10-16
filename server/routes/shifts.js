import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, conflict, notFound, forbidden } from '../lib/errors.js';
import { validate, z, zDate, zTime, zOptId, zOptText, zId, paramId } from '../lib/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { SHIFT_COLUMNS, SHIFT_JOINS } from '../lib/serialize.js';
import { computeAttendance } from '../lib/attendance.js';
import { addDays, nowLocal, hhmm, toMs, fromMs } from '../lib/time.js';
import { audit } from '../services/audit.js';
import { notifyEmployee } from '../services/notify.js';

const router = Router();

const fmtDate = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
// LRI…PDI isolates keep "09:00–17:00" in the right order inside Hebrew (RTL) sentences
const ltr = (t) => `\u2066${t}\u2069`;
const describeShift = (s) => `${fmtDate(s.start_at)} ${ltr(`${hhmm(s.start_at)}–${hhmm(s.end_at)}`)}`;

/** Build start/end from a date + times. End <= start means the shift ends the next day. */
function buildRange(date, start, end) {
  const start_at = `${date}T${start}`;
  const end_at = end <= start ? `${addDays(date, 1)}T${end}` : `${date}T${end}`;
  if ((toMs(end_at) - toMs(start_at)) / 3600000 > 16) throw badRequest('משמרת לא יכולה להיות ארוכה מ-16 שעות');
  return { start_at, end_at };
}

export function getShift(id) {
  return getDb().prepare(`SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS} WHERE s.id = ?`).get(id);
}

/**
 * Detect scheduling problems for an employee in a time range:
 * overlapping shifts, approved leave, inactive / on-vacation status.
 */
export function findConflicts(employeeId, startAt, endAt, excludeId = 0) {
  const db = getDb();
  const emp = db.prepare("SELECT id, first_name || ' ' || last_name AS name, status FROM employees WHERE id = ?").get(employeeId);
  if (!emp) throw badRequest('העובד שנבחר לא קיים');
  const out = [];
  const overlaps = db.prepare(
    `SELECT id, start_at, end_at FROM shifts WHERE employee_id = ? AND status = 'scheduled' AND id != ?
     AND start_at < ? AND end_at > ?`,
  ).all(employeeId, excludeId, endAt, startAt);
  for (const o of overlaps) {
    out.push({ type: 'overlap', employee_id: employeeId, employee_name: emp.name, shift_id: o.id,
      message: `${emp.name} כבר משובץ/ת במשמרת ${describeShift(o)}` });
  }
  const leave = db.prepare(
    `SELECT type, start_date, COALESCE(end_date, start_date) AS end_date FROM requests
     WHERE employee_id = ? AND status = 'approved' AND type IN ('vacation','day_off')
     AND start_date <= ? AND COALESCE(end_date, start_date) >= ?`,
  ).get(employeeId, endAt.slice(0, 10), startAt.slice(0, 10));
  if (leave) out.push({ type: 'leave', employee_id: employeeId, employee_name: emp.name, message: `ל${emp.name} יש ${leave.type === 'vacation' ? 'חופשה' : 'יום חופש'} מאושר/ת בתאריך זה` });
  if (emp.status !== 'active') out.push({ type: 'status', employee_id: employeeId, employee_name: emp.name, message: `${emp.name} מסומן/ת כ${emp.status === 'vacation' ? 'בחופשה' : 'לא פעיל/ה'}` });
  return out;
}

const withAttendance = (rows) => {
  const now = nowLocal();
  return rows.map((s) => ({ ...s, ...computeAttendance(s, now) }));
};

// ---------- list ----------
router.get('/', ah((req, res) => {
  const q = validate(z.object({
    from: zDate, to: zDate, employee_id: zOptId, department_id: zOptId, location_id: zOptId,
    include_cancelled: z.enum(['0', '1']).optional(),
  }), req.query);
  if (addDays(q.from, 62) < q.to) throw badRequest('טווח התאריכים ארוך מדי');
  const where = ['s.start_at >= @from', 's.start_at < @to'];
  const params = { from: `${q.from}T00:00`, to: `${addDays(q.to, 1)}T00:00` };
  if (!req.can('shifts.view_all')) {
    if (!req.user.employee_id) return res.json({ shifts: [] });
    where.push('s.employee_id = @own'); params.own = req.user.employee_id;
  } else if (q.employee_id) { where.push('s.employee_id = @employee_id'); params.employee_id = q.employee_id; }
  if (q.department_id) { where.push('e.department_id = @department_id'); params.department_id = q.department_id; }
  if (q.location_id) { where.push('s.location_id = @location_id'); params.location_id = q.location_id; }
  if (q.include_cancelled !== '1') where.push("s.status = 'scheduled'");
  const rows = getDb().prepare(`SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS} WHERE ${where.join(' AND ')} ORDER BY s.start_at, e.first_name`).all(params);
  res.json({ shifts: withAttendance(rows) });
}));

router.get('/:id', ah((req, res) => {
  const s = getShift(paramId(req.params.id));
  if (!s) throw notFound('המשמרת לא נמצאה');
  if (!req.can('shifts.view_all') && s.employee_id !== req.user.employee_id) throw forbidden();
  res.json({ shift: withAttendance([s])[0] });
}));

const baseShift = {
  date: zDate, start_time: zTime, end_time: zTime,
  position_id: zOptId, location_id: zOptId, note: zOptText(500), force: z.boolean().optional().default(false),
};

// ---------- create (one or many employees) ----------
router.post('/', requirePerm('shifts.manage'), ah((req, res) => {
  const data = validate(z.object({ ...baseShift, employee_ids: z.array(zId).min(1, 'יש לבחור לפחות עובד אחד').max(100) }), req.body);
  const ids = [...new Set(data.employee_ids)];
  const { start_at, end_at } = buildRange(data.date, data.start_time, data.end_time);
  const conflicts = ids.flatMap((id) => findConflicts(id, start_at, end_at));
  if (conflicts.length && !data.force) throw conflict('נמצאו התנגשויות בשיבוץ', { conflicts });
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO shifts (employee_id, start_at, end_at, position_id, location_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const created = db.transaction(() => ids.map((empId) => {
    const id = ins.run(empId, start_at, end_at, data.position_id, data.location_id, data.note, req.user.id).lastInsertRowid;
    const s = getShift(id);
    audit(req, { action: 'shift.create', entityType: 'shift', entityId: id, description: `${req.user.display_name} שיבץ/ה את ${s.employee_name} למשמרת ${describeShift(s)}`, newValue: { start_at, end_at, position: s.position_name, location: s.location_name } });
    notifyEmployee(empId, { type: 'shift_assigned', title: 'שובצת למשמרת חדשה', body: `${describeShift(s)}${s.location_name ? ` · ${s.location_name}` : ''}`, link: '/shifts' });
    return s;
  }))();
  res.status(201).json({ shifts: withAttendance(created), message: created.length > 1 ? `${created.length} משמרות נשמרו בהצלחה` : 'המשמרת נשמרה בהצלחה' });
}));

// ---------- update / move ----------
router.put('/:id', requirePerm('shifts.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const before = getShift(id);
  if (!before) throw notFound('המשמרת לא נמצאה');
  if (before.status === 'cancelled') throw badRequest('לא ניתן לערוך משמרת שבוטלה');
  const data = validate(z.object({ ...baseShift, employee_id: zId }), req.body);
  const { start_at, end_at } = buildRange(data.date, data.start_time, data.end_time);
  const conflicts = findConflicts(data.employee_id, start_at, end_at, id);
  if (conflicts.length && !data.force) throw conflict('נמצאו התנגשויות בשיבוץ', { conflicts });
  getDb().prepare(
    `UPDATE shifts SET employee_id=?, start_at=?, end_at=?, position_id=?, location_id=?, note=?, updated_at=datetime('now') WHERE id=?`,
  ).run(data.employee_id, start_at, end_at, data.position_id, data.location_id, data.note, id);
  const after = getShift(id);

  const changes = [];
  if (before.employee_id !== after.employee_id) changes.push(`העביר/ה את המשמרת מ${before.employee_name} ל${after.employee_name}`);
  if (before.start_at !== after.start_at || before.end_at !== after.end_at) changes.push(`שינה/תה את המשמרת של ${after.employee_name} מ-${describeShift(before)} ל-${describeShift(after)}`);
  if (before.position_id !== after.position_id || before.location_id !== after.location_id || before.note !== after.note) changes.push(`עדכן/ה פרטי משמרת של ${after.employee_name}`);
  if (changes.length) {
    audit(req, {
      action: 'shift.update', entityType: 'shift', entityId: id, description: `${req.user.display_name} ${changes.join(', ')}`,
      oldValue: { employee: before.employee_name, start_at: before.start_at, end_at: before.end_at, position: before.position_name, location: before.location_name, note: before.note },
      newValue: { employee: after.employee_name, start_at: after.start_at, end_at: after.end_at, position: after.position_name, location: after.location_name, note: after.note },
    });
    if (before.employee_id !== after.employee_id) {
      notifyEmployee(before.employee_id, { type: 'shift_cancelled', title: 'משמרת הוסרה מהסידור שלך', body: describeShift(before), link: '/shifts' });
      notifyEmployee(after.employee_id, { type: 'shift_assigned', title: 'שובצת למשמרת חדשה', body: describeShift(after), link: '/shifts' });
    } else {
      notifyEmployee(after.employee_id, { type: 'shift_changed', title: 'משמרת שלך השתנתה', body: `${describeShift(before)} ← ${describeShift(after)}`, link: '/shifts' });
    }
  }
  res.json({ shift: withAttendance([after])[0], message: 'המשמרת עודכנה בהצלחה' });
}));

// ---------- cancel ----------
router.delete('/:id', requirePerm('shifts.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const s = getShift(id);
  if (!s) throw notFound('המשמרת לא נמצאה');
  if (s.clock_in_at) throw badRequest('לא ניתן לבטל משמרת שהעובד כבר החל בה');
  getDb().prepare("UPDATE shifts SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(id);
  audit(req, { action: 'shift.cancel', entityType: 'shift', entityId: id, description: `${req.user.display_name} ביטל/ה את המשמרת של ${s.employee_name} (${describeShift(s)})`, oldValue: { status: 'scheduled' }, newValue: { status: 'cancelled' } });
  notifyEmployee(s.employee_id, { type: 'shift_cancelled', title: 'משמרת בוטלה', body: describeShift(s), link: '/shifts' });
  res.json({ ok: true, message: 'המשמרת בוטלה' });
}));

// ---------- duplicate one shift ----------
router.post('/:id/duplicate', requirePerm('shifts.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const src = getShift(id);
  if (!src) throw notFound('המשמרת לא נמצאה');
  const data = validate(z.object({ date: zDate, employee_id: zOptId, force: z.boolean().optional().default(false) }), req.body);
  const employeeId = data.employee_id || src.employee_id;
  const duration = toMs(src.end_at) - toMs(src.start_at);
  const start_at = `${data.date}T${hhmm(src.start_at)}`;
  const end_at = fromMs(toMs(start_at) + duration);
  const conflicts = findConflicts(employeeId, start_at, end_at);
  if (conflicts.length && !data.force) throw conflict('נמצאו התנגשויות בשיבוץ', { conflicts });
  const newId = getDb().prepare(
    'INSERT INTO shifts (employee_id, start_at, end_at, position_id, location_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(employeeId, start_at, end_at, src.position_id, src.location_id, src.note, req.user.id).lastInsertRowid;
  const s = getShift(newId);
  audit(req, { action: 'shift.duplicate', entityType: 'shift', entityId: newId, description: `${req.user.display_name} שכפל/ה משמרת של ${s.employee_name} ל-${describeShift(s)}`, newValue: { start_at, end_at } });
  notifyEmployee(employeeId, { type: 'shift_assigned', title: 'שובצת למשמרת חדשה', body: describeShift(s), link: '/shifts' });
  res.status(201).json({ shift: withAttendance([s])[0], message: 'המשמרת שוכפלה בהצלחה' });
}));

// ---------- copy a whole week ----------
router.post('/copy-week', requirePerm('shifts.manage'), ah((req, res) => {
  const data = validate(z.object({ source_week_start: zDate, target_week_start: zDate }), req.body);
  if (data.source_week_start === data.target_week_start) throw badRequest('יש לבחור שבוע יעד שונה משבוע המקור');
  const db = getDb();
  const src = db.prepare(
    "SELECT * FROM shifts WHERE status = 'scheduled' AND start_at >= ? AND start_at < ? ORDER BY start_at",
  ).all(`${data.source_week_start}T00:00`, `${addDays(data.source_week_start, 7)}T00:00`);
  if (!src.length) throw badRequest('אין משמרות בשבוע המקור');
  const offset = toMs(data.target_week_start) - toMs(data.source_week_start);
  const ins = db.prepare('INSERT INTO shifts (employee_id, start_at, end_at, position_id, location_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const result = db.transaction(() => {
    let created = 0;
    const skipped = [];
    const notified = new Set();
    for (const s of src) {
      const start_at = fromMs(toMs(s.start_at) + offset);
      const end_at = fromMs(toMs(s.end_at) + offset);
      const c = findConflicts(s.employee_id, start_at, end_at).filter((x) => x.type !== 'status');
      if (c.length) { skipped.push(...c); continue; }
      ins.run(s.employee_id, start_at, end_at, s.position_id, s.location_id, s.note, req.user.id);
      created += 1;
      notified.add(s.employee_id);
    }
    for (const empId of notified) notifyEmployee(empId, { type: 'shift_assigned', title: 'פורסם סידור עבודה לשבוע חדש', body: `שבוע שמתחיל ב-${fmtDate(data.target_week_start + 'T')}`, link: '/shifts' });
    audit(req, { action: 'shift.copy_week', entityType: 'shift', description: `${req.user.display_name} שכפל/ה את סידור השבוע ${data.source_week_start} לשבוע ${data.target_week_start} (${created} משמרות)`, newValue: { created, skipped: skipped.length } });
    return { created, skipped };
  })();
  res.json({ ...result, message: `${result.created} משמרות שוכפלו${result.skipped.length ? `, ${result.skipped.length} דולגו עקב התנגשות` : ''}` });
}));

export default router;
