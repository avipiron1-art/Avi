// Preference-based weekly scheduling:
//   employees submit preferences per day + shift type → an authorized manager assigns people
//   and marks the shift lead (אחמ"ש) → publishing turns the board into real shifts.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zDate, zTime, zId, zOptText, paramId } from '../lib/validate.js';
import { requirePerm, requireEmployee } from '../middleware/auth.js';
import { addDays, startOfWeek, todayLocal, weekday, nowLocal } from '../lib/time.js';
import { audit } from '../services/audit.js';
import { notifyEmployee, notifyPermission } from '../services/notify.js';
import { locationInScope, scopeBranches, scopeWhere } from '../services/scope.js';

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

/**
 * Shift types used in a branch: the chain's shared types (unless the branch hid them) + the branch's own types.
 * loc 0 (no branches) = the shared types.
 */
function typesFor(loc = 0, { includeInactive = false } = {}) {
  const active = includeInactive ? '' : 'AND t.is_active = 1';
  return getDb().prepare(
    `SELECT t.*, CASE WHEN t.location_id IS NULL THEN 1 ELSE 0 END AS shared FROM shift_types t
     WHERE ((t.location_id IS NULL AND NOT EXISTS (SELECT 1 FROM shift_type_hidden h WHERE h.shift_type_id = t.id AND h.location_id = @loc))
        OR t.location_id = @loc) ${active}
     ORDER BY t.sort_order, t.start_time, t.id`,
  ).all({ loc: Number(loc) || -1 });
}
/** Every shift type by id (for names in messages / other branches). */
const allTypes = () => new Map(getDb().prepare('SELECT * FROM shift_types').all().map((t) => [t.id, t]));
/** Types an employee can give preferences for: those of every branch they work in. */
function typesForEmployee(employeeId) {
  const branches = employeeBranches(employeeId);
  if (!branches.length) return typesFor(0);
  const map = new Map();
  for (const b of branches) for (const t of typesFor(b.id)) if (!map.has(t.id)) map.set(t.id, t);
  return [...map.values()].sort((a, b) => a.sort_order - b.sort_order || a.start_time.localeCompare(b.start_time));
}

// ---------- branches ----------
// Each branch has its own board, staffing and publishing. loc 0 = a business without branches.
const hasBranches = () => !!getDb().prepare('SELECT 1 FROM locations LIMIT 1').get();

/** Branches an employee works in (home + extra). */
function employeeBranches(employeeId) {
  const db = getDb();
  const home = db.prepare('SELECT location_id FROM employees WHERE id = ?').get(employeeId)?.location_id;
  const extra = db.prepare('SELECT location_id FROM employee_locations WHERE employee_id = ?').all(employeeId).map((r) => r.location_id);
  const ids = [...new Set([home, ...extra].filter(Boolean))];
  return ids.length ? db.prepare(`SELECT id, name FROM locations WHERE id IN (${ids.join(',')}) ORDER BY id = ${Number(home) || 0} DESC, name`).all() : [];
}

/** Branch a manager works on: the requested one if it's in their scope, else their first branch. */
function managerBranch(req, requested) {
  if (!hasBranches()) return { loc: 0, branches: [] };
  const branches = scopeBranches(req.user.scope);
  const want = Number(requested) || 0;
  const pick = branches.find((b) => b.id === want) || branches[0];
  if (!pick) throw forbidden('לא הוגדר לך סניף. פנו למנהל הראשי.');
  return { loc: pick.id, branches };
}

/** Branch an employee looks at: the requested one if they work there, else their home branch. */
function employeeBranch(employeeId, requested) {
  if (!hasBranches()) return { loc: 0, branches: [] };
  const branches = employeeBranches(employeeId);
  const want = Number(requested) || 0;
  const pick = branches.find((b) => b.id === want) || branches[0];
  return { loc: pick ? pick.id : 0, branches };
}

/** SQL: employee e works in branch loc (home or extra); everyone when loc = 0. */
const inBranch = (loc) => (loc ? `(e.location_id = ${Number(loc)} OR EXISTS (SELECT 1 FROM employee_locations x WHERE x.employee_id = e.id AND x.location_id = ${Number(loc)}))` : '1');

function weekState(ws, loc = 0) {
  const db = getDb();
  return db.prepare('SELECT * FROM schedule_branch_weeks WHERE week_start = ? AND location_id = ?').get(ws, loc)
    || db.prepare('SELECT * FROM schedule_weeks WHERE week_start = ?').get(ws) // weeks planned before branches were separated
    || { week_start: ws, location_id: loc, status: 'draft', published_at: null };
}
function setWeekState(ws, loc, status, userId = null) {
  getDb().prepare(
    `INSERT INTO schedule_branch_weeks (week_start, location_id, status, updated_at, published_at, published_by)
     VALUES (@ws, @loc, @status, datetime('now'), CASE WHEN @status = 'published' THEN datetime('now') END, @uid)
     ON CONFLICT(week_start, location_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
       published_at = COALESCE(excluded.published_at, schedule_branch_weeks.published_at), published_by = COALESCE(excluded.published_by, schedule_branch_weeks.published_by)`,
  ).run({ ws, loc, status, uid: userId });
}

