// Shift swap board: an employee offers a shift, a colleague takes it, a manager approves.
import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zId, zOptText, paramId } from '../lib/validate.js';
import { requireEmployee } from '../middleware/auth.js';
import { nowLocal, hhmm } from '../lib/time.js';
import { audit } from '../services/audit.js';
import { notifyEmployee, notifyPermission } from '../services/notify.js';
import { scopeWhere, shiftInScope } from '../services/scope.js';

const router = Router();
const canApprove = (req) => req.can('shifts.manage') || req.can('schedule.manage');
const describe = (s) => `${s.start_at.slice(8, 10)}/${s.start_at.slice(5, 7)} ⁦${hhmm(s.start_at)}–${hhmm(s.end_at)}⁩`;

const SELECT = `
  SELECT w.*, s.start_at, s.end_at, s.is_lead, s.location_id, s.status AS shift_status, l.name AS location_name,
         st.name AS type_name, eo.first_name || ' ' || eo.last_name AS offered_by_name, eo.avatar AS offered_by_avatar,
         et.first_name || ' ' || et.last_name AS taken_by_name, et.avatar AS taken_by_avatar
  FROM shift_swaps w JOIN shifts s ON s.id = w.shift_id
  JOIN employees eo ON eo.id = w.offered_by LEFT JOIN employees et ON et.id = w.taken_by
  LEFT JOIN locations l ON l.id = s.location_id LEFT JOIN shift_types st ON st.id = s.shift_type_id`;
/** SQL: the given branch is one where employee ? works (home or extra branch); always true without branches. */
const worksAt = (locExpr) => `(${locExpr} IS NULL OR NOT EXISTS (SELECT 1 FROM locations) OR ${locExpr} = (SELECT location_id FROM employees WHERE id = ?)
  OR EXISTS (SELECT 1 FROM employee_locations x WHERE x.employee_id = ? AND x.location_id = ${locExpr}))`;
const getSwap = (id) => getDb().prepare(`${SELECT} WHERE w.id = ?`).get(id);

router.get('/', (req, res) => {
  const db = getDb();
  const now = nowLocal();
  const me = req.user.employee_id || -1;
  // Open offers from colleagues in the branches I work in (when branches are used)
  const open = db.prepare(`${SELECT} WHERE w.status = 'open' AND s.start_at > ? AND w.offered_by != ? AND ${worksAt('COALESCE(s.location_id, eo.location_id)')} ORDER BY s.start_at`)
    .all(now, me, me, me);
  const mine = db.prepare(`${SELECT} WHERE (w.offered_by = ? OR w.taken_by = ?) AND (w.status IN ('open','taken') OR w.created_at > datetime('now','-30 day')) ORDER BY w.id DESC`).all(me, me);
  const pending = canApprove(req)
    ? db.prepare(`${SELECT} WHERE w.status = 'taken' ${scopeWhere(req.user.scope, { e: 'eo', s: 's', includeSelf: false })} ORDER BY s.start_at`).all()
    : [];
  // my shifts that can still be offered
  const offerable = req.user.employee_id ? db.prepare(
    `SELECT s.id, s.start_at, s.end_at, st.name AS type_name FROM shifts s LEFT JOIN shift_types st ON st.id = s.shift_type_id
     LEFT JOIN attendance a ON a.shift_id = s.id
     WHERE s.employee_id = ? AND s.status = 'scheduled' AND s.start_at > ? AND a.clock_in_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM shift_swaps w WHERE w.shift_id = s.id AND w.status IN ('open','taken'))
     ORDER BY s.start_at LIMIT 30`,
  ).all(me, now) : [];
  res.json({ open, mine, pending, offerable, can_approve: canApprove(req) });
});

