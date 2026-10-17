import { getDb } from '../db/index.js';
import { permissionsForUser } from './permissions.js';
import { pushToUser } from './push.js';
import { queueNotificationEmail } from './mailer.js';

// Notifications that are also worth an email (the rest stay in the app + phone push).
const EMAIL_TYPES = new Set(['employee_joined', 'request_new', 'request_approved', 'request_rejected', 'shift_assigned', 'shift_changed', 'shift_cancelled', 'swap_pending']);
const wantsEmail = (p) => EMAIL_TYPES.has(p.type) || (p.type === 'announcement' && p.urgent) || p.email === true;

const ins = () =>
  getDb().prepare('INSERT INTO notifications (user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?)');

/** Notify a single user. */
export function notifyUser(userId, { type, title, body = null, link = null, urgent = false, email = false }) {
  if (!userId) return;
  ins().run(userId, type, title, body, link);
  pushToUser(userId, { title, body, link, tag: type, urgent });
  if (wantsEmail({ type, urgent, email })) queueNotificationEmail(userId, { title, body, link });
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
    pushToUser(u.id, { title: payload.title, body: payload.body, link: payload.link, tag: payload.type, urgent: payload.urgent });
    if (wantsEmail(payload)) queueNotificationEmail(u.id, payload);
  }
}
