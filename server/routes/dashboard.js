import { Router } from 'express';
import { getDb } from '../db/index.js';
import { SHIFT_COLUMNS, SHIFT_JOINS } from '../lib/serialize.js';
import { computeAttendance } from '../lib/attendance.js';
import { addDays, monthRange, nowLocal, todayLocal, startOfWeek } from '../lib/time.js';

const router = Router();

const ACTIVITY_ACTIONS = ['attendance.clock_in', 'attendance.clock_out', 'attendance.update', 'shift.create', 'shift.update', 'shift.cancel',
  'shift.duplicate', 'shift.copy_week', 'request.create', 'request.approved', 'request.rejected', 'task.create', 'task.status', 'employee.create', 'incident.create'];

function shiftsBetween(from, to, extraWhere = '', params = {}) {
  const now = nowLocal();
  return getDb().prepare(
    `SELECT ${SHIFT_COLUMNS} FROM shifts s ${SHIFT_JOINS}
     WHERE s.status = 'scheduled' AND s.start_at >= @from AND s.start_at < @to ${extraWhere} ORDER BY s.start_at`,
  ).all({ from, to, ...params }).map((s) => ({ ...s, ...computeAttendance(s, now) }));
}

const shiftBucket = (startAt) => {
  const h = Number(startAt.slice(11, 13));
  if (h >= 5 && h < 12) return 'בוקר';
  if (h >= 12 && h < 18) return 'צהריים/ערב';
  return 'לילה';
};

function managerDashboard(req) {
  const db = getDb();
  const now = nowLocal();
  const today = todayLocal();
  const { from: mFrom } = monthRange(today);

  const monthShifts = shiftsBetween(`${addDays(mFrom, -160)}T00:00`, `${addDays(today, 1)}T00:00`);
  const past = monthShifts.filter((s) => s.start_at <= now);
  const thisMonth = past.filter((s) => s.start_at >= `${mFrom}T00:00`);
  const todays = shiftsBetween(`${today}T00:00`, `${addDays(today, 1)}T00:00`);
  const current = shiftsBetween(`${addDays(today, -1)}T00:00`, `${addDays(today, 1)}T00:00`)
    .filter((s) => (s.start_at <= now && s.end_at > now) || (s.clock_in_at && !s.clock_out_at && s.end_at > now));

  const kpis = {
    active_employees: db.prepare("SELECT COUNT(*) c FROM employees WHERE status = 'active'").get().c,
    on_shift_now: current.filter((s) => s.attendance_status === 'on_shift').length,
    scheduled_now: current.length,
    today_employees: new Set(todays.map((s) => s.employee_id)).size,
    month_hours: +(thisMonth.reduce((t, s) => t + s.worked_minutes, 0) / 60).toFixed(1),
    pending_requests: req.can('requests.review') ? db.prepare("SELECT COUNT(*) c FROM requests WHERE status = 'pending'").get().c : null,
    open_tasks: db.prepare("SELECT COUNT(*) c FROM tasks WHERE status IN ('new','in_progress')").get().c,
  };

  const upcoming = shiftsBetween(now, `${addDays(today, 8)}T00:00`).slice(0, 10);

  const activity = db.prepare(
    `SELECT id, user_name, action, description, created_at FROM audit_logs
     WHERE action IN (${ACTIVITY_ACTIONS.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 12`,
  ).all(...ACTIVITY_ACTIONS);

  // Charts
  const hoursByDay = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = addDays(today, -i);
    const mins = past.filter((s) => s.start_at.startsWith(d)).reduce((t, s) => t + s.worked_minutes, 0);
    hoursByDay.push({ date: d, hours: +(mins / 60).toFixed(1) });
  }
  const byEmp = new Map();
  for (const s of thisMonth) byEmp.set(s.employee_name, (byEmp.get(s.employee_name) || 0) + s.worked_minutes);
  const hoursByEmployee = [...byEmp.entries()].map(([name, m]) => ({ name, hours: +(m / 60).toFixed(1) }))
    .sort((a, b) => b.hours - a.hours).slice(0, 10);

  const week = startOfWeek(today);
  const weekShifts = shiftsBetween(`${week}T00:00`, `${addDays(week, 7)}T00:00`);
  const DAY = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const employeesByShift = DAY.map((label, i) => {
    const d = addDays(week, i);
    const row = { day: label, 'בוקר': 0, 'צהריים/ערב': 0, 'לילה': 0 };
    for (const s of weekShifts) if (s.start_at.startsWith(d)) row[shiftBucket(s.start_at)] += 1;
    return row;
  });

  const months = new Map();
  for (const s of past) {
    const m = s.start_at.slice(0, 7);
    months.set(m, (months.get(m) || 0) + s.worked_minutes);
  }
  const monthComparison = [...months.entries()].sort().slice(-6).map(([month, m]) => ({ month, hours: +(m / 60).toFixed(1) }));

  return { kind: 'manager', now, kpis, current, upcoming, activity, charts: { hoursByDay, hoursByEmployee, employeesByShift, monthComparison } };
}

function employeeDashboard(req) {
  const db = getDb();
  const now = nowLocal();
  const today = todayLocal();
  const empId = req.user.employee_id;
  const { from: mFrom } = monthRange(today);
  const mine = shiftsBetween(`${addDays(mFrom, -160)}T00:00`, `${addDays(today, 30)}T00:00`, 'AND s.employee_id = @emp', { emp: empId });
  const monthPast = mine.filter((s) => s.start_at >= `${mFrom}T00:00` && s.start_at <= now);
  const week = startOfWeek(today);
  const months = new Map();
  for (const s of mine.filter((x) => x.start_at <= now)) months.set(s.start_at.slice(0, 7), (months.get(s.start_at.slice(0, 7)) || 0) + s.worked_minutes);
  return {
    kind: 'employee', now,
    kpis: {
      week_shifts: mine.filter((s) => s.start_at >= `${week}T00:00` && s.start_at < `${addDays(week, 7)}T00:00`).length,
      month_hours: +(monthPast.reduce((t, s) => t + s.worked_minutes, 0) / 60).toFixed(1),
      late_count: monthPast.filter((s) => s.late_minutes > 0).length,
      open_tasks: db.prepare("SELECT COUNT(*) c FROM tasks WHERE assignee_id = ? AND status IN ('new','in_progress')").get(empId).c,
      pending_requests: db.prepare("SELECT COUNT(*) c FROM requests WHERE employee_id = ? AND status = 'pending'").get(empId).c,
    },
    upcoming: mine.filter((s) => s.end_at > now).slice(0, 6),
    tasks: db.prepare("SELECT * FROM tasks WHERE assignee_id = ? AND status IN ('new','in_progress') ORDER BY due_date IS NULL, due_date LIMIT 6").all(empId),
    charts: { monthComparison: [...months.entries()].sort().slice(-6).map(([month, m]) => ({ month, hours: +(m / 60).toFixed(1) })) },
  };
}

router.get('/', (req, res) => {
  if (req.can('shifts.view_all')) return res.json(managerDashboard(req));
  if (req.user.employee_id) return res.json(employeeDashboard(req));
  res.json({ kind: 'empty' });
});

export default router;