/** How many workers / shift leads a shift needs: the branch's per-day override, else a chain-wide one, else the shift type default. */
function requirementsFor(ws, loc = 0) {
  const db = getDb();
  const overrides = db.prepare('SELECT * FROM slot_overrides WHERE date BETWEEN ? AND ? AND location_id IN (0, ?)').all(ws, addDays(ws, 6), loc);
  const map = new Map();
  for (const d of weekDays(ws)) {
    for (const t of typesFor(loc)) {
      const o = overrides.find((x) => x.date === d && x.shift_type_id === t.id && x.location_id === loc)
        || overrides.find((x) => x.date === d && x.shift_type_id === t.id && x.location_id === 0);
      map.set(`${d}|${t.id}`, { date: d, shift_type_id: t.id, required_workers: o ? o.required_workers : t.required_workers, required_leads: o ? o.required_leads : t.required_leads, override: !!(o && o.location_id === loc) });
    }
  }
  return map;
}

// ======================= shift types =======================
// Shared types belong to the whole chain; each branch manager can add their own types,
// change a shared type for their branch (it becomes a branch version) or hide it in their branch.
router.get('/shift-types', (req, res) => {
  const manage = req.query.all === '1' && req.can('schedule.manage');
  if (!manage) return res.json({ types: req.user.employee_id ? typesForEmployee(req.user.employee_id) : typesFor(0) });
  const sc = req.user.scope;
  const db = getDb();
  if (!hasBranches() || (sc.all && String(req.query.location_id) === '0')) {
    return res.json({
      mode: 'chain', location_id: 0, can_chain: !!sc.all, branches: hasBranches() ? scopeBranches(sc) : [],
      types: db.prepare('SELECT t.*, 1 AS shared FROM shift_types t WHERE t.location_id IS NULL ORDER BY t.is_active DESC, t.sort_order, t.start_time, t.id').all(),
    });
  }
  const { loc, branches } = managerBranch(req, req.query.location_id);
  const hidden = db.prepare('SELECT t.*, 1 AS shared, 1 AS hidden FROM shift_types t JOIN shift_type_hidden h ON h.shift_type_id = t.id WHERE h.location_id = ?').all(loc);
  res.json({ mode: 'branch', location_id: loc, can_chain: !!sc.all, branches, types: [...typesFor(loc, { includeInactive: true }), ...hidden] });
});

const typeSchema = z.object({
  name: z.string().trim().min(1, 'שדה חובה').max(40),
  start_time: zTime,
  end_time: zTime,
  sort_order: z.coerce.number().int().min(0).max(99).default(0),
  is_active: z.boolean().default(true),
  required_workers: z.coerce.number().int().min(0).max(50).default(0),
  required_leads: z.coerce.number().int().min(0).max(10).default(0),
  location_id: z.coerce.number().int().min(0).optional(), // the branch screen the change is made in (0 = whole chain)
}).refine((t) => t.required_leads <= t.required_workers, { message: 'מספר האחמ"שים לא יכול להיות גדול ממספר העובדים', path: ['required_leads'] });

const chainOnly = (req) => { if (hasBranches() && !req.user.scope.all) throw forbidden('רק מנהל עם אחריות על כל הרשת יכול לשנות משמרת משותפת לכל הסניפים'); };
const branchOk = (req, loc) => { if (!locationInScope(req.user.scope, loc)) throw forbidden('הסניף לא באחריותך'); };
const sameHours = (t) => { if (t.start_time === t.end_time) throw badRequest('שעת הסיום חייבת להיות שונה משעת ההתחלה', { fields: { end_time: 'זהה לשעת ההתחלה' } }); };
const branchName = (loc) => (loc ? getDb().prepare('SELECT name FROM locations WHERE id = ?').get(loc)?.name : null);

