import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { permissionsForUser } from '../services/permissions.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { resolveScope, scopeWhere } from '../services/scope.js';

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
  const scope = resolveScope(row);
  // A shift-lead role's permissions only work while the person is leading a shift
  const permissions = scope.type === 'lead' && !scope.active ? new Set() : permissionsForUser(row.id, row.role);
  req.user = { ...row, permissions, scope };
  if (scope.type === 'lead' && scope.active) req.user.lead_scope = scope.lead;
  req.can = (p) => req.user.permissions.has(p);
  next();
}

/** SQL condition for the current user's scope – see services/scope.js. */
export const scopeSql = (req, opts = { s: 's' }) => scopeWhere(req.user?.scope, opts);

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
