// Preference-based weekly scheduling:
//   employees submit preferences per day + shift type → an authorized manager assigns people
//   and marks the shift lead (אחמ"ש) → publishing turns the board into real shifts.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, notFound } from '../lib/errors.js';
import { validate, z, zDate, zTime, zId, zOptText, paramId } from '../lib/validate.js';
import { requirePerm, requireEmployee } from '../middleware/auth.js';
import { addDays, startOfWeek, todayLocal, weekday, nowLocal } from '../lib/time.js';
import { audit } from '../services/audit.js';
import { notifyEmployee, notifyPermission } from '../services/notify.js';

const router = Router();
const fmt = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const weekDays = (ws) => Array.from({ length: 7 }, (_, i) => addDays(ws, i));

/** Normalize any date to the Sunday that starts its week. */
function parseWeek(value) {
  const d = value ? validate(zDate, value) : addDays(startOfWeek(todayLocal()), 7); // default: next week
  return startOfWeek(d);
}

/** Start/end of a shift type on a given date (end <= start means it ends the next day). */
export function typeRange(type, date) {
  const start_at = `${date}T${type.start_time}`;
  const end_at = type.end_time <= type.start_time ? `${addDays(date, 1)}T${type.end_time}` : `${date}T${type.end_time}`;
  return { start_at, end_at };
}

const activeTypes = () => getDb().prepare('SELECT * FROM shift_types WHERE is_active = 1 ORDER BY sort_order, start_time, id').all();

function weekState(ws) {
  return getDb().prepare('SELECT * FROM schedule_weeks WHERE week_start = ?').get(ws) || { week_start: ws, status: 'draft', published_at: null };
}

// ======================= shift types =======================
router.get('/shift-types', (req, res) => {
  const all = req.query.all === '1' && req.can('schedule.manage');
  res.json({ types: all ? getDb().prepare('SELECT * FROM shift_types ORDER BY is_active DESC, sort_order, start_time, id').all() : activeTypes() });
});

const typeSchema = z.object({
  name: z.string().trim().min(1, 'שדה חובה').max(40),
  start_time: zTime,
  end_time: zTime,
  sort_order: z.coerce.number().int().min(0).max(99).default(0),
  is_active: z.boolean().default(true),
});

router.post('/shift-types', requirePerm('schedule.manage'), ah((req, res) => {
  const t = validate(typeSchema, req.body);
  if (t.start_time === t.end_time) throw badRequest('שעת הסיום חייבת להיות שונה משעת ההתחלה', { fields: { end_time: 'זהה לשעת ההתחלה' } });
  const id = getDb().prepare('INSERT INTO shift_types (name, start_time, end_time, sort_order, is_active) VALUES (?, ?, ?, ?, ?)')
    .run(t.name, t.start_time, t.end_time, t.sort_order, t.is_active ? 1 : 0).lastInsertRowid;
  audit(req, { action: 'shift_type.create', entityType: 'shift_type', entityId: id, description: `${req.user.display_name} הגדיר/ה משמרת "${t.name}" ${t.start_time}–${t.end_time}`, newValue: t });
  res.status(201).json({ id, message: 'המשמרת נוספה' });
}));

router.put('/shift-types/:id', requirePerm('schedule.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const db = getDb();
  const before = db.prepare('SELECT * FROM shift_types WHERE id = ?').get(id);
  if (!before) throw notFound('המשמרת לא נמצאה');
  const t = validate(typeSchema, req.body);
  if (t.start_time === t.end_time) throw badRequest('שעת הסיום חייבת להיות שונה משעת ההתחלה', { fields: { end_time: 'זהה לשעת ההתחלה' } });
  db.prepare('UPDATE shift_types SET name = ?, start_time = ?, end_time = ?, sort_order = ?, is_active = ? WHERE id = ?')
    .run(t.name, t.start_time, t.end_time, t.sort_order, t.is_active ? 1 : 0, id);
  audit(req, {
    action: 'shift_type.update', entityType: 'shift_type', entityId: id,
    description: `${req.user.display_name} עדכן/ה את המשמרת "${t.name}" (${before.start_time}–${before.end_time} → ${t.start_time}–${t.end_time})`,
    oldValue: before, newValue: t,
  });
  res.json({ message: 'המשמרת עודכנה. השינוי יחול על סידורים שיפורסמו מעכשיו.' });
}));