router.post('/shift-types', requirePerm('schedule.manage'), ah((req, res) => {
  const t = validate(typeSchema, req.body);
  sameHours(t);
  const loc = hasBranches() ? t.location_id || 0 : 0;
  if (loc) branchOk(req, loc); else chainOnly(req);
  const id = getDb().prepare('INSERT INTO shift_types (name, start_time, end_time, sort_order, is_active, required_workers, required_leads, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.name, t.start_time, t.end_time, t.sort_order, t.is_active ? 1 : 0, t.required_workers, t.required_leads, loc || null).lastInsertRowid;
  const where = loc ? ` בסניף ${branchName(loc)}` : ' לכל הרשת';
  audit(req, { action: 'shift_type.create', entityType: 'shift_type', entityId: id, description: `${req.user.display_name} הגדיר/ה משמרת "${t.name}" ${t.start_time}–${t.end_time}${where}`, newValue: t });
  res.status(201).json({ id, message: 'המשמרת נוספה' });
}));

router.put('/shift-types/:id', requirePerm('schedule.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const db = getDb();
  const before = db.prepare('SELECT * FROM shift_types WHERE id = ?').get(id);
  if (!before) throw notFound('המשמרת לא נמצאה');
  const t = validate(typeSchema, req.body);
  sameHours(t);
  const update = (typeId) => db.prepare('UPDATE shift_types SET name = ?, start_time = ?, end_time = ?, sort_order = ?, is_active = ?, required_workers = ?, required_leads = ? WHERE id = ?')
    .run(t.name, t.start_time, t.end_time, t.sort_order, t.is_active ? 1 : 0, t.required_workers, t.required_leads, typeId);
  const log = (description, extra = {}) => audit(req, { action: 'shift_type.update', entityType: 'shift_type', entityId: id, description, oldValue: before, newValue: { ...t, ...extra } });

  // a branch's own type
  if (before.location_id) {
    branchOk(req, before.location_id);
    update(id);
    log(`${req.user.display_name} עדכן/ה את המשמרת "${t.name}" בסניף ${branchName(before.location_id)} (${before.start_time}–${before.end_time} → ${t.start_time}–${t.end_time})`);
    return res.json({ message: 'המשמרת עודכנה. השינוי יחול על סידורים שיפורסמו מעכשיו.' });
  }
  // a shared type changed for the whole chain
  const loc = hasBranches() ? t.location_id || 0 : 0;
  if (!loc) {
    chainOnly(req);
    update(id);
    log(`${req.user.display_name} עדכן/ה את המשמרת המשותפת "${t.name}" (${before.start_time}–${before.end_time} → ${t.start_time}–${t.end_time})`);
    return res.json({ message: 'המשמרת עודכנה לכל הסניפים. השינוי יחול על סידורים שיפורסמו מעכשיו.' });
  }
  // a shared type changed for one branch only
  branchOk(req, loc);
  const name = branchName(loc);
  if (!t.is_active) {
    db.prepare('INSERT OR IGNORE INTO shift_type_hidden (shift_type_id, location_id) VALUES (?, ?)').run(id, loc);
    log(`${req.user.display_name} הסתיר/ה את המשמרת "${before.name}" בסניף ${name}`, { hidden_in: name });
    return res.json({ message: `המשמרת הוסתרה בסניף ${name}` });
  }
  const today = todayLocal();
  const newId = db.transaction(() => {
    const nid = db.prepare('INSERT INTO shift_types (name, start_time, end_time, sort_order, is_active, required_workers, required_leads, location_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .run(t.name, t.start_time, t.end_time, t.sort_order, t.required_workers, t.required_leads, loc).lastInsertRowid;
    db.prepare('INSERT OR IGNORE INTO shift_type_hidden (shift_type_id, location_id) VALUES (?, ?)').run(id, loc);
    // upcoming plans of this branch move to the branch's version
    db.prepare('UPDATE OR IGNORE schedule_assignments SET shift_type_id = ? WHERE shift_type_id = ? AND location_id = ? AND date >= ?').run(nid, id, loc, today);
    db.prepare('UPDATE OR IGNORE slot_overrides SET shift_type_id = ? WHERE shift_type_id = ? AND location_id = ? AND date >= ?').run(nid, id, loc, today);
    return nid;
  })();
  log(`${req.user.display_name} התאים/ה את המשמרת "${before.name}" לסניף ${name}: ${t.start_time}–${t.end_time}`, { branch: name, new_type_id: newId });
  res.json({ id: newId, message: `המשמרת עודכנה לסניף ${name} בלבד. בשאר הסניפים היא נשארת כמו שהייתה.` });
}));

// show a shared type again in a branch (after hiding it or making a branch version)
router.post('/shift-types/:id/restore', requirePerm('schedule.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const { location_id: locId } = validate(z.object({ location_id: z.coerce.number().int().positive() }), req.body);
  branchOk(req, locId);
  getDb().prepare('DELETE FROM shift_type_hidden WHERE shift_type_id = ? AND location_id = ?').run(id, locId);
  const t = getDb().prepare('SELECT name FROM shift_types WHERE id = ?').get(id);
  audit(req, { action: 'shift_type.restore', entityType: 'shift_type', entityId: id, description: `${req.user.display_name} החזיר/ה את המשמרת המשותפת "${t?.name}" לסניף ${branchName(locId)}` });
  res.json({ message: 'המשמרת המשותפת חזרה לסניף' });
}));

