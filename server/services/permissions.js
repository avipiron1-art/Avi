import { getDb } from '../db/index.js';

/** Catalogue of permissions (key -> Hebrew label). */
export const PERMISSIONS = {
  'employees.view': 'צפייה ברשימת העובדים',
  'employees.manage': 'הוספה ועריכה של עובדים',
  'employees.delete': 'מחיקת עובדים',
  'employees.wage': 'צפייה ועריכה של שכר שעתי',
  'employees.notes': 'הוספת הערות מנהל',
  'shifts.view_all': 'צפייה בכל המשמרות',
  'shifts.manage': 'יצירה ועריכה של משמרות',
  'schedule.manage': 'בניית סידור עבודה לפי העדפות (הגדרת משמרות, שיבוץ ואישור)',
  'attendance.manage': 'עדכון נוכחות עובדים',
  'incidents.report': 'דיווח על אירועים',
  'tasks.manage': 'ניהול משימות',
  'announcements.manage': 'פרסום הודעות לעובדים',
  'requests.review': 'אישור ודחיית בקשות',
  'reports.view': 'צפייה בדוחות וייצוא',
  'settings.manage': 'ניהול הגדרות מערכת',
  'users.manage': 'ניהול משתמשים והרשאות',
  'audit.view': 'צפייה ביומן פעולות',
};

export const DEFAULT_ROLE_PERMISSIONS = {
  admin: Object.keys(PERMISSIONS),
  shift_manager: [
    'employees.view', 'employees.notes', 'shifts.view_all', 'attendance.manage',
    'incidents.report', 'tasks.manage', 'announcements.manage',
  ],
  employee: [],
};

const cache = new Map();

export function permissionsForRole(roleKey) {
  if (roleKey === 'admin') return new Set(Object.keys(PERMISSIONS)); // admin is never locked out
  if (!cache.has(roleKey)) {
    const rows = getDb()
      .prepare('SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = ?')
      .all(roleKey);
    cache.set(roleKey, new Set(rows.map((r) => r.permission).filter((p) => p in PERMISSIONS)));
  }
  return cache.get(roleKey);
}

export function setRolePermissions(roleKey, perms) {
  const db = getDb();
  const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(roleKey);
  db.transaction(() => {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
    const ins = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const p of perms) if (p in PERMISSIONS) ins.run(role.id, p);
  })();
  cache.delete(roleKey);
  userCache.clear();
}

export function clearPermissionCache() {
  cache.clear();
  userCache.clear();
}

// ---------------- per-user overrides ----------------
const userCache = new Map();

/** Raw overrides for a user: { permission: true (granted) | false (revoked) } */
export function userOverrides(userId) {
  const rows = getDb().prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?').all(userId);
  return Object.fromEntries(rows.filter((r) => r.permission in PERMISSIONS).map((r) => [r.permission, !!r.granted]));
}

/** Effective permissions = role permissions + personal grants − personal revokes. */
export function permissionsForUser(userId, roleKey) {
  if (roleKey === 'admin') return permissionsForRole('admin');
  const key = `${userId}:${roleKey}`;
  if (!userCache.has(key)) {
    const set = new Set(permissionsForRole(roleKey));
    for (const [p, granted] of Object.entries(userOverrides(userId))) {
      if (granted) set.add(p); else set.delete(p);
    }
    userCache.set(key, set);
  }
  return userCache.get(key);
}

/** Replace a user's overrides. `effective` is the full list the user should end up with. */
export function setUserPermissions(userId, roleKey, effective) {
  const db = getDb();
  const role = permissionsForRole(roleKey);
  const want = new Set(effective.filter((p) => p in PERMISSIONS));
  db.transaction(() => {
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_permissions (user_id, permission, granted) VALUES (?, ?, ?)');
    for (const p of Object.keys(PERMISSIONS)) {
      if (want.has(p) && !role.has(p)) ins.run(userId, p, 1);
      if (!want.has(p) && role.has(p)) ins.run(userId, p, 0);
    }
  })();
  userCache.clear();
}
