import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { permissionsForUser } from '../services/permissions.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { addMinutes, nowLocal } from '../lib/time.js';

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Create a DB-backed session and set the cookies. */
export function startSession(req, res, userId, remember) {
  const token = newToken();
  const ttlMs = remember ? config.session.rememberTtlDays * 86400000 : config.session.shortTtlHours * 3600000;
  const expires = new Date(Date.now() + ttlMs);
  getDb()
    .prepare('INSERT INTO sessions (token_hash, user_id, remember, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, remember ? 1 : 0, expires.toISOString().replace('T', ' ').slice(0, 19), req.ip, String(req.get('user-agent') || '').slice(0, 200));
  const base = { sameSite: 'strict', secure: config.isProd, path: '/' };
  res.cookie(config.session.cookieName, token, { ...base, httpOnly: true, ...(remember ? { expires } : {}) });
  // Double-submit CSRF token (readable by the SPA, echoed in the X-CSRF-Token header)
  res.cookie('csrf', newToken(), { ...base, httpOnly: false, ...(remember ? { expires } : {}) });
}

export function endSession(req, res) {
  const token = req.cookies?.[config.session.cookieName];
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(config.session.cookieName, { path: '/' });
  res.clearCookie('csrf', { path: '/' });
}

/** Load the current user (if any) from the session cookie. */
export function authenticate(req, _res, next) {
  const token = req.cookies?.[config.session.cookieName];
  if (!token) return next();
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, s.remember, u.id, u.username, u.email, u.display_name, u.employee_id,
              u.is_active, u.location_id, r.key AS role, r.name AS role_name
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return next();
  if (row.expires_at < sqlNow() || !row.is_active) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return next();
  }
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(row.session_id);
  const permissions = permissionsForUser(row.id, row.role);
  req.user = { ...row, permissions };
  // Shift lead (אחמ"ש) on duty right now: temporary rights to run attendance for their own shift only.
  if (row.employee_id && !permissions.has('attendance.manage')) {
    const lead = leadShiftNow(row.employee_id);
    if (lead) {
      req.user.permissions = new Set([...permissions, 'attendance.manage', 'incidents.report']);
      req.user.lead_scope = lead;
    }
  }
  req.can = (p) => req.user.permissions.has(p);
  next();
}

/** The shift this employee is leading now (30 min before start until 30 min after the end), or null. */
export function leadShiftNow(employeeId, now = nowLocal()) {
  const s = getDb().prepare(
    `SELECT s.id, s.start_at, s.end_at, COALESCE(s.location_id, e.location_id) AS location_id FROM shifts s JOIN employees e ON e.id = s.employee_id
     WHERE s.employee_id = ? AND s.is_lead = 1 AND s.status = 'scheduled' AND s.start_at <= ? AND s.end_at >= ? ORDER BY s.start_at LIMIT 1`,
  ).get(employeeId, addMinutes(now, 30), addMinutes(now, -30));
  return s ? { shift_id: s.id, from: s.start_at, to: s.end_at, location_id: s.location_id } : null;
}

/**
 * SQL condition limiting rows to what the viewer may manage:
 * a branch manager (users.location_id) sees only their branch; an on-duty shift lead only their shift's colleagues.
 * `s` = shifts alias (or null), `e` = employees alias.
 */
export function scopeSql(req, { s = 's', e = 'e' } = {}) {
  const parts = [];
  const params = {};
  if (req.user?.location_id) {
    parts.push(s ? `COALESCE(${s}.location_id, ${e}.location_id) = @scope_loc` : `${e}.location_id = @scope_loc`);
    params.scope_loc = req.user.location_id;
  }
  const lead = req.user?.lead_scope;
  if (lead && s) {
    parts.push(`${s}.start_at < @lead_to AND ${s}.end_at > @lead_from`);
    params.lead_to = lead.to; params.lead_from = lead.from;
    if (lead.location_id) { parts.push(`COALESCE(${s}.location_id, ${e}.location_id) = @lead_loc`); params.lead_loc = lead.location_id; }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

/** Require at least one of the given permissions. */
export const requirePerm = (...perms) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!perms.some((p) => req.user.permissions.has(p))) return next(forbidden());
  next();
};

/** Require the user to be linked to an employee record (self-service actions). */
export function requireEmployee(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.employee_id) return next(forbidden('פעולה זו זמינה רק למשתמשים המשויכים לכרטיס עובד'));
  next();
}

/** CSRF protection for state-changing requests (double-submit cookie). */
export function csrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.cookies?.[config.session.cookieName]) return next(); // unauthenticated endpoints (login etc.)
  const header = req.get('x-csrf-token');
  if (!header || header !== req.cookies.csrf) return next(forbidden('פג תוקף הבקשה. יש לרענן את הדף ולנסות שוב'));
  next();
}