// ======================= employee: my preferences =======================
router.get('/my', requireEmployee, (req, res) => {
  const ws = parseWeek(req.query.week);
  const db = getDb();
  const prefs = db.prepare(
    'SELECT date, shift_type_id, preference FROM shift_preferences WHERE employee_id = ? AND date BETWEEN ? AND ?',
  ).all(req.user.employee_id, ws, addDays(ws, 6));
  const sub = db.prepare('SELECT note, submitted_at FROM schedule_submissions WHERE employee_id = ? AND week_start = ?').get(req.user.employee_id, ws);
  const state = weekState(ws, employeeBranch(req.user.employee_id).loc);
  res.json({
    week_start: ws, days: weekDays(ws), types: typesForEmployee(req.user.employee_id), prefs, note: sub?.note || '', submitted_at: sub?.submitted_at || null,
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
  const state = weekState(ws, employeeBranch(req.user.employee_id).loc);
  if (state.status === 'published') throw badRequest('הסידור לשבוע זה כבר פורסם. לשינויים פנו למנהל.');
  if (addDays(ws, 6) < todayLocal()) throw badRequest('לא ניתן להגיש זמינות לשבוע שעבר');
  const days = new Set(weekDays(ws));
  const typeIds = new Set(typesForEmployee(req.user.employee_id).map((t) => t.id));
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
  if (first) notifyPermission('schedule.manage', { type: 'availability', title: 'הוגשה זמינות לשבוע הבא', body: `${req.user.display_name} · שבוע ${fmt(ws)}`, link: `/schedule?tab=board&week=${ws}` }, { exceptUserId: req.user.id, about: { employeeId: emp } });
  res.json({ message: 'הזמינות נשמרה. תודה!' });
}));

// ======================= manager: board =======================
/** Employees on a branch board that this manager is responsible for (a department manager sees their department). */
function boardEmployees(req, loc, ws) {
  return getDb().prepare(
    `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.avatar, p.name AS position_name, d.name AS department_name,
            e.can_lead, e.location_id, s.submitted_at, s.note
     FROM employees e LEFT JOIN positions p ON p.id = e.position_id LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN schedule_submissions s ON s.employee_id = e.id AND s.week_start = ?
     WHERE e.status = 'active' AND ${inBranch(loc)} ${scopeWhere(req.user.scope, { e: 'e' })} ORDER BY e.first_name, e.last_name`,
  ).all(ws);
}

router.get('/board', requirePerm('schedule.manage'), (req, res) => {
  const ws = parseWeek(req.query.week);
  const { loc, branches } = managerBranch(req, req.query.location_id);
  const db = getDb();
  const end = addDays(ws, 6);
  const employees = boardEmployees(req, loc, ws);
  const ids = employees.map((e) => e.id).join(',') || '-1';
  // Approved leave in this week, so the manager sees it on the board
  const leave = db.prepare(
    `SELECT employee_id, start_date, COALESCE(end_date, start_date) AS end_date FROM requests
     WHERE status = 'approved' AND type IN ('vacation','day_off') AND start_date <= ? AND COALESCE(end_date, start_date) >= ? AND employee_id IN (${ids})`,
  ).all(end, ws);
  // Shifts added manually in the calendar, and picks on other branches' boards, so the board can warn about double booking
  const busy = db.prepare(
    `SELECT employee_id, start_at, end_at FROM shifts
     WHERE status = 'scheduled' AND shift_type_id IS NULL AND start_at >= ? AND start_at < ? AND employee_id IN (${ids})`,
  ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`);
  const types = allTypes();
  for (const a of db.prepare(`SELECT * FROM schedule_assignments WHERE date BETWEEN ? AND ? AND location_id != ? AND employee_id IN (${ids})`).all(ws, end, loc)) {
    const t = types.get(a.shift_type_id);
    if (t) busy.push({ employee_id: a.employee_id, ...typeRange(t, a.date), other_branch: true });
  }
  res.json({
    week_start: ws,
    location_id: loc,
    branches,
    days: weekDays(ws),
    types: typesFor(loc),
    employees,
    prefs: db.prepare(`SELECT employee_id, date, shift_type_id, preference FROM shift_preferences WHERE date BETWEEN ? AND ? AND employee_id IN (${ids})`).all(ws, end),
    assignments: db.prepare(`SELECT date, shift_type_id, employee_id, is_lead, status, claimed_at FROM schedule_assignments WHERE date BETWEEN ? AND ? AND location_id = ?`).all(ws, end, loc),
    requirements: [...requirementsFor(ws, loc).values()],
    loaded_at: new Date().toISOString(),
    leave,
    busy,
    state: weekState(ws, loc),
  });
});

const assignmentsSchema = z.object({
  week_start: zDate,
  location_id: z.coerce.number().int().min(0).optional(),
  assignments: z.array(z.object({
    date: zDate, shift_type_id: zId, employee_id: zId, is_lead: z.boolean().default(false),
    status: z.enum(['approved', 'claimed']).default('approved'),
  })).max(2000),
  loaded_at: z.string().max(40).optional(),
});

/**
 * Save one branch's board. Only rows of people this manager is responsible for are replaced,
 * so two managers (e.g. two department managers in one branch) don't overwrite each other.
 */
function saveAssignments(req, ws, loc, list, loadedAt) {
  const db = getDb();
  const mine = new Set(boardEmployees(req, loc, ws).map((e) => e.id));
  const existingAll = db.prepare('SELECT * FROM schedule_assignments WHERE date BETWEEN ? AND ? AND location_id = ?').all(ws, addDays(ws, 6), loc);
  const existing = existingAll.filter((a) => mine.has(a.employee_id));
  const others = existingAll.filter((a) => !mine.has(a.employee_id));
  const key = (a) => `${a.date}|${a.shift_type_id}|${a.employee_id}`;
  const incoming = new Set(list.map(key));
  // Claims employees made after the manager opened the board must not be wiped by this save
  const loaded = loadedAt ? loadedAt.replace('T', ' ').replace('Z', '').slice(0, 23) : null; // ms precision, same format as claimed_at
  const late = existing.filter((a) => a.status === 'claimed' && !incoming.has(key(a)) && loaded && a.claimed_at && a.claimed_at > loaded);
  const claimedAt = new Map(existing.map((a) => [key(a), a.claimed_at]));
  const days = new Set(weekDays(ws));
  const typeIds = new Set(typesFor(loc).map((t) => t.id));
  const leads = new Map(others.filter((a) => a.is_lead).map((a) => [`${a.date}|${a.shift_type_id}`, a.employee_id]));
  for (const a of list) {
    if (!days.has(a.date)) throw badRequest('תאריך מחוץ לשבוע שנבחר');
    if (!typeIds.has(a.shift_type_id)) throw badRequest('משמרת לא קיימת');
    if (!mine.has(a.employee_id)) throw forbidden('אחד העובדים שנבחרו לא באחריותך או לא שייך לסניף הזה');
    if (a.is_lead) {
      const k = `${a.date}|${a.shift_type_id}`;
      if (leads.has(k)) throw badRequest(`אפשר לסמן רק אחמ"ש אחד למשמרת (${fmt(a.date)})`);
      leads.set(k, a.employee_id);
    }
  }
  // the same person can't be on two branches' boards at the same day + shift
  const elsewhere = db.prepare('SELECT 1 FROM schedule_assignments WHERE date = ? AND shift_type_id = ? AND employee_id = ? AND location_id != ?');
  for (const a of list) if (elsewhere.get(a.date, a.shift_type_id, a.employee_id, loc)) throw badRequest(`אחד העובדים כבר משובץ באותה משמרת בסניף אחר (${fmt(a.date)})`);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM schedule_assignments WHERE date = ? AND shift_type_id = ? AND employee_id = ? AND location_id = ?');
    for (const a of existing) del.run(a.date, a.shift_type_id, a.employee_id, loc);
    const ins = db.prepare('INSERT OR REPLACE INTO schedule_assignments (date, shift_type_id, employee_id, is_lead, status, claimed_at, location_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const a of list) ins.run(a.date, a.shift_type_id, a.employee_id, a.is_lead ? 1 : 0, a.status || 'approved', claimedAt.get(key(a)) || null, loc);
    for (const a of late) ins.run(a.date, a.shift_type_id, a.employee_id, a.is_lead, a.status, a.claimed_at, loc);
    setWeekState(ws, loc, 'draft');
  })();
  // Tell employees what happened to their picks
  const byKey = new Map(list.map((a) => [key(a), a]));
  const types = new Map([...allTypes().values()].map((t) => [t.id, t.name]));
  for (const a of existing.filter((x) => x.status === 'claimed' && !late.includes(x))) {
    const now = byKey.get(key(a));
    const what = `${types.get(a.shift_type_id) || 'משמרת'} · ${fmt(a.date)}`;
    if (!now) notifyEmployee(a.employee_id, { type: 'request_rejected', title: 'המשמרת שבחרת לא אושרה', body: what, link: `/schedule?tab=open&week=${ws}` });
    else if (now.status === 'approved') notifyEmployee(a.employee_id, { type: 'request_approved', title: 'המשמרת שבחרת אושרה', body: what, link: `/schedule?tab=open&week=${ws}` });
  }
  return mine;
}

