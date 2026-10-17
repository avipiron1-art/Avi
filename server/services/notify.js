import { getDb } from '../db/index.js';
import { permissionsForUser } from './permissions.js';

const ins = () =>
  getDb().prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)');

/** Notify a single user. */
export function notifyUser(userId, { type, title, body = null, link = null }) {
  if (!userId) return;
  ins().run(userId, type, title, body, link);
}

/** Notify the user account linked to an employee (if any). */
export function notifyEmployee(employeeId, payload) {
  const u = getDb().prepare('SELECT id FROM users WHERE employee_id = ? AND is_active = 1').get(employeeId);
  if (u) notifyUser(u.id, payload);
}

/** Notify every active user that holds a given permission (role or personal grant). */
export function notifyPermission(permission, payload, { exceptUserId = null } = {}) {
  const users = getDb()
    .prepare('SELECT u.id, r.key AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1')
    .all();
  const stmt = ins();
  for (const u of users) {
    if (u.id === exceptUserId || !permissionsForUser(u.id, u.role).has(permission)) continue;
    stmt.run(u.id, payload.type, payload.title, payload.body ?? null, payload.link ?? null);
  }
}
