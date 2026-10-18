// Pay-hour breakdown by Israeli overtime rules (configurable in Settings → business):
//  • Per work day: the first `overtime_daily_hours` at 100%, the next `ot_tier1_hours` at `rate_ot1` (125%),
//    everything after that at `rate_ot2` (150%).
//  • Hours that fall on the weekly rest day or a paid holiday are paid at `rate_rest_day` (150%),
//    and overtime on those days adds the same premium on top (175% / 200%).
// A "work day" is the date a shift starts on, so a night shift is counted as one day; the rest-day
// premium is decided per minute by the calendar date the minute falls on (e.g. Friday night → Saturday).
// This is a helper for payroll – the accountant has the final word.
import { getDb } from '../db/index.js';
import { getNumberSetting } from './settings.js';
import { holidaysBetween, isRestDay } from './holidays.js';
import { addDays, minutesBetween, nowLocal, toMs, fromMs } from '../lib/time.js';
import { computeAttendance } from '../lib/attendance.js';
import { scopeWhere } from './scope.js';

export const BUCKETS = ['regular', 'ot1', 'ot2', 'rest', 'rest_ot1', 'rest_ot2'];

export function rates() {
  const r1 = getNumberSetting('rate_ot1') || 1.25;
  const r2 = getNumberSetting('rate_ot2') || 1.5;
  const rr = getNumberSetting('rate_rest_day') || 1.5;
  return { regular: 1, ot1: r1, ot2: r2, rest: rr, rest_ot1: +(rr + r1 - 1).toFixed(2), rest_ot2: +(rr + r2 - 1).toFixed(2) };
}

export function bucketLabels() {
  const r = rates();
  const pct = (x) => `${Math.round(x * 100)}%`;
  return {
    regular: `רגילות ${pct(r.regular)}`, ot1: `נוספות ${pct(r.ot1)}`, ot2: `נוספות ${pct(r.ot2)}`,
    rest: `מנוחה/חג ${pct(r.rest)}`, rest_ot1: `מנוחה/חג ${pct(r.rest_ot1)}`, rest_ot2: `מנוחה/חג ${pct(r.rest_ot2)}`,
  };
}

const emptyBuckets = () => Object.fromEntries(BUCKETS.map((b) => [b, 0]));

/** Actual worked interval of a shift row, or null. Mirrors computeAttendance's rules. */
function workedInterval(r, now) {
  if (!r.clock_in_at || r.marked_absent) return null;
  let end = r.clock_out_at || (now < r.end_at ? now : r.end_at);
  if (!r.clock_out_at && now >= r.end_at) end = r.end_at; // forgot to clock out → planned end
  if (end <= r.clock_in_at) return null;
  return [r.clock_in_at, end];
}

/**
 * Split one work day's intervals (sorted) into pay buckets.
 * Walks the day in chunks bounded by tier thresholds and midnights.
 */
export function splitDay(intervals, { dailyMinutes, tier1Minutes, restCache = new Map() }) {
  const out = emptyBuckets();
  let done = 0;
  const rest = (date) => { if (!restCache.has(date)) restCache.set(date, isRestDay(date)); return restCache.get(date); };
  for (const [a, b] of intervals) {
    let t = toMs(a);
    const end = toMs(b);
    while (t < end) {
      const cur = fromMs(t);
      const nextMidnight = toMs(`${addDays(cur.slice(0, 10), 1)}T00:00`);
      const tier = done < dailyMinutes ? 0 : done < dailyMinutes + tier1Minutes ? 1 : 2;
      const tierLeft = tier === 0 ? dailyMinutes - done : tier === 1 ? dailyMinutes + tier1Minutes - done : Infinity;
      const chunk = Math.min((end - t) / 60000, (nextMidnight - t) / 60000, tierLeft);
      const isRest = rest(cur.slice(0, 10));
      const key = (isRest ? ['rest', 'rest_ot1', 'rest_ot2'] : ['regular', 'ot1', 'ot2'])[tier];
      out[key] += chunk;
      done += chunk;
      t += chunk * 60000;
    }
  }
  for (const k of BUCKETS) out[k] = Math.round(out[k]);
  return out;
}

/**
 * Monthly (or any range) payroll data.
 * Returns { from, to, labels, rates, employees: [{ ...employee, buckets, days: [...] }] }.
 */