router.put('/board', requirePerm('schedule.manage'), ah((req, res) => {
  const body = validate(assignmentsSchema, req.body);
  const ws = startOfWeek(body.week_start);
  const { loc } = managerBranch(req, body.location_id);
  saveAssignments(req, ws, loc, body.assignments, body.loaded_at);
  res.json({ state: weekState(ws, loc), message: 'הטיוטה נשמרה' });
}));

/** Publish one branch: turn its board into real shifts (create / update / cancel) and notify employees. */
router.post('/publish', requirePerm('schedule.manage'), ah((req, res) => {
  const body = validate(assignmentsSchema, req.body);
  const ws = startOfWeek(body.week_start);
  const { loc } = managerBranch(req, body.location_id);
  if (addDays(ws, 6) < todayLocal()) throw badRequest('לא ניתן לפרסם סידור לשבוע שעבר');
  const mine = saveAssignments(req, ws, loc, body.assignments, body.loaded_at);
  // Only approved assignments become shifts; pending claims stay on the board
  const pendingClaims = body.assignments.filter((a) => a.status === 'claimed').length;
  body.assignments = body.assignments.filter((a) => a.status !== 'claimed');
  const db = getDb();
  const types = new Map(typesFor(loc).map((t) => [t.id, t]));
  const now = nowLocal();
  const stats = { created: 0, updated: 0, cancelled: 0, kept: 0 };
  const touched = new Set();
  const ids = [...mine].join(',') || '-1';

  db.transaction(() => {
    // this branch's planned shifts of the people on this manager's board
    const existing = db.prepare(
      `SELECT s.*, a.clock_in_at FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN attendance a ON a.shift_id = s.id
       WHERE s.shift_type_id IS NOT NULL AND s.status = 'scheduled' AND s.start_at >= ? AND s.start_at < ?
         AND s.employee_id IN (${ids}) ${loc ? `AND COALESCE(s.location_id, e.location_id) = ${Number(loc)}` : ''}`,
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
          db.prepare("UPDATE shifts SET shift_type_id = ?, is_lead = ?, location_id = COALESCE(location_id, ?), updated_at = datetime('now') WHERE id = ?").run(a.shift_type_id, a.is_lead ? 1 : 0, loc || null, manual.id);
          stats.updated += 1;
        } else {
          const emp = db.prepare('SELECT position_id, location_id FROM employees WHERE id = ?').get(a.employee_id);
          insert.run(a.employee_id, start_at, end_at, a.shift_type_id, a.is_lead ? 1 : 0, emp.position_id, loc || emp.location_id, req.user.id);
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
    setWeekState(ws, loc, 'published', req.user.id);
  })();

  // Overlapping shifts for the same person (e.g. a manual shift at other hours, or a shift in another branch)
  const warnings = db.prepare(
    `SELECT DISTINCT e.first_name || ' ' || e.last_name AS name, s1.start_at
     FROM shifts s1 JOIN shifts s2 ON s2.employee_id = s1.employee_id AND s2.id > s1.id
       AND s2.status = 'scheduled' AND s2.start_at < s1.end_at AND s2.end_at > s1.start_at
     JOIN employees e ON e.id = s1.employee_id
     WHERE s1.status = 'scheduled' AND s1.start_at >= ? AND s1.start_at < ? AND s1.employee_id IN (${ids})
     ORDER BY s1.start_at`,
  ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`).map((w) => `${w.name} – ${fmt(w.start_at)}: שתי משמרות חופפות`);

  const branchName = loc ? db.prepare('SELECT name FROM locations WHERE id = ?').get(loc)?.name : null;
  const allAssigned = new Set(body.assignments.map((a) => a.employee_id));
  for (const emp of allAssigned) {
    const count = body.assignments.filter((a) => a.employee_id === emp).length;
    notifyEmployee(emp, { type: 'shift_assigned', title: `סידור העבודה לשבוע ${fmt(ws)} פורסם${branchName ? ` · ${branchName}` : ''}`, body: `שובצת ל-${count} משמרות`, link: `/schedule?week=${ws}${loc ? `&location_id=${loc}` : ''}` });
  }
  for (const emp of touched) {
    if (!allAssigned.has(emp)) notifyEmployee(emp, { type: 'shift_cancelled', title: `עודכן סידור העבודה לשבוע ${fmt(ws)}${branchName ? ` · ${branchName}` : ''}`, body: 'אינך משובץ/ת השבוע בסניף הזה', link: `/schedule?week=${ws}` });
  }
  audit(req, {
    action: 'schedule.publish', entityType: 'schedule', description: `${req.user.display_name} אישר/ה ופרסם/ה את סידור העבודה לשבוע ${fmt(ws)}${branchName ? ` בסניף ${branchName}` : ''}`,
    newValue: { week_start: ws, location_id: loc || null, assignments: body.assignments.length, ...stats },
  });
  if (pendingClaims) warnings.unshift(`${pendingClaims} בחירות של עובדים עדיין ממתינות לאישור ולא פורסמו`);
  res.json({ state: weekState(ws, loc), stats, warnings, message: 'הסידור אושר ופורסם לעובדים' });
}));

// ======================= staffing requirements (per branch) =======================
router.put('/requirements', requirePerm('schedule.manage'), ah((req, res) => {
  const d = validate(z.object({
    date: zDate, shift_type_id: zId, location_id: z.coerce.number().int().min(0).optional(),
    required_workers: z.coerce.number().int().min(0).max(50), required_leads: z.coerce.number().int().min(0).max(10),
    reset: z.boolean().optional(),
  }).refine((x) => x.required_leads <= x.required_workers, { message: 'מספר האחמ"שים לא יכול להיות גדול ממספר העובדים', path: ['required_leads'] }), req.body);
  const { loc } = managerBranch(req, d.location_id);
  const db = getDb();
  if (d.reset) db.prepare('DELETE FROM slot_overrides WHERE date = ? AND shift_type_id = ? AND location_id = ?').run(d.date, d.shift_type_id, loc);
  else {
    db.prepare(
      `INSERT INTO slot_overrides (date, shift_type_id, location_id, required_workers, required_leads) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date, shift_type_id, location_id) DO UPDATE SET required_workers = excluded.required_workers, required_leads = excluded.required_leads`,
    ).run(d.date, d.shift_type_id, loc, d.required_workers, d.required_leads);
  }
  res.json({ requirements: [...requirementsFor(startOfWeek(d.date), loc).values()], message: 'הדרישה עודכנה' });
}));

// ======================= first-come shift claims (employees) =======================
function openSlots(ws, loc, employeeId) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT a.*, e.first_name || ' ' || e.last_name AS name FROM schedule_assignments a JOIN employees e ON e.id = a.employee_id
     WHERE a.date BETWEEN ? AND ? AND a.location_id = ?`,
  ).all(ws, addDays(ws, 6), loc);
  return [...requirementsFor(ws, loc).values()].map((r) => {
    const here = rows.filter((a) => a.date === r.date && a.shift_type_id === r.shift_type_id);
    const mine = here.find((a) => a.employee_id === employeeId);
    return {
      ...r,
      taken_leads: here.filter((a) => a.is_lead).length,
      taken_regular: here.filter((a) => !a.is_lead).length,
      people: here.map((a) => ({ name: a.name, is_lead: !!a.is_lead, status: a.status })),
      mine: mine ? { status: mine.status, is_lead: !!mine.is_lead } : null,
    };
  });
}

router.get('/open', requireEmployee, (req, res) => {
  const ws = parseWeek(req.query.week);
  const { loc, branches } = employeeBranch(req.user.employee_id, req.query.location_id);
  const state = weekState(ws, loc);
  const emp = getDb().prepare('SELECT can_lead FROM employees WHERE id = ?').get(req.user.employee_id);
  res.json({
    week_start: ws, location_id: loc, branches, days: weekDays(ws), types: typesFor(loc), slots: openSlots(ws, loc, req.user.employee_id),
    can_lead: !!emp?.can_lead, status: state.status, locked: state.status === 'published' || addDays(ws, 6) < todayLocal(),
  });
});

router.post('/claim', requireEmployee, ah((req, res) => {
  const d = validate(z.object({ date: zDate, shift_type_id: zId, as_lead: z.boolean().default(false), location_id: z.coerce.number().int().min(0).optional() }), req.body);
  const ws = startOfWeek(d.date);
  const db = getDb();
  const empId = req.user.employee_id;
  const { loc, branches } = employeeBranch(empId, d.location_id);
  if (hasBranches() && d.location_id && !branches.some((b) => b.id === d.location_id)) throw badRequest('אינך עובד/ת בסניף הזה');
  db.transaction(() => {
    if (weekState(ws, loc).status === 'published') throw badRequest('הסידור לשבוע זה כבר פורסם');
    if (d.date < todayLocal()) throw badRequest('לא ניתן לבחור משמרת שעברה');
    const emp = db.prepare('SELECT status, can_lead FROM employees WHERE id = ?').get(empId);
    if (emp.status !== 'active') throw badRequest('רק עובד פעיל יכול לבחור משמרות');
    if (d.as_lead && !emp.can_lead) throw badRequest('אינך מוגדר/ת כאחמ"ש. פנו למנהל.');
    const slot = openSlots(ws, loc, empId).find((x) => x.date === d.date && x.shift_type_id === d.shift_type_id);
    if (!slot || !slot.required_workers) throw badRequest('המשמרת הזו לא פתוחה לבחירה');
    if (slot.mine) throw badRequest('כבר בחרת את המשמרת הזו');
    if (db.prepare('SELECT 1 FROM schedule_assignments WHERE employee_id = ? AND date = ?').get(empId, d.date)) throw badRequest('כבר יש לך משמרת ביום הזה');
    const free = d.as_lead ? slot.required_leads - slot.taken_leads : (slot.required_workers - slot.required_leads) - slot.taken_regular;
    if (free <= 0) throw badRequest(d.as_lead ? 'מקום האחמ"ש כבר נתפס' : 'כל המקומות במשמרת הזו כבר נתפסו');
    db.prepare("INSERT INTO schedule_assignments (date, shift_type_id, employee_id, is_lead, status, claimed_at, location_id) VALUES (?, ?, ?, ?, 'claimed', strftime('%Y-%m-%d %H:%M:%f', 'now'), ?)")
      .run(d.date, d.shift_type_id, empId, d.as_lead ? 1 : 0, loc);
    if (weekState(ws, loc).status !== 'published') setWeekState(ws, loc, 'draft');
    return slot;
  })();
  const type = allTypes().get(d.shift_type_id);
  audit(req, { action: 'schedule.claim', entityType: 'employee', entityId: empId, description: `${req.user.display_name} בחר/ה משמרת ${type?.name} ב-${fmt(d.date)}${d.as_lead ? ' כאחמ"ש' : ''}`, newValue: { ...d, location_id: loc || null } });
  notifyPermission('schedule.manage', { type: 'shift_claimed', title: `${req.user.display_name} בחר/ה משמרת`, body: `${type?.name} · ${fmt(d.date)}${d.as_lead ? ' · כאחמ"ש' : ''} – ממתין לאישור`, link: `/schedule?tab=board&week=${ws}${loc ? `&location_id=${loc}` : ''}` }, { exceptUserId: req.user.id, about: loc ? { locationId: loc } : { employeeId: empId } });
  res.status(201).json({ slots: openSlots(ws, loc, empId), message: 'המשמרת נשמרה עבורך וממתינה לאישור המנהל' });
}));

router.delete('/claim', requireEmployee, ah((req, res) => {
  const d = validate(z.object({ date: zDate, shift_type_id: zId }), req.query);
  const ws = startOfWeek(d.date);
  const row = getDb().prepare("SELECT location_id FROM schedule_assignments WHERE date = ? AND shift_type_id = ? AND employee_id = ? AND status = 'claimed'").get(d.date, d.shift_type_id, req.user.employee_id);
  if (!row) throw badRequest('אפשר לבטל רק בחירה שעדיין לא אושרה. לשינוי משמרת מאושרת פנו למנהל.');
  getDb().prepare("DELETE FROM schedule_assignments WHERE date = ? AND shift_type_id = ? AND employee_id = ? AND status = 'claimed'").run(d.date, d.shift_type_id, req.user.employee_id);
  audit(req, { action: 'schedule.unclaim', entityType: 'employee', entityId: req.user.employee_id, description: `${req.user.display_name} ביטל/ה בחירת משמרת ב-${fmt(d.date)}` });
  res.json({ slots: openSlots(ws, row.location_id, req.user.employee_id), message: 'הבחירה בוטלה' });
}));

// ======================= published schedule (per branch) =======================
router.get('/published', ah((req, res) => {
  const ws = req.query.week ? startOfWeek(validate(zDate, req.query.week)) : startOfWeek(todayLocal());
  const db = getDb();
  // managers pick among the branches they're responsible for; employees among the branches they work in
  const manager = req.can('shifts.view_all') || req.can('schedule.manage');
  let pick = { loc: 0, branches: [] };
  if (hasBranches()) {
    const own = req.user.employee_id ? employeeBranches(req.user.employee_id) : [];
    const managed = manager ? scopeBranches(req.user.scope) : [];
    const branches = [...new Map([...own, ...managed].map((b) => [b.id, b])).values()];
    const want = Number(req.query.location_id) || 0;
    const chosen = branches.find((b) => b.id === want) || own[0] || branches[0];
    pick = { loc: chosen ? chosen.id : 0, branches };
  }
  const rows = db.prepare(
    `SELECT s.id, s.employee_id, s.start_at, s.end_at, s.shift_type_id, s.is_lead, st.name AS type_name, st.sort_order,
            e.first_name || ' ' || e.last_name AS employee_name, e.avatar, p.name AS position_name
     FROM shifts s JOIN employees e ON e.id = s.employee_id
     LEFT JOIN shift_types st ON st.id = s.shift_type_id LEFT JOIN positions p ON p.id = e.position_id
     WHERE s.status = 'scheduled' AND s.start_at >= ? AND s.start_at < ? ${pick.loc ? `AND COALESCE(s.location_id, e.location_id) = ${Number(pick.loc)}` : ''}
     ORDER BY s.start_at, s.is_lead DESC, e.first_name`,
  ).all(`${ws}T00:00`, `${addDays(ws, 7)}T00:00`);
  // Shifts added manually in the calendar are grouped under a shift type when their hours match it exactly
  const types = typesFor(pick.loc);
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
  res.json({ week_start: ws, location_id: pick.loc, branches: pick.branches, state: weekState(ws, pick.loc), days });
}));

export default router;
