// Shared SELECT fragments so every endpoint returns consistent shapes.
export const EMPLOYEE_COLUMNS = `
  e.id, e.employee_code, e.first_name, e.last_name, e.first_name || ' ' || e.last_name AS full_name,
  e.phone, e.email, e.avatar, e.position_id, p.name AS position_name, e.department_id,
  d.name AS department_name, d.color AS department_color, e.location_id, l.name AS location_name,
  e.start_date, e.status, e.hourly_wage, e.can_lead, e.national_id, e.created_at, e.updated_at,
  (SELECT group_concat(x.location_id) FROM employee_locations x WHERE x.employee_id = e.id) AS extra_location_ids`;

export const EMPLOYEE_JOINS = `
  LEFT JOIN positions p ON p.id = e.position_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN locations l ON l.id = e.location_id`;

export const SHIFT_COLUMNS = `
  s.id, s.employee_id, s.start_at, s.end_at, s.position_id, sp.name AS position_name, s.location_id,
  sl.name AS location_name, s.note, s.status, s.created_at, s.updated_at, s.is_lead, s.shift_type_id,
  e.first_name || ' ' || e.last_name AS employee_name, e.avatar AS employee_avatar,
  e.department_id, d.name AS department_name, d.color AS department_color,
  a.clock_in_at, a.clock_out_at, a.marked_absent, a.note AS attendance_note, a.clock_in_distance_m, a.clock_out_distance_m`;

export const SHIFT_JOINS = `
  JOIN employees e ON e.id = s.employee_id
  LEFT JOIN positions sp ON sp.id = s.position_id
  LEFT JOIN locations sl ON sl.id = s.location_id
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN attendance a ON a.shift_id = s.id`;

/** Remove wage information unless the viewer may see it. */
export function scrubEmployee(emp, req) {
  if (!emp) return emp;
  let out = { ...emp };
  if ('extra_location_ids' in out) out.extra_location_ids = out.extra_location_ids ? String(out.extra_location_ids).split(',').map(Number) : [];
  if (!req.can('employees.wage')) { const { hourly_wage, ...rest } = out; out = rest; }
  // ת"ז is visible only to employee managers and to the employee themself
  if (!req.can('employees.manage') && req.user.employee_id !== emp.id) { const { national_id, ...rest } = out; out = rest; }
  return out;
}
