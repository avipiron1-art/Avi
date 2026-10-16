import { getDb } from '../db/index.js';

/**
 * Append an entry to the immutable audit log.
 * @param {object} req  express request (for actor + ip); may be null for system actions
 */
export function audit(req, { action, entityType = null, entityId = null, description, oldValue = null, newValue = null }) {
  const user = req?.user;
  getDb()
    .prepare(
      `INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, description, old_value, new_value, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      user?.id ?? null,
      user?.display_name ?? 'מערכת',
      action,
      entityType,
      entityId,
      description,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      req?.ip ?? null,
    );
}

/** Return only the keys whose values differ between two objects. */
export function diff(before, after, keys) {
  const oldV = {};
  const newV = {};
  for (const k of keys) {
    if (after[k] !== undefined && before[k] !== after[k]) {
      oldV[k] = before[k];
      newV[k] = after[k];
    }
  }
  return Object.keys(newV).length ? { oldValue: oldV, newValue: newV } : null;
}
