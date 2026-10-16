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
  'attendance.manage': 'עדכון נוכחות עובדים',
  'incidents.report': 'דיווח על אירועים',
  'tasks.manage': 'ניהול משימות',
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
    'incidents.report', 'tasks.manage',
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
}

export function clearPermissionCache() {
  cache.clear();
}
