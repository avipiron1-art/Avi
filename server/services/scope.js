// Responsibility scopes: every role says WHO its permissions apply to.
//   all            – the whole chain
//   branch         – the user's branch
//   branches       – a list of branches picked for the user (e.g. an area manager)
//   department     – the user's department in the user's branch
//   department_all – the user's department in every branch
//   lead           – only while leading a shift (אחמ"ש), only the people in that shift
//   self           – only the user's own records
// The checks here are used by every route, so a manager never sees or changes people outside their scope.
import { getDb } from '../db/index.js';
import { addMinutes, nowLocal } from '../lib/time.js';

export const SCOPES = {
  all: 'כל הרשת',
  branch: 'הסניף שלו',
  branches: 'סניפים שנבחרו',
  department: 'המחלקה שלו בסניף שלו',
  department_all: 'המחלקה שלו בכל הסניפים',
  lead: 'רק במשמרות שבהן הוא אחמ"ש',
  self: 'רק על עצמו',
};
export const SCOPE_KEYS = Object.keys(SCOPES);

const roleScopeCache = new Map();
export function roleScope(roleKey) {
  if (roleKey === 'admin') return 'all';
  if (!roleScopeCache.has(roleKey)) {
    const r = getDb().prepare('SELECT scope FROM roles WHERE key = ?').get(roleKey);
    roleScopeCache.set(roleKey, SCOPE_KEYS.includes(r?.scope) ? r.scope : 'self');
  }
  return roleScopeCache.get(roleKey);
}
export const clearScopeCache = () => roleScopeCache.clear();

/** True when the business has no branches defined – branch-based scopes then cover everyone. */
const noBranches = () => !getDb().prepare('SELECT 1 FROM locations LIMIT 1').get();

/** The shift this employee is leading now (30 min before start until 30 min after the end), or null. */
export function leadShiftNow(employeeId, now = nowLocal()) {
  if (!employeeId) return null;
  const s = getDb().prepare(
    `SELECT s.id, s.start_at, s.end_at, COALESCE(s.location_id, e.location_id) AS location_id FROM shifts s JOIN employees e ON e.id = s.employee_id
     WHERE s.employee_id = ? AND s.is_lead = 1 AND s.status = 'scheduled' AND s.start_at <= ? AND s.end_at >= ? ORDER BY s.start_at LIMIT 1`,
  ).get(employeeId, addMinutes(now, 30), addMinutes(now, -30));
  return s ? { shift_id: s.id, from: s.start_at, to: s.end_at, location_id: s.location_id } : null;
}

/** The branch and department a user is responsible for: set on the user, else taken from their employee card. */
export function userHome(userId) {
  return getDb().prepare(
    `SELECT u.employee_id, COALESCE(u.location_id, e.location_id) AS location_id, COALESCE(u.department_id, e.department_id) AS department_id
     FROM users u LEFT JOIN employees e ON e.id = u.employee_id WHERE u.id = ?`,
  ).get(userId) || {};
}

/**
 * Resolve a user's scope into concrete limits:
 * { type, all?, locs?: number[], dep?: number, window?: {from,to}, self: employeeId, active, missing? }
 */
export function resolveScope(user) {
  const type = roleScope(user.role);
  const home = userHome(user.id);
  const self = user.employee_id || home.employee_id || null;
  const base = { type, self, active: true };
  if (type === 'all') return { ...base, all: true };
  if (type === 'self') return { ...base, locs: null, dep: null, selfOnly: true };
  if (type === 'lead') {
    const lead = leadShiftNow(self);
    if (!lead) return { ...base, active: false, selfOnly: true };
    return { ...base, lead, window: { from: lead.from, to: lead.to }, locs: lead.location_id ? [lead.location_id] : null };
  }
  const nb = noBranches();
  if (type === 'branch') {
    if (nb) return { ...base, all: true };
    return home.location_id ? { ...base, locs: [home.location_id] } : { ...base, selfOnly: true, missing: 'branch' };
  }
  if (type === 'branches') {
    if (nb) return { ...base, all: true };
    const locs = getDb().prepare('SELECT location_id FROM user_locations WHERE user_id = ?').all(user.id).map((r) => r.location_id);
    if (!locs.length && home.location_id) locs.push(home.location_id);
    return locs.length ? { ...base, locs } : { ...base, selfOnly: true, missing: 'branch' };
  }
  if (type === 'department' || type === 'department_all') {
    if (!home.department_id) return { ...base, selfOnly: true, missing: 'department' };
    if (type === 'department_all' || nb) return { ...base, dep: home.department_id };
    return home.location_id ? { ...base, locs: [home.location_id], dep: home.department_id } : { ...base, selfOnly: true, missing: 'branch' };
  }
  return { ...base, selfOnly: true };
}

