// Attendance calculations. Planned times come from the shift; actual times from attendance.
import { getNumberSetting } from '../services/settings.js';
import { minutesBetween, nowLocal } from './time.js';

/**
 * Compute derived attendance metrics for a row containing:
 * start_at, end_at (planned) and optionally clock_in_at, clock_out_at, marked_absent.
 */
export function computeAttendance(row, now = nowLocal()) {
  const grace = getNumberSetting('late_grace_minutes');
  const earlyGrace = getNumberSetting('early_leave_grace_minutes');
  const otThreshold = getNumberSetting('overtime_daily_hours') * 60;
  const plannedMinutes = minutesBetween(row.start_at, row.end_at);
  const { clock_in_at: inAt, clock_out_at: outAt } = row;

  let workedMinutes = 0;
  if (inAt) workedMinutes = Math.max(0, minutesBetween(inAt, outAt || (now < row.end_at ? now : row.end_at)));
  if (inAt && !outAt && now >= row.end_at) workedMinutes = Math.max(0, minutesBetween(inAt, row.end_at)); // forgot to clock out

  const lateMinutes = inAt ? Math.max(0, minutesBetween(row.start_at, inAt)) : 0;
  const isLate = lateMinutes > grace;
  const earlyLeaveMinutes = outAt ? Math.max(0, minutesBetween(outAt, row.end_at)) : 0;
  const isEarlyLeave = earlyLeaveMinutes > earlyGrace;
  const overtimeMinutes = outAt ? Math.max(0, workedMinutes - Math.max(otThreshold, plannedMinutes)) : 0;

  let status;
  if (row.marked_absent) status = 'absent';
  else if (outAt) status = 'finished';
  else if (inAt) status = 'on_shift';
  else if (now >= row.end_at) status = 'absent';
  else if (now > row.start_at && minutesBetween(row.start_at, now) > grace) status = 'late';
  else status = 'not_started';

  return {
    planned_minutes: plannedMinutes,
    worked_minutes: workedMinutes,
    late_minutes: isLate ? lateMinutes : 0,
    is_late: isLate || status === 'late',
    early_leave_minutes: isEarlyLeave ? earlyLeaveMinutes : 0,
    is_early_leave: isEarlyLeave,
    overtime_minutes: overtimeMinutes,
    attendance_status: status,
  };
}

/** SQL fragment: shift joined with its attendance row (alias a). */
export const SHIFT_ATTENDANCE_JOIN = 'LEFT JOIN attendance a ON a.shift_id = s.id';