export function buildPayroll({ from, to, employee_id = null, department_id = null, location_id = null, scope = null }, { includeWage = false } = {}) {
  const db = getDb();
  const now = nowLocal();
  const where = ["s.status = 'scheduled'", 's.start_at >= @from', 's.start_at < @to'];
  const p = { from: `${from}T00:00`, to: `${addDays(to, 1)}T00:00` };
  if (employee_id) { where.push('s.employee_id = @employee_id'); p.employee_id = employee_id; }
  if (department_id) { where.push('e.department_id = @department_id'); p.department_id = department_id; }
  if (location_id) { where.push('COALESCE(s.location_id, e.location_id) = @location_id'); p.location_id = location_id; }
  const sw = scopeWhere(scope, { e: 'e', s: 's' });
  if (sw) where.push(sw.replace(/^ AND /, ''));
  const rows = db.prepare(
    `SELECT s.id, s.employee_id, s.start_at, s.end_at, a.clock_in_at, a.clock_out_at, a.marked_absent, a.note,
            e.first_name || ' ' || e.last_name AS employee_name, e.employee_code, e.national_id, e.hourly_wage,
            d.name AS department_name, ps.name AS position_name
     FROM shifts s JOIN employees e ON e.id = s.employee_id
     LEFT JOIN attendance a ON a.shift_id = s.id
     LEFT JOIN departments d ON d.id = e.department_id
     LEFT JOIN positions ps ON ps.id = e.position_id
     WHERE ${where.join(' AND ')} ORDER BY e.first_name, e.last_name, s.start_at`,
  ).all(p);

  const holidayByDate = new Map();
  for (const h of holidaysBetween(from, to)) holidayByDate.set(h.date, [holidayByDate.get(h.date), h.name].filter(Boolean).join(', '));
  const opts = { dailyMinutes: getNumberSetting('overtime_daily_hours') * 60, tier1Minutes: getNumberSetting('ot_tier1_hours') * 60, restCache: new Map() };
  const r = rates();

  const emps = new Map();
  for (const row of rows) {
    if (!emps.has(row.employee_id)) {
      emps.set(row.employee_id, {
        employee_id: row.employee_id, employee_code: row.employee_code, employee_name: row.employee_name,
        national_id: row.national_id || '', department_name: row.department_name || '', position_name: row.position_name || '',
        ...(includeWage ? { hourly_wage: row.hourly_wage || 0 } : {}),
        days: new Map(), absences: 0, late_count: 0, late_minutes: 0,
      });
    }
    const e = emps.get(row.employee_id);
    const date = row.start_at.slice(0, 10);
    if (!e.days.has(date)) e.days.set(date, { date, shifts: [], intervals: [] });
    const day = e.days.get(date);
    const att = computeAttendance(row, now);
    if (row.start_at <= now) {
      if (att.attendance_status === 'absent') e.absences += 1;
      if (att.late_minutes > 0) { e.late_count += 1; e.late_minutes += att.late_minutes; }
    }
    const iv = workedInterval(row, now);
    if (iv) day.intervals.push(iv);
    day.shifts.push({
      shift_id: row.id, planned: `${row.start_at.slice(11, 16)}–${row.end_at.slice(11, 16)}`,
      clock_in_at: row.clock_in_at, clock_out_at: row.clock_out_at, absent: att.attendance_status === 'absent' && row.start_at <= now,
      late_minutes: att.late_minutes, note: row.note || '',
    });
  }

  const employees = [...emps.values()].map((e) => {
    const buckets = emptyBuckets();
    const days = [...e.days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
      d.intervals.sort((x, y) => x[0].localeCompare(y[0]));
      const b = splitDay(d.intervals, opts);
      for (const k of BUCKETS) buckets[k] += b[k];
      const worked = d.intervals.reduce((t, [x, y]) => t + minutesBetween(x, y), 0);
      return { date: d.date, holiday: holidayByDate.get(d.date) || '', rest_day: opts.restCache.get(d.date) ?? isRestDay(d.date), shifts: d.shifts, worked_minutes: worked, buckets: b };
    });
    const total = BUCKETS.reduce((t, k) => t + buckets[k], 0);
    const payUnits = BUCKETS.reduce((t, k) => t + (buckets[k] / 60) * r[k], 0); // hours × rate
    return {
      ...e, days, buckets, total_minutes: total, days_worked: days.filter((d) => d.worked_minutes > 0).length,
      overtime_minutes: buckets.ot1 + buckets.ot2 + buckets.rest_ot1 + buckets.rest_ot2,
      pay_hours: +payUnits.toFixed(2),
      ...(includeWage ? { gross: +(payUnits * (e.hourly_wage || 0)).toFixed(2) } : {}),
    };
  });
  return { from, to, rates: r, labels: bucketLabels(), employees };
}

/** Per-employee pay summary used by the general report (no day details). */
export function payrollSummaryByEmployee(filters) {
  const map = new Map();
  for (const e of buildPayroll(filters, { includeWage: true }).employees) map.set(e.employee_id, e);
  return map;
}
