// Announcements board: managers post messages by urgency; "must confirm" messages pop up
// for every employee until they press "read and confirmed", and managers see who confirmed.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zDate, zOptId, zOptText, zText, paramId } from '../lib/validate.js';
import { nowLocal } from '../lib/time.js';
import { audit } from '../services/audit.js';
import { notifyUser } from '../services/notify.js';

const router = Router();
const URGENCY = ['low', 'normal', 'high', 'critical'];
const URGENCY_LABEL = { low: 'לידיעה', normal: 'רגילה', high: 'חשובה', critical: 'דחופה' };

/** Where the viewer belongs (branch / department) – used to target announcements. */
function viewerScope(user) {
  const db = getDb();
  const emp = user.employee_id ? db.prepare('SELECT location_id, department_id FROM employees WHERE id = ?').get(user.employee_id) : null;
  const locs = [emp?.location_id ?? user.location_id];
  if (user.employee_id) locs.push(...db.prepare('SELECT location_id FROM employee_locations WHERE employee_id = ?').all(user.employee_id).map((r) => r.location_id));
  return { locs: JSON.stringify(locs.filter(Boolean)), dep: emp?.department_id ?? null };
}

// an employee who works in several branches sees the announcements of all of them
const VISIBLE = `(a.location_id IS NULL OR a.location_id IN (SELECT value FROM json_each(@locs))) AND (a.department_id IS NULL OR a.department_id = @dep)
  AND (a.expires_at IS NULL OR a.expires_at > @now)`;

/** Announcements a manager may see in the management view / edit (by their responsibility scope). */
function manageWhere(req) {
  const sc = req.user.scope;
  if (sc.all) return '';
  const locs = sc.locs ? sc.locs.map(Number).join(',') || '-1' : null;
  const inScope = [
    locs ? `(a.location_id IS NULL OR a.location_id IN (${locs}))` : '1',
    sc.dep ? `(a.department_id IS NULL OR a.department_id = ${Number(sc.dep)})` : '1',
  ].join(' AND ');
  return `AND (a.created_by = ${Number(req.user.id)} OR (${inScope}))`;
}

/** Posting: a branch / department manager can only address their own branch / department. */
function fitToScope(req, d) {
  const sc = req.user.scope;
  if (sc.all) return;
  if (sc.selfOnly || sc.window) throw forbidden('אין לך הרשאה לפרסם הודעות');
  if (sc.locs) {
    if (!d.location_id && sc.locs.length === 1) d.location_id = sc.locs[0];
    if (!sc.locs.includes(Number(d.location_id))) throw badRequest('יש לבחור סניף שבאחריותך', { fields: { location_id: 'סניף מחוץ לאחריותך' } });
  }
  if (sc.dep) d.department_id = sc.dep;
}

/** Active users an announcement is meant for (its author excluded). */
function audience(a) {
  return getDb().prepare(
    `SELECT u.id, u.display_name, e.id AS employee_id FROM users u LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.is_active = 1 AND u.id != @author
       AND (@loc IS NULL OR COALESCE(e.location_id, u.location_id) = @loc
            OR EXISTS (SELECT 1 FROM employee_locations x WHERE x.employee_id = e.id AND x.location_id = @loc))
       AND (@dep IS NULL OR COALESCE(e.department_id, u.department_id) = @dep)
     ORDER BY u.display_name`,
  ).all({ author: a.created_by ?? -1, loc: a.location_id, dep: a.department_id });
}

const SELECT = `SELECT a.*, u.display_name AS author_name, l.name AS location_name, d.name AS department_name,
  r.read_at, r.acked_at
  FROM announcements a LEFT JOIN users u ON u.id = a.created_by
  LEFT JOIN locations l ON l.id = a.location_id LEFT JOIN departments d ON d.id = a.department_id
  LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = @me`;
const ORDER = `ORDER BY CASE a.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, a.id DESC`;