router.post('/', requireEmployee, ah((req, res) => {
  const d = validate(z.object({ shift_id: zId, note: zOptText(300) }), req.body);
  const db = getDb();
  const s = db.prepare('SELECT * FROM shifts WHERE id = ?').get(d.shift_id);
  if (!s || s.employee_id !== req.user.employee_id) throw forbidden('אפשר להציע להחלפה רק משמרת שלך');
  if (s.status !== 'scheduled' || s.start_at <= nowLocal()) throw badRequest('אפשר להציע רק משמרת עתידית');
  if (db.prepare("SELECT 1 FROM shift_swaps WHERE shift_id = ? AND status IN ('open','taken')").get(s.id)) throw badRequest('המשמרת כבר מוצעת להחלפה');
  const id = db.prepare('INSERT INTO shift_swaps (shift_id, offered_by, note) VALUES (?, ?, ?)').run(s.id, req.user.employee_id, d.note).lastInsertRowid;
  audit(req, { action: 'swap.offer', entityType: 'shift', entityId: s.id, description: `${req.user.display_name} הציע/ה להחלפה את המשמרת ${describe(s)}` });
  // let colleagues in the same branch know
  const loc = s.location_id ?? db.prepare('SELECT location_id FROM employees WHERE id = ?').get(s.employee_id)?.location_id ?? null;
  const colleagues = db.prepare(`SELECT id FROM employees e WHERE status = 'active' AND id != ? AND (? IS NULL OR e.location_id IS NULL OR e.location_id = ?
    OR EXISTS (SELECT 1 FROM employee_locations x WHERE x.employee_id = e.id AND x.location_id = ?))`).all(req.user.employee_id, loc, loc, loc);
  for (const c of colleagues) notifyEmployee(c.id, { type: 'swap_offer', title: 'משמרת פנויה להחלפה', body: `${req.user.display_name} · ${describe(s)}`, link: '/schedule?tab=swaps' });
  res.status(201).json({ swap: getSwap(id), message: 'המשמרת פורסמה בלוח ההחלפות' });
}));

router.post('/:id/take', requireEmployee, ah((req, res) => {
  const id = paramId(req.params.id);
  const db = getDb();
  const w = getSwap(id);
  if (!w) throw notFound('ההצעה לא נמצאה');
  if (w.status !== 'open') throw badRequest('מישהו כבר לקח את המשמרת הזו');
  if (w.offered_by === req.user.employee_id) throw badRequest('זו המשמרת שלך');
  if (w.start_at <= nowLocal()) throw badRequest('המשמרת כבר התחילה');
  const branchOk = db.prepare(`SELECT 1 FROM shifts s JOIN employees eo ON eo.id = s.employee_id WHERE s.id = ? AND ${worksAt('COALESCE(s.location_id, eo.location_id)')}`)
    .get(w.shift_id, req.user.employee_id, req.user.employee_id);
  if (!branchOk) throw badRequest('המשמרת בסניף שאינך עובד/ת בו');
  const clash = db.prepare("SELECT 1 FROM shifts WHERE employee_id = ? AND status = 'scheduled' AND start_at < ? AND end_at > ?").get(req.user.employee_id, w.end_at, w.start_at);
  if (clash) throw badRequest('יש לך משמרת אחרת בשעות האלה');
  const r = db.prepare("UPDATE shift_swaps SET status = 'taken', taken_by = ? WHERE id = ? AND status = 'open'").run(req.user.employee_id, id);
  if (!r.changes) throw badRequest('מישהו כבר לקח את המשמרת הזו');
  audit(req, { action: 'swap.take', entityType: 'shift', entityId: w.shift_id, description: `${req.user.display_name} ביקש/ה לקחת את המשמרת של ${w.offered_by_name} (${describe(w)})` });
  notifyEmployee(w.offered_by, { type: 'swap_taken', title: 'מישהו לקח את המשמרת שהצעת', body: `${req.user.display_name} · ${describe(w)} – ממתין לאישור מנהל`, link: '/schedule?tab=swaps' });
  notifyPermission('schedule.manage', { type: 'swap_pending', title: 'החלפת משמרת ממתינה לאישור', body: `${w.offered_by_name} ← ${req.user.display_name} · ${describe(w)}`, link: '/schedule?tab=swaps' }, { exceptUserId: req.user.id, about: { shiftId: w.shift_id } });
  res.json({ swap: getSwap(id), message: 'הבקשה נשלחה לאישור המנהל' });
}));

