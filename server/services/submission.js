// Availability submission windows.
// A manager opens submission for one week in one branch (or every branch) and one department (or every department),
// optionally until a closing time. Employees covered by an open window can send their availability;
// before the closing time the ones who haven't sent it yet get a reminder.
import { getDb } from '../db/index.js';
import { addMinutes, nowLocal } from '../lib/time.js';
import { notifyEmployee } from './notify.js';

export const fmtDay = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
/** "18/10 בשעה 20:00" */
export const fmtWhen = (ts) => `${fmtDay(ts)} בשעה ${ts.slice(11, 16)}`;

/** Is the window open right now? */
export const isOpen = (w, now = nowLocal()) => !!w && !w.closed_at && (!w.closes_at || w.closes_at > now);

/** May a manager with this scope open / close submission for this branch + department? */
export function canTarget(scope, loc, dep) {
  if (!scope) return false;
  if (scope.all) return true;
  if (scope.selfOnly || scope.type === 'lead') return false;
  if (scope.locs && !scope.locs.includes(Number(loc))) return false; // includes "every branch" (0)
  if (scope.dep && Number(dep) !== Number(scope.dep)) return false;
  return true;
}

/** Active employees a window covers (home or extra branch; department). */
export function windowEmployees(loc, dep) {
  const where = ["e.status != 'inactive'"];
  if (Number(loc)) where.push(`(e.location_id = ${Number(loc)} OR EXISTS (SELECT 1 FROM employee_locations x WHERE x.employee_id = e.id AND x.location_id = ${Number(loc)}))`);
  if (Number(dep)) where.push(`e.department_id = ${Number(dep)}`);
  return getDb().prepare(`SELECT e.id FROM employees e WHERE ${where.join(' AND ')}`).all().map((r) => r.id);
}

/** The branches an employee works in (home + extra) and their department. */
function employeeKeys(employeeId) {
  const db = getDb();
  const e = db.prepare('SELECT location_id, department_id FROM employees WHERE id = ?').get(employeeId) || {};
  const extra = db.prepare('SELECT location_id FROM employee_locations WHERE employee_id = ?').all(employeeId).map((r) => r.location_id);
  return { locs: [...new Set([0, e.location_id, ...extra].filter((x) => x != null))], dep: e.department_id || 0, home: e.location_id || 0 };
}

/**
 * Can this employee send availability for the week now?
 * A window opened before the branch's schedule was published no longer counts; the manager can open it again.
 * Returns { open, closes_at }.
 */
export function employeeWindow(employeeId, ws, publishedAt = null) {
  const k = employeeKeys(employeeId);
  const rows = getDb().prepare(
    `SELECT * FROM schedule_submission_windows WHERE week_start = ? AND location_id IN (${k.locs.map(Number).join(',')}) AND department_id IN (0, ?)`,
  ).all(ws, k.dep);
  const open = rows.filter((w) => isOpen(w) && (!publishedAt || w.opened_at > publishedAt));
  if (!open.length) return { open: false, closes_at: null };
  const noEnd = open.find((w) => !w.closes_at);
  return { open: true, closes_at: noEnd ? null : open.map((w) => w.closes_at).sort().pop() };
}

/** Send the "closing soon" reminder to people who haven't submitted yet. Run every minute. */
export function checkSubmissionReminders(now = nowLocal()) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM schedule_submission_windows
     WHERE closed_at IS NULL AND closes_at IS NOT NULL AND reminder_minutes > 0 AND reminder_sent_at IS NULL AND closes_at > ?`,
  ).all(now);
  let sent = 0;
  for (const w of rows) {
    if (addMinutes(w.closes_at, -w.reminder_minutes) > now) continue;
    db.prepare("UPDATE schedule_submission_windows SET reminder_sent_at = datetime('now') WHERE id = ?").run(w.id);
    const done = new Set(db.prepare('SELECT employee_id FROM schedule_submissions WHERE week_start = ?').all(w.week_start).map((r) => r.employee_id));
    for (const id of windowEmployees(w.location_id, w.department_id)) {
      if (done.has(id)) continue;
      notifyEmployee(id, {
        type: 'availability', urgent: true,
        title: 'תזכורת: עוד לא הגשת זמינות',
        body: `ההגשה לשבוע ${fmtDay(w.week_start)} נסגרת ב-${fmtWhen(w.closes_at)}`,
        link: `/schedule?tab=submit&week=${w.week_start}`,
      });
      sent += 1;
    }
  }
  return sent;
}