router.get('/', (req, res) => {
  const db = getDb();
  const manage = req.can('announcements.manage');
  const p = { me: req.user.id, now: nowLocal(), ...viewerScope(req.user) };
  // Managers see everything from the last 90 days (incl. expired and other branches) with confirmation stats.
  const rows = manage
    ? db.prepare(`${SELECT} WHERE a.created_at > datetime('now','-90 day') ${manageWhere(req)} ${ORDER}`).all(p)
    : db.prepare(`${SELECT} WHERE ${VISIBLE} ${ORDER}`).all(p);
  const out = rows.map((a) => {
    const item = { ...a, requires_ack: !!a.requires_ack, expired: !!(a.expires_at && a.expires_at <= p.now), mine: a.created_by === req.user.id };
    if (manage) {
      const aud = audience(a);
      const reads = db.prepare('SELECT user_id, acked_at FROM announcement_reads WHERE announcement_id = ?').all(a.id);
      const ids = new Set(aud.map((x) => x.id));
      item.stats = { audience: aud.length, read: reads.filter((r) => ids.has(r.user_id)).length, acked: reads.filter((r) => r.acked_at && ids.has(r.user_id)).length };
    }
    return item;
  });
  res.json({ announcements: out, can_manage: manage, unread: out.filter((a) => !a.read_at && !a.expired && !a.mine).length });
});

router.get('/unread-count', (req, res) => {
  const p = { me: req.user.id, now: nowLocal(), ...viewerScope(req.user) };
  const r = getDb().prepare(`SELECT COUNT(*) AS n FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = @me
    WHERE ${VISIBLE} AND r.read_at IS NULL AND COALESCE(a.created_by, -1) != @me`).get(p);
  res.json({ unread: r.n });
});

/** Announcements that must be confirmed and are still waiting for me (drives the pop-up). */
router.get('/pending', (req, res) => {
  const p = { me: req.user.id, now: nowLocal(), ...viewerScope(req.user) };
  const rows = getDb().prepare(`${SELECT} WHERE ${VISIBLE} AND a.requires_ack = 1 AND r.acked_at IS NULL AND COALESCE(a.created_by, -1) != @me ${ORDER}`).all(p);
  res.json({ announcements: rows });
});

const schema = z.object({
  title: zText(120),
  body: zOptText(4000),
  urgency: z.enum(URGENCY).default('normal'),
  requires_ack: z.boolean().default(false),
  location_id: zOptId,
  department_id: zOptId,
  expires_on: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => (v ? `${v}T23:59` : null)),
});

function canEdit(req, a) {
  if (!req.can('announcements.manage')) return false;
  const sc = req.user.scope;
  if (sc.all || a.created_by === req.user.id) return true;
  if (sc.selfOnly || sc.window) return false;
  return (!sc.locs || sc.locs.includes(a.location_id)) && (!sc.dep || a.department_id === sc.dep);
}

router.post('/', ah((req, res) => {
  if (!req.can('announcements.manage')) throw forbidden();
  const d = validate(schema, req.body);
  fitToScope(req, d);
  if (d.expires_on && d.expires_on <= nowLocal()) throw badRequest('תאריך התפוגה כבר עבר', { fields: { expires_on: 'תאריך בעבר' } });
  const db = getDb();
  const id = db.prepare(
    `INSERT INTO announcements (title, body, urgency, requires_ack, location_id, department_id, expires_at, created_by)
     VALUES (@title, @body, @urgency, @requires_ack, @location_id, @department_id, @expires_on, @created_by)`,
  ).run({ ...d, requires_ack: d.requires_ack ? 1 : 0, created_by: req.user.id }).lastInsertRowid;
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  const urgent = d.urgency === 'high' || d.urgency === 'critical';
  const recipients = audience(a);
  for (const u of recipients) {
    notifyUser(u.id, {
      type: 'announcement', urgent,
      title: `${d.urgency === 'critical' ? '🔴 ' : d.urgency === 'high' ? '🟠 ' : ''}הודעה ${URGENCY_LABEL[d.urgency]}: ${d.title}`,
      body: d.requires_ack ? 'נדרש אישור קריאה' : (d.body || '').slice(0, 140), link: '/announcements',
    });
  }
  audit(req, { action: 'announcement.create', entityType: 'announcement', entityId: id, description: `${req.user.display_name} פרסם/ה הודעה (${URGENCY_LABEL[d.urgency]}): ${d.title}`, newValue: d });
  res.status(201).json({ id, recipients: recipients.length, message: `ההודעה פורסמה ל-${recipients.length} אנשים` });
}));