// ======================= employee: my preferences =======================
router.get('/my', requireEmployee, (req, res) => {
  const ws = parseWeek(req.query.week);
  const db = getDb();
  const prefs = db.prepare(
    'SELECT date, shift_type_id, preference FROM shift_preferences WHERE employee_id = ? AND date BETWEEN ? AND ?',
  ).all(req.user.employee_id, ws, addDays(ws, 6));
  const sub = db.prepare('SELECT note, submitted_at FROM schedule_submissions WHERE employee_id = ? AND week_start = ?').get(req.user.employee_id, ws);
  const state = weekState(ws);
  res.json({
    week_start: ws, days: weekDays(ws), types: activeTypes(), prefs, note: sub?.note || '', submitted_at: sub?.submitted_at || null,
    status: state.status, locked: state.status === 'published' || addDays(ws, 6) < todayLocal(),
  });
});

router.put('/my', requireEmployee, ah((req, res) => {
  const body = validate(z.object({
    week_start: zDate,
    note: zOptText(500),
    prefs: z.array(z.object({
      date: zDate, shift_type_id: zId, preference: z.enum(['preferred', 'available', 'unavailable']),
    })).max(7 * 10),
  }), req.body);
  const ws = startOfWeek(body.week_start);
  const state = weekState(ws);
  if (state.status === 'published') throw badRequest('הסידור לשבוע זה כבר פורסם. לשינויים פנו למנהל.');
  if (addDays(ws, 6) < todayLocal()) throw badRequest('לא ניתן להגיש זמינות לשבוע שעבר');
  const days = new Set(weekDays(ws));
  const typeIds = new Set(activeTypes().map((t) => t.id));
  for (const p of body.prefs) {
    if (!days.has(p.date) || !typeIds.has(p.shift_type_id)) throw badRequest('נתוני זמינות לא תקינים');
  }
  const db = getDb();
  const emp = req.user.employee_id;
  const first = !db.prepare('SELECT 1 FROM schedule_submissions WHERE employee_id = ? AND week_start = ?').get(emp, ws);
  db.transaction(() => {
    db.prepare('DELETE FROM shift_preferences WHERE employee_id = ? AND date BETWEEN ? AND ?').run(emp, ws, addDays(ws, 6));
    const ins = db.prepare('INSERT INTO shift_preferences (employee_id, date, shift_type_id, preference) VALUES (?, ?, ?, ?)');
    for (const p of body.prefs) ins.run(emp, p.date, p.shift_type_id, p.preference);
    db.prepare(
      `INSERT INTO schedule_submissions (employee_id, week_start, note, submitted_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(employee_id, week_start) DO UPDATE SET note = excluded.note, submitted_at = excluded.submitted_at`,
    ).run(emp, ws, body.note);
  })();
  audit(req, { action: 'schedule.submit', entityType: 'employee', entityId: emp, description: `${req.user.display_name} הגיש/ה זמינות לשבוע ${fmt(ws)}`, newValue: { week_start: ws, count: body.prefs.length } });
  if (first) notifyPermission('schedule.manage', { type: 'availability', title: 'הוגשה זמינות לשבוע הבא', body: `${req.user.display_name} · שבוע ${fmt(ws)}`, link: `/schedule?tab=board&week=${ws}` }, { exceptUserId: req.user.id });
  res.json({ message: 'הזמינות נשמרה. תודה!' });
}));