router.post('/:id/cancel', ah((req, res) => {
  const id = paramId(req.params.id);
  const w = getSwap(id);
  if (!w) throw notFound('ההצעה לא נמצאה');
  const isOfferer = w.offered_by === req.user.employee_id;
  const isTaker = w.taken_by === req.user.employee_id;
  if (!isOfferer && !isTaker) throw forbidden();
  if (!['open', 'taken'].includes(w.status)) throw badRequest('לא ניתן לבטל בשלב הזה');
  const db = getDb();
  if (isTaker && !isOfferer) db.prepare("UPDATE shift_swaps SET status = 'open', taken_by = NULL WHERE id = ?").run(id); // taker withdraws → back on the board
  else db.prepare("UPDATE shift_swaps SET status = 'cancelled' WHERE id = ?").run(id);
  audit(req, { action: 'swap.cancel', entityType: 'shift', entityId: w.shift_id, description: `${req.user.display_name} ביטל/ה החלפת משמרת (${describe(w)})` });
  res.json({ ok: true, message: 'בוטל' });
}));

router.post('/:id/decide', ah((req, res) => {
  if (!canApprove(req)) throw forbidden();
  const id = paramId(req.params.id);
  const { approve } = validate(z.object({ approve: z.boolean() }), req.body);
  const w = getSwap(id);
  if (!w) throw notFound('ההצעה לא נמצאה');
  if (w.status !== 'taken') throw badRequest('אין מה לאשר בשלב הזה');
  if (!shiftInScope(req.user.scope, w.shift_id, { includeSelf: false })) throw forbidden('המשמרת לא באחריותך');
  const db = getDb();
  if (approve && db.prepare("SELECT 1 FROM shifts WHERE employee_id = ? AND status = 'scheduled' AND id != ? AND start_at < ? AND end_at > ?").get(w.taken_by, w.shift_id, w.end_at, w.start_at)) {
    throw badRequest(`ל${w.taken_by_name} כבר יש משמרת אחרת בשעות האלה`);
  }
  db.transaction(() => {
    db.prepare("UPDATE shift_swaps SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(approve ? 'approved' : 'rejected', req.user.id, id);
    if (approve) {
      const takerCanLead = db.prepare('SELECT can_lead FROM employees WHERE id = ?').get(w.taken_by)?.can_lead;
      db.prepare("UPDATE shifts SET employee_id = ?, is_lead = CASE WHEN is_lead = 1 AND ? = 1 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?")
        .run(w.taken_by, takerCanLead ? 1 : 0, w.shift_id);
    }
  })();
  audit(req, {
    action: approve ? 'swap.approve' : 'swap.reject', entityType: 'shift', entityId: w.shift_id,
    description: `${req.user.display_name} ${approve ? 'אישר/ה' : 'דחה/תה'} החלפה: ${w.offered_by_name} ← ${w.taken_by_name} (${describe(w)})`,
    oldValue: { employee: w.offered_by_name }, newValue: { employee: approve ? w.taken_by_name : w.offered_by_name },
  });
  const t = approve ? 'ההחלפה אושרה' : 'ההחלפה נדחתה';
  notifyEmployee(w.offered_by, { type: approve ? 'request_approved' : 'request_rejected', title: t, body: `${describe(w)} · ${w.taken_by_name}`, link: '/shifts' });
  notifyEmployee(w.taken_by, { type: approve ? 'shift_assigned' : 'request_rejected', title: approve ? 'המשמרת שלקחת אושרה ושובצה לך' : t, body: describe(w), link: '/shifts' });
  res.json({ ok: true, message: t });
}));

export default router;