router.put('/:id', ah((req, res) => {
  const id = paramId(req.params.id);
  const db = getDb();
  const before = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!before) throw notFound('ההודעה לא נמצאה');
  if (!canEdit(req, before)) throw forbidden();
  const d = validate(schema, req.body);
  fitToScope(req, d);
  db.prepare(`UPDATE announcements SET title=@title, body=@body, urgency=@urgency, requires_ack=@requires_ack, location_id=@location_id,
    department_id=@department_id, expires_at=@expires_on WHERE id=@id`).run({ ...d, requires_ack: d.requires_ack ? 1 : 0, id });
  audit(req, { action: 'announcement.update', entityType: 'announcement', entityId: id, description: `${req.user.display_name} עדכן/ה הודעה: ${d.title}`, oldValue: before, newValue: d });
  res.json({ message: 'ההודעה עודכנה' });
}));

router.delete('/:id', ah((req, res) => {
  const id = paramId(req.params.id);
  const db = getDb();
  const before = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!before) throw notFound('ההודעה לא נמצאה');
  if (!canEdit(req, before)) throw forbidden();
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  audit(req, { action: 'announcement.delete', entityType: 'announcement', entityId: id, description: `${req.user.display_name} מחק/ה הודעה: ${before.title}`, oldValue: before });
  res.json({ message: 'ההודעה נמחקה' });
}));

function mark(req, ack) {
  const id = paramId(req.params.id);
  const db = getDb();
  const p = { me: req.user.id, now: nowLocal(), ...viewerScope(req.user), id };
  const a = db.prepare(`SELECT a.* FROM announcements a WHERE a.id = @id AND ((${VISIBLE}) OR @manage = 1)`).get({ ...p, manage: req.can('announcements.manage') ? 1 : 0 });
  if (!a) throw notFound('ההודעה לא נמצאה');
  db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id, acked_at) VALUES (@id, @me, CASE WHEN @ack = 1 THEN datetime('now') END)
    ON CONFLICT(announcement_id, user_id) DO UPDATE SET acked_at = COALESCE(acked_at, excluded.acked_at)`).run({ id, me: req.user.id, ack: ack ? 1 : 0 });
  return a;
}

router.post('/:id/read', ah((req, res) => { mark(req, false); res.json({ ok: true }); }));
router.post('/:id/ack', ah((req, res) => {
  const a = mark(req, true);
  audit(req, { action: 'announcement.ack', entityType: 'announcement', entityId: a.id, description: `${req.user.display_name} אישר/ה קריאת הודעה: ${a.title}` });
  res.json({ ok: true, message: 'תודה, האישור נשמר' });
}));

/** Who read / confirmed (managers). */
router.get('/:id/status', ah((req, res) => {
  const id = paramId(req.params.id);
  const db = getDb();
  const a = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!a) throw notFound('ההודעה לא נמצאה');
  if (!canEdit(req, a)) throw forbidden();
  const reads = new Map(db.prepare('SELECT user_id, read_at, acked_at FROM announcement_reads WHERE announcement_id = ?').all(id).map((r) => [r.user_id, r]));
  const people = audience(a).map((u) => ({ user_id: u.id, name: u.display_name, read_at: reads.get(u.id)?.read_at || null, acked_at: reads.get(u.id)?.acked_at || null }));
  res.json({ people });
}));

export default router;
