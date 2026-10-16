import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zText, zOptText, zOptId, zDate, paramId } from '../lib/validate.js';
import { requirePerm, requireEmployee } from '../middleware/auth.js';
import { audit } from '../services/audit.js';
import { notifyEmployee, notifyPermission } from '../services/notify.js';

const router = Router();
export const REQUEST_TYPE_LABEL = {
  vacation: 'בקשת חופשה', day_off: 'בקשת יום חופש', shift_swap: 'החלפת משמרת', availability: 'עדכון זמינות', general: 'בקשה כללית',
};
const STATUS_LABEL = { pending: 'ממתין', approved: 'אושר', rejected: 'נדחה' };

const COLUMNS = `rq.*, e.first_name || ' ' || e.last_name AS employee_name, e.avatar AS employee_avatar,
  sw.first_name || ' ' || sw.last_name AS swap_with_name, s.start_at AS shift_start_at, s.end_at AS shift_end_at,
  u.display_name AS reviewed_by_name`;
const JOINS = `JOIN employees e ON e.id = rq.employee_id LEFT JOIN employees sw ON sw.id = rq.swap_with_id
  LEFT JOIN shifts s ON s.id = rq.shift_id LEFT JOIN users u ON u.id = rq.reviewed_by`;
const getRequest = (id) => getDb().prepare(`SELECT ${COLUMNS} FROM requests rq ${JOINS} WHERE rq.id = ?`).get(id);

router.get('/', (req, res) => {
  const { status, type, employee_id } = req.query;
  const where = [];
  const p = {};
  if (!req.can('requests.review')) {
    if (!req.user.employee_id) return res.json({ requests: [] });
    where.push('rq.employee_id = @own'); p.own = req.user.employee_id;
  } else if (employee_id) { where.push('rq.employee_id = @employee_id'); p.employee_id = Number(employee_id); }
  if (status && STATUS_LABEL[status]) { where.push('rq.status = @status'); p.status = status; }
  if (type && REQUEST_TYPE_LABEL[type]) { where.push('rq.type = @type'); p.type = type; }
  const requests = getDb().prepare(
    `SELECT ${COLUMNS} FROM requests rq ${JOINS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY rq.status = 'pending' DESC, rq.created_at DESC`,
  ).all(p);
  res.json({ requests });
});

router.post('/', requireEmployee, ah((req, res) => {
  const data = validate(z.object({
    type: z.enum(['vacation', 'day_off', 'shift_swap', 'availability', 'general']),
    start_date: zDate,
    end_date: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => v || null),
    shift_id: zOptId,
    swap_with_id: zOptId,
    details: zText(2000),
  }), req.body);
  if (data.end_date && data.end_date < data.start_date) throw badRequest('תאריך הסיום חייב להיות אחרי תאריך ההתחלה', { fields: { end_date: 'תאריך הסיום מוקדם מההתחלה' } });
  const db = getDb();
  if (data.shift_id) {
    const s = db.prepare('SELECT employee_id FROM shifts WHERE id = ?').get(data.shift_id);
    if (!s || s.employee_id !== req.user.employee_id) throw badRequest('ניתן לבקש החלפה רק למשמרת שלך', { fields: { shift_id: 'משמרת לא תקינה' } });
  }
  if (data.type === 'shift_swap' && !data.shift_id) throw badRequest('יש לבחור את המשמרת להחלפה', { fields: { shift_id: 'שדה חובה' } });
  if (data.type !== 'vacation') data.end_date = data.type === 'availability' ? data.end_date : null;
  const id = db.prepare(
    'INSERT INTO requests (employee_id, type, start_date, end_date, shift_id, swap_with_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(req.user.employee_id, data.type, data.start_date, data.end_date, data.shift_id, data.swap_with_id, data.details).lastInsertRowid;
  const r = getRequest(id);
  audit(req, { action: 'request.create', entityType: 'request', entityId: id, description: `${r.employee_name} הגיש/ה ${REQUEST_TYPE_LABEL[r.type]}`, newValue: data });
  notifyPermission('requests.review', { type: 'request_new', title: `${REQUEST_TYPE_LABEL[r.type]} חדשה`, body: `${r.employee_name} · ${r.start_date}${r.end_date ? ` – ${r.end_date}` : ''}`, link: '/requests' }, { exceptUserId: req.user.id });
  res.status(201).json({ request: r, message: 'הבקשה נשלחה בהצלחה וממתינה לאישור' });
}));

