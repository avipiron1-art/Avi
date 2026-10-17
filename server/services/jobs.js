// Periodic background checks: late employees and tasks approaching their due date.
import { getDb } from '../db/index.js';
import { addDays, addMinutes, hhmm, nowLocal, todayLocal } from '../lib/time.js';
import { getNumberSetting } from './settings.js';
import { notifyEmployee, notifyPermission } from './notify.js';
import { audit } from './audit.js';
import { maybeDailyBackup } from './backup.js';

export function checkLateEmployees() {
  const db = getDb();
  const now = nowLocal();
  const grace = getNumberSetting('late_grace_minutes');
  const late = db.prepare(
    `SELECT s.id, s.employee_id, s.start_at, e.first_name || ' ' || e.last_name AS name
     FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN attendance a ON a.shift_id = s.id
     WHERE s.status = 'scheduled' AND s.late_notified = 0 AND a.clock_in_at IS NULL AND COALESCE(a.marked_absent, 0) = 0
       AND s.start_at <= ? AND s.end_at > ? AND s.start_at >= ?`,
  ).all(addMinutes(now, -grace - 1), now, `${addDays(todayLocal(), -1)}T00:00`);
  for (const s of late) {
    db.prepare('UPDATE shifts SET late_notified = 1 WHERE id = ?').run(s.id);
    notifyPermission('attendance.manage', { type: 'employee_late', title: `${s.name} טרם הגיע/ה למשמרת`, body: `המשמרת התחילה ב-${hhmm(s.start_at)}`, link: '/attendance' });
    notifyEmployee(s.employee_id, { type: 'employee_late', title: 'לא נרשמה כניסה למשמרת', body: `המשמרת שלך התחילה ב-${hhmm(s.start_at)}. אל תשכח/י להחתים כניסה.`, link: '/attendance' });
    audit(null, { action: 'attendance.late_detected', entityType: 'shift', entityId: s.id, description: `${s.name} לא החתים/ה כניסה למשמרת שהתחילה ב-${hhmm(s.start_at)}` });
  }
  return late.length;
}

/** Remind employees who are still clocked in a few minutes after their shift ended. */
export function checkShiftEndReminders() {
  const db = getDb();
  const now = nowLocal();
  const after = getNumberSetting('shift_end_reminder_minutes');
  const rows = db.prepare(
    `SELECT s.id, s.employee_id, s.end_at FROM shifts s JOIN attendance a ON a.shift_id = s.id
     WHERE s.status = 'scheduled' AND COALESCE(s.end_reminded, 0) = 0 AND a.clock_in_at IS NOT NULL AND a.clock_out_at IS NULL
       AND s.end_at <= ? AND s.end_at >= ?`,
  ).all(addMinutes(now, -after), `${addDays(todayLocal(), -1)}T00:00`);
  for (const s of rows) {
    db.prepare('UPDATE shifts SET end_reminded = 1 WHERE id = ?').run(s.id);
    notifyEmployee(s.employee_id, { type: 'shift_end', title: 'המשמרת הסתיימה – לא לשכוח להחתים יציאה', body: `המשמרת שלך הסתיימה ב-${hhmm(s.end_at)}. אם סיימת, לחצ/י על "סיום משמרת".`, link: '/', urgent: true });
  }
  return rows.length;
}

export function checkTasksDueSoon() {
  const db = getDb();
  const limit = addDays(todayLocal(), getNumberSetting('task_due_soon_days'));
  const tasks = db.prepare(
    `SELECT id, title, assignee_id, due_date FROM tasks WHERE status IN ('new','in_progress') AND due_notified = 0
       AND assignee_id IS NOT NULL AND due_date IS NOT NULL AND due_date <= ?`,
  ).all(limit);
  for (const t of tasks) {
    db.prepare('UPDATE tasks SET due_notified = 1 WHERE id = ?').run(t.id);
    notifyEmployee(t.assignee_id, { type: 'task_due', title: 'משימה מתקרבת לתאריך היעד', body: `${t.title} · ${t.due_date}`, link: '/tasks' });
  }
  return tasks.length;
}

export function startJobs() {
  const run = () => {
    try { checkLateEmployees(); checkShiftEndReminders(); checkTasksDueSoon(); maybeDailyBackup(); } catch (e) { console.error('[jobs]', e); }
  };
  run();
  return setInterval(run, 60_000);
}
