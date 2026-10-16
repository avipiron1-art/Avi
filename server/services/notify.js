import { getDb } from '../db/index.js';

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

/** Notify every active user that holds a given permission (admins always included). */
export function notifyPermission(permission, payload, { exceptUserId = null } = {}) {
  const db = getDb();
  const users = db
    .prepare(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.is_active = 1 AND (r.key = 'admin' OR EXISTS (
         SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission = ?))`,
    )
    .all(permission);
  const stmt = ins();
  for (const u of users) if (u.id !== exceptUserId) stmt.run(u.id, payload.type, payload.title, payload.body ?? null, payload.link ?? null);
}