// ======================= manager: board =======================
router.get('/board', requirePerm('schedule.manage'), (req, res) => {
  const ws = parseWeek(req.query.week);
  const db = getDb();
  const end = addDays(ws, 6);
  const employees = db.prepare(
    `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.avatar, p.name AS position_name, d.name AS department_name,
            s.submitted_at, s.note
     FROM employees e LEFT JOIN positions p ON p.id = e.position_id LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN schedule_submissions s ON s.employee_id = e.id AND s.week_start = ?
     WHERE e.status = 'active' ORDER BY e.first_name, e.last_name`,
  ).all(ws);
  // Approved leave in this week, so the manager sees it on the board
  const leave = db.prepare(
    `SELECT employee_id, start_date, COALESCE(end_date, start_date) AS end_date FROM requests
     WHERE status = 'approved' AND type IN ('vacation','day_off') AND start_date <= ? AND COALESCE(end_date, start_date) >= ?`,
  ).all(end, ws);
  res.json({
    week_start: ws,
    days: weekDays(ws),
    types: activeTypes(),
    employees,
    prefs: db.prepare('SELECT employee_id, date, shift_type_id, preference FROM shift_preferences WHERE date BETWEEN ? AND ?').all(ws, end),
    assignments: db.prepare('SELECT date, shift_type_id, employee_id, is_lead FROM schedule_assignments WHERE date BETWEEN ? AND ?').all(ws, end),
    leave,
    // shifts added manually in the calendar, so the board can warn about double booking
    busy: db.prepare(
      `SELECT employee_id, start_at, end_at FROM shifts
       WHERE status = 'scheduled' AND shift_type_id IS NULL AND start_at >= ? AND start_at < ?`,
    ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`),
    state: weekState(ws),
  });
});

const assignmentsSchema = z.object({
  week_start: zDate,
  assignments: z.array(z.object({ date: zDate, shift_type_id: zId, employee_id: zId, is_lead: z.boolean().default(false) })).max(2000),
});

function saveAssignments(ws, list) {
  const db = getDb();
  const days = new Set(weekDays(ws));
  const typeIds = new Set(activeTypes().map((t) => t.id));
  const active = new Set(db.prepare("SELECT id FROM employees WHERE status = 'active'").all().map((e) => e.id));
  const leads = new Map();
  for (const a of list) {
    if (!days.has(a.date)) throw badRequest('תאריך מחוץ לשבוע שנבחר');
    if (!typeIds.has(a.shift_type_id)) throw badRequest('משמרת לא קיימת');
    if (!active.has(a.employee_id)) throw badRequest('אחד העובדים שנבחרו אינו פעיל');
    if (a.is_lead) {
      const k = `${a.date}|${a.shift_type_id}`;
      if (leads.has(k)) throw badRequest(`אפשר לסמן רק אחמ"ש אחד למשמרת (${fmt(a.date)})`);
      leads.set(k, a.employee_id);
    }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM schedule_assignments WHERE date BETWEEN ? AND ?').run(ws, addDays(ws, 6));
    const ins = db.prepare('INSERT OR REPLACE INTO schedule_assignments (date, shift_type_id, employee_id, is_lead) VALUES (?, ?, ?, ?)');
    for (const a of list) ins.run(a.date, a.shift_type_id, a.employee_id, a.is_lead ? 1 : 0);
    db.prepare(
      `INSERT INTO schedule_weeks (week_start, status, updated_at) VALUES (?, 'draft', datetime('now'))
       ON CONFLICT(week_start) DO UPDATE SET status = 'draft', updated_at = excluded.updated_at`,
    ).run(ws);
  })();
}

router.put('/board', requirePerm('schedule.manage'), ah((req, res) => {
  const body = validate(assignmentsSchema, req.body);
  const ws = startOfWeek(body.week_start);
  saveAssignments(ws, body.assignments);
  res.json({ state: weekState(ws), message: 'הטיוטה נשמרה' });
}));

/** Publish: turn the board into real shifts (create / update / cancel) and notify employees. */
router.post('/publish', requirePerm('schedule.manage'), ah((req, res) => {
  const body = validate(assignmentsSchema, req.body);
  const ws = startOfWeek(body.week_start);
  if (addDays(ws, 6) < todayLocal()) throw badRequest('לא ניתן לפרסם סידור לשבוע שעבר');
  saveAssignments(ws, body.assignments);
  const db = getDb();
  const types = new Map(activeTypes().map((t) => [t.id, t]));
  const now = nowLocal();
  const stats = { created: 0, updated: 0, cancelled: 0, kept: 0 };
  const touched = new Set();

  db.transaction(() => {
    const existing = db.prepare(
      `SELECT s.*, a.clock_in_at FROM shifts s LEFT JOIN attendance a ON a.shift_id = s.id
       WHERE s.shift_type_id IS NOT NULL AND s.status = 'scheduled' AND s.start_at >= ? AND s.start_at < ?`,
    ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`);
    const key = (emp, date, type) => `${emp}|${date}|${type}`;
    const byKey = new Map(existing.map((s) => [key(s.employee_id, s.start_at.slice(0, 10), s.shift_type_id), s]));
    const wanted = new Set();
    const insert = db.prepare(
      'INSERT INTO shifts (employee_id, start_at, end_at, shift_type_id, is_lead, position_id, location_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const a of body.assignments) {
      const type = types.get(a.shift_type_id);
      const { start_at, end_at } = typeRange(type, a.date);
      const k = key(a.employee_id, a.date, a.shift_type_id);
      wanted.add(k);
      const cur = byKey.get(k);
      if (cur) {
        if (cur.start_at !== start_at || cur.end_at !== end_at || !!cur.is_lead !== !!a.is_lead) {
          db.prepare("UPDATE shifts SET start_at = ?, end_at = ?, is_lead = ?, updated_at = datetime('now') WHERE id = ?")
            .run(cur.clock_in_at ? cur.start_at : start_at, cur.clock_in_at ? cur.end_at : end_at, a.is_lead ? 1 : 0, cur.id);
          stats.updated += 1;
          touched.add(a.employee_id);
        }
      } else {
        // A shift entered manually with exactly these hours is adopted instead of duplicated
        const manual = db.prepare(
          "SELECT id FROM shifts WHERE employee_id = ? AND status = 'scheduled' AND shift_type_id IS NULL AND start_at = ? AND end_at = ?",
        ).get(a.employee_id, start_at, end_at);
        if (manual) {
          db.prepare("UPDATE shifts SET shift_type_id = ?, is_lead = ?, updated_at = datetime('now') WHERE id = ?").run(a.shift_type_id, a.is_lead ? 1 : 0, manual.id);
          stats.updated += 1;
        } else {
          const emp = db.prepare('SELECT position_id, location_id FROM employees WHERE id = ?').get(a.employee_id);
          insert.run(a.employee_id, start_at, end_at, a.shift_type_id, a.is_lead ? 1 : 0, emp.position_id, emp.location_id, req.user.id);
          stats.created += 1;
        }
        touched.add(a.employee_id);
      }
    }
    for (const s of existing) {
      if (wanted.has(key(s.employee_id, s.start_at.slice(0, 10), s.shift_type_id))) continue;
      if (s.clock_in_at || s.end_at <= now) { stats.kept += 1; continue; } // never touch worked / past shifts
      db.prepare("UPDATE shifts SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(s.id);
      stats.cancelled += 1;
      touched.add(s.employee_id);
    }
    db.prepare("UPDATE schedule_weeks SET status = 'published', published_at = datetime('now'), published_by = ? WHERE week_start = ?").run(req.user.id, ws);
  })();

  // Overlapping shifts for the same person (e.g. a manual shift at other hours)
  const warnings = db.prepare(
    `SELECT DISTINCT e.first_name || ' ' || e.last_name AS name, s1.start_at
     FROM shifts s1 JOIN shifts s2 ON s2.employee_id = s1.employee_id AND s2.id > s1.id
       AND s2.status = 'scheduled' AND s2.start_at < s1.end_at AND s2.end_at > s1.start_at
     JOIN employees e ON e.id = s1.employee_id
     WHERE s1.status = 'scheduled' AND s1.start_at >= ? AND s1.start_at < ?
     ORDER BY s1.start_at`,
  ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`).map((w) => `${w.name} – ${fmt(w.start_at)}: שתי משמרות חופפות`);

  const allAssigned = new Set(body.assignments.map((a) => a.employee_id));
  for (const emp of allAssigned) {
    const mine = body.assignments.filter((a) => a.employee_id === emp).length;
    notifyEmployee(emp, { type: 'shift_assigned', title: `סידור העבודה לשבוע ${fmt(ws)} פורסם`, body: `שובצת ל-${mine} משמרות`, link: `/schedule?week=${ws}` });
  }
  for (const emp of touched) {
    if (!allAssigned.has(emp)) notifyEmployee(emp, { type: 'shift_cancelled', title: `עודכן סידור העבודה לשבוע ${fmt(ws)}`, body: 'אינך משובץ/ת השבוע', link: `/schedule?week=${ws}` });
  }
  audit(req, {
    action: 'schedule.publish', entityType: 'schedule', description: `${req.user.display_name} אישר/ה ופרסם/ה את סידור העבודה לשבוע ${fmt(ws)}`,
    newValue: { week_start: ws, assignments: body.assignments.length, ...stats },
  });
  res.json({ state: weekState(ws), stats, warnings, message: 'הסידור אושר ופורסם לעובדים' });
}));

// ======================= published schedule (everyone) =======================
router.get('/published', ah((req, res) => {
  const ws = req.query.week ? startOfWeek(validate(zDate, req.query.week)) : startOfWeek(todayLocal());
  const db = getDb();
  const rows = db.prepare(
    `SELECT s.id, s.employee_id, s.start_at, s.end_at, s.shift_type_id, s.is_lead, st.name AS type_name, st.sort_order,
            e.first_name || ' ' || e.last_name AS employee_name, e.avatar, p.name AS position_name
     FROM shifts s JOIN employees e ON e.id = s.employee_id
     LEFT JOIN shift_types st ON st.id = s.shift_type_id LEFT JOIN positions p ON p.id = e.position_id
     WHERE s.status = 'scheduled' AND s.start_at >= ? AND s.start_at < ?
     ORDER BY s.start_at, s.is_lead DESC, e.first_name`,
  ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`);
  // Shifts added manually in the calendar are grouped under a shift type when their hours match it exactly
  const types = activeTypes();
  const matchType = (r) => types.find((t) => {
    const { start_at, end_at } = typeRange(t, r.start_at.slice(0, 10));
    return start_at === r.start_at && end_at === r.end_at;
  });
  const days = weekDays(ws).map((date) => {
    const groups = new Map();
    for (const r of rows.filter((x) => x.start_at.startsWith(date))) {
      const type = r.shift_type_id ? { id: r.shift_type_id, name: r.type_name, sort_order: r.sort_order } : matchType(r);
      const k = type ? `t${type.id}` : `m${r.start_at}|${r.end_at}`;
      if (!groups.has(k)) {
        groups.set(k, {
          key: k, name: type?.name || 'משמרת', start_at: r.start_at, end_at: r.end_at, sort: type?.sort_order ?? 99, workers: [],
        });
      }
      groups.get(k).workers.push({
        shift_id: r.id, employee_id: r.employee_id, name: r.employee_name, avatar: r.avatar, position_name: r.position_name,
        is_lead: !!r.is_lead, is_me: r.employee_id === req.user.employee_id,
      });
    }
    return { date, weekday: weekday(date), shifts: [...groups.values()].sort((a, b) => a.start_at.localeCompare(b.start_at) || a.sort - b.sort) };
  });
  res.json({ week_start: ws, state: weekState(ws), days });
}));

export default router;
