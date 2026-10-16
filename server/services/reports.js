import { getDb } from '../db/index.js';
import { computeAttendance } from '../lib/attendance.js';
import { addDays, nowLocal } from '../lib/time.js';

/**
 * Build a workforce report from real shift + attendance data.
 * filters: { from, to, employee_id, department_id, position_id }
 */
export function buildReport({ from, to, employee_id, department_id, position_id }, { includeCost }) {
  const where = ["s.status = 'scheduled'", 's.start_at >= @from', 's.start_at < @to'];
  const p = { from: `${from}T00:00`, to: `${addDays(to, 1)}T00:00` };
  if (employee_id) { where.push('s.employee_id = @employee_id'); p.employee_id = employee_id; }
  if (department_id) { where.push('e.department_id = @department_id'); p.department_id = department_id; }
  if (position_id) { where.push('e.position_id = @position_id'); p.position_id = position_id; }
  const now = nowLocal();
  const rows = getDb().prepare(
    `SELECT s.id, s.employee_id, s.start_at, s.end_at, a.clock_in_at, a.clock_out_at, a.marked_absent,
            e.first_name || ' ' || e.last_name AS employee_name, e.employee_code, e.hourly_wage,
            d.name AS department_name, p.name AS position_name
     FROM shifts s JOIN employees e ON e.id = s.employee_id
     LEFT JOIN attendance a ON a.shift_id = s.id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN positions p ON p.id = e.position_id
     WHERE ${where.join(' AND ')} ORDER BY s.start_at`,
  ).all(p).map((r) => ({ ...r, ...computeAttendance(r, now), past: r.start_at <= now }));

  const byEmp = new Map();
  const byDay = new Map();
  for (const r of rows) {
    if (!byEmp.has(r.employee_id)) {
      byEmp.set(r.employee_id, {
        employee_id: r.employee_id, employee_code: r.employee_code, employee_name: r.employee_name,
        department_name: r.department_name, position_name: r.position_name, hourly_wage: r.hourly_wage,
        shifts: 0, planned_minutes: 0, worked_minutes: 0, overtime_minutes: 0, late_count: 0, late_minutes: 0, absences: 0, early_leaves: 0,
      });
    }
    const e = byEmp.get(r.employee_id);
    e.shifts += 1;
    e.planned_minutes += r.planned_minutes;
    if (!r.past) continue;
    e.worked_minutes += r.worked_minutes;
    e.overtime_minutes += r.overtime_minutes;
    if (r.late_minutes > 0) { e.late_count += 1; e.late_minutes += r.late_minutes; }
    if (r.attendance_status === 'absent') e.absences += 1;
    if (r.is_early_leave) e.early_leaves += 1;
    const day = r.start_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + r.worked_minutes);
  }

  const employees = [...byEmp.values()].map((e) => {
    const out = { ...e, hours: +(e.worked_minutes / 60).toFixed(2), overtime_hours: +(e.overtime_minutes / 60).toFixed(2), planned_hours: +(e.planned_minutes / 60).toFixed(2) };
    if (includeCost) {
      // Overtime paid at 125% (simplified Israeli rule for the first 2 OT hours)
      const regular = (e.worked_minutes - e.overtime_minutes) / 60;
      out.estimated_cost = +((e.hourly_wage || 0) * (regular + 1.25 * (e.overtime_minutes / 60))).toFixed(2);
    } else {
      delete out.hourly_wage;
    }
    return out;
  }).sort((a, b) => b.worked_minutes - a.worked_minutes);

  const sum = (k) => employees.reduce((t, e) => t + (e[k] || 0), 0);
  const totals = {
    shifts: rows.length,
    employees: employees.length,
    hours: +(sum('worked_minutes') / 60).toFixed(1),
    planned_hours: +(sum('planned_minutes') / 60).toFixed(1),
    overtime_hours: +(sum('overtime_minutes') / 60).toFixed(1),
    late_count: sum('late_count'),
    absences: sum('absences'),
    early_leaves: sum('early_leaves'),
    ...(includeCost ? { estimated_cost: +sum('estimated_cost').toFixed(2) } : {}),
  };
  const daily = [...byDay.entries()].sort().map(([date, m]) => ({ date, hours: +(m / 60).toFixed(1) }));
  return { from, to, totals, employees, daily };
}