const ints = (list) => list.map((n) => Number(n)).filter((n) => Number.isInteger(n)).join(',') || '-1';
const ts = (v) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `'${v}'` : "''");

/**
 * SQL condition (starting with " AND ") limiting rows to the scope.
 *  e: employees alias (required) · s: shifts alias, when rows are shifts (branch = the shift's branch)
 *  includeSelf: also allow the user's own rows
 * Values are integers / validated timestamps, so they are inlined safely.
 */
export function scopeWhere(scope, { e = 'e', s = null, includeSelf = true } = {}) {
  if (!scope || scope.all) return '';
  const selfCond = includeSelf && scope.self ? `${e}.id = ${Number(scope.self)}` : null;
  if (scope.selfOnly) return ` AND (${selfCond || '0'})`;
  const parts = [];
  if (scope.locs) {
    const l = ints(scope.locs);
    parts.push(s
      ? `COALESCE(${s}.location_id, ${e}.location_id) IN (${l})`
      : `(${e}.location_id IN (${l}) OR EXISTS (SELECT 1 FROM employee_locations el WHERE el.employee_id = ${e}.id AND el.location_id IN (${l})))`);
  }
  if (scope.dep) parts.push(`${e}.department_id = ${Number(scope.dep)}`);
  if (scope.window) {
    if (s) parts.push(`${s}.start_at < ${ts(scope.window.to)} AND ${s}.end_at > ${ts(scope.window.from)}`);
    else parts.push(`EXISTS (SELECT 1 FROM shifts ws WHERE ws.employee_id = ${e}.id AND ws.status = 'scheduled' AND ws.start_at < ${ts(scope.window.to)} AND ws.end_at > ${ts(scope.window.from)}${scope.locs ? ` AND COALESCE(ws.location_id, ${e}.location_id) IN (${ints(scope.locs)})` : ''})`);
  }
  const cond = parts.length ? `(${parts.join(' AND ')})` : '1';
  return ` AND (${cond}${selfCond ? ` OR ${selfCond}` : ''})`;
}

/** Is this employee inside the scope? */
export function employeeInScope(scope, employeeId, opts = {}) {
  if (!scope || scope.all) return true;
  return !!getDb().prepare(`SELECT 1 FROM employees e WHERE e.id = ? ${scopeWhere(scope, opts)}`).get(employeeId);
}

/** Is this shift inside the scope? (branch = the shift's branch) */
export function shiftInScope(scope, shiftId, opts = {}) {
  if (!scope || scope.all) return true;
  return !!getDb().prepare(`SELECT 1 FROM shifts s JOIN employees e ON e.id = s.employee_id WHERE s.id = ? ${scopeWhere(scope, { ...opts, s: 's' })}`).get(shiftId);
}

/** May the user act on a branch (create a shift there, schedule it, invite to it)? null branch = "no branch". */
export function locationInScope(scope, locationId) {
  if (!scope || scope.all) return true;
  if (scope.selfOnly) return false;
  if (!scope.locs) return true; // department in every branch: any branch (the people are still limited to the department)
  return locationId != null && scope.locs.includes(Number(locationId));
}

/** Branches the user can pick on screens (board, filters). [] = no branches defined. */
export function scopeBranches(scope) {
  const all = getDb().prepare('SELECT id, name FROM locations WHERE is_active = 1 ORDER BY name').all();
  if (!scope || scope.all || (scope.dep && !scope.locs)) return all;
  if (!scope.locs) return [];
  return all.filter((l) => scope.locs.includes(l.id));
}

/** Short Hebrew description for screens ("סניף חיפה", "מטבח · 3 סניפים"…). */
export function describeScope(scope) {
  if (!scope) return '';
  if (scope.all) return SCOPES.all;
  if (scope.type === 'lead') return scope.active ? 'אחמ"ש במשמרת עכשיו' : 'אחמ"ש (לא במשמרת כרגע)';
  if (scope.missing === 'branch') return 'לא הוגדר סניף';
  if (scope.missing === 'department') return 'לא הוגדרה מחלקה';
  if (scope.selfOnly) return SCOPES.self;
  const db = getDb();
  const locNames = scope.locs ? scope.locs.map((id) => db.prepare('SELECT name FROM locations WHERE id = ?').get(id)?.name).filter(Boolean) : [];
  const dep = scope.dep ? db.prepare('SELECT name FROM departments WHERE id = ?').get(scope.dep)?.name : null;
  const where = !scope.locs ? 'כל הסניפים' : locNames.length > 2 ? `${locNames.length} סניפים` : locNames.join(', ');
  return dep ? `${dep} · ${where}` : where;
}