router.patch('/:id/review', requirePerm('requests.review'), ah((req, res) => {
  const id = paramId(req.params.id);
  const r = getRequest(id);
  if (!r) throw notFound('הבקשה לא נמצאה');
  const data = validate(z.object({ status: z.enum(['approved', 'rejected']), response: zOptText(1000) }), req.body);
  if (r.employee_id === req.user.employee_id) throw forbidden('לא ניתן לאשר בקשה שהגשת בעצמך');
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE requests SET status = ?, manager_response = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
      .run(data.status, data.response, req.user.id, id);
    // Approved shift swap with a named colleague: reassign the shift
    if (data.status === 'approved' && r.type === 'shift_swap' && r.shift_id && r.swap_with_id) {
      db.prepare("UPDATE shifts SET employee_id = ?, updated_at = datetime('now') WHERE id = ?").run(r.swap_with_id, r.shift_id);
      notifyEmployee(r.swap_with_id, { type: 'shift_assigned', title: 'שובצת למשמרת (החלפה)', body: `במקום ${r.employee_name}`, link: '/shifts' });
    }
  })();
  audit(req, {
    action: `request.${data.status}`, entityType: 'request', entityId: id,
    description: `${req.user.display_name} ${data.status === 'approved' ? 'אישר/ה' : 'דחה/תה'} את ${REQUEST_TYPE_LABEL[r.type]} של ${r.employee_name}`,
    oldValue: { status: r.status }, newValue: { status: data.status, response: data.response },
  });
  notifyEmployee(r.employee_id, {
    type: data.status === 'approved' ? 'request_approved' : 'request_rejected',
    title: data.status === 'approved' ? 'הבקשה שלך אושרה' : 'הבקשה שלך נדחתה',
    body: `${REQUEST_TYPE_LABEL[r.type]}${data.response ? ` · ${data.response}` : ''}`, link: '/requests',
  });
  res.json({ request: getRequest(id), message: data.status === 'approved' ? 'הבקשה אושרה' : 'הבקשה נדחתה' });
}));

router.delete('/:id', requireEmployee, ah((req, res) => {
  const id = paramId(req.params.id);
  const r = getRequest(id);
  if (!r) throw notFound('הבקשה לא נמצאה');
  if (r.employee_id !== req.user.employee_id) throw forbidden();
  if (r.status !== 'pending') throw badRequest('ניתן לבטל רק בקשה שעדיין ממתינה');
  getDb().prepare('DELETE FROM requests WHERE id = ?').run(id);
  audit(req, { action: 'request.withdraw', entityType: 'request', entityId: id, description: `${r.employee_name} ביטל/ה ${REQUEST_TYPE_LABEL[r.type]}`, oldValue: r });
  res.json({ ok: true, message: 'הבקשה בוטלה' });
}));

// ---------- weekly availability ----------
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function readAvailability(empId) {
  const rows = getDb().prepare('SELECT * FROM availability WHERE employee_id = ? ORDER BY weekday').all(empId);
  return DAYS.map((name, weekday) => {
    const r = rows.find((x) => x.weekday === weekday);
    return { weekday, name, available: r ? !!r.available : true, from_time: r?.from_time || null, to_time: r?.to_time || null, note: r?.note || null, reported: !!r };
  });
}

router.get('/availability/:employeeId', ah((req, res) => {
  const empId = req.params.employeeId === 'me' ? req.user.employee_id : paramId(req.params.employeeId);
  if (!empId) throw forbidden();
  if (empId !== req.user.employee_id && !req.can('shifts.view_all')) throw forbidden();
  res.json({ availability: readAvailability(empId) });
}));

router.put('/availability/me', requireEmployee, ah((req, res) => {
  const time = z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal(''), z.null()]).optional().transform((v) => v || null);
  const { days } = validate(z.object({
    days: z.array(z.object({ weekday: z.number().int().min(0).max(6), available: z.boolean(), from_time: time, to_time: time, note: zOptText(200) })).length(7),
  }), req.body);
  const db = getDb();
  const up = db.prepare(
    `INSERT INTO availability (employee_id, weekday, available, from_time, to_time, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(employee_id, weekday) DO UPDATE SET available=excluded.available, from_time=excluded.from_time, to_time=excluded.to_time, note=excluded.note, updated_at=excluded.updated_at`,
  );
  db.transaction(() => { for (const d of days) up.run(req.user.employee_id, d.weekday, d.available ? 1 : 0, d.from_time, d.to_time, d.note); })();
  audit(req, { action: 'availability.update', entityType: 'employee', entityId: req.user.employee_id, description: `${req.user.display_name} עדכן/ה זמינות שבועית`, newValue: days });
  notifyPermission('shifts.manage', { type: 'availability', title: 'עדכון זמינות', body: `${req.user.display_name} עדכן/ה את הזמינות השבועית`, link: `/employees/${req.user.employee_id}` }, { exceptUserId: req.user.id });
  res.json({ availability: readAvailability(req.user.employee_id), message: 'הזמינות נשמרה בהצלחה' });
}));

export default router;
