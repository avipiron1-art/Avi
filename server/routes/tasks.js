import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, forbidden, notFound } from '../lib/errors.js';
import { validate, z, zText, zOptText, zOptId, zDate, paramId } from '../lib/validate.js';
import { requirePerm } from '../middleware/auth.js';
import { audit, diff } from '../services/audit.js';
import { notifyEmployee, notifyUser } from '../services/notify.js';
import { employeeInScope, scopeWhere } from '../services/scope.js';

const router = Router();
export const PRIORITY_LABEL = { low: 'נמוכה', normal: 'רגילה', high: 'גבוהה', urgent: 'דחופה' };
export const TASK_STATUS_LABEL = { new: 'חדשה', in_progress: 'בביצוע', done: 'הושלמה', cancelled: 'בוטלה' };

const COLUMNS = `t.*, e.first_name || ' ' || e.last_name AS assignee_name, e.avatar AS assignee_avatar,
  u.display_name AS created_by_name`;
const JOINS = 'LEFT JOIN employees e ON e.id = t.assignee_id LEFT JOIN users u ON u.id = t.created_by';
const getTask = (id) => getDb().prepare(`SELECT ${COLUMNS} FROM tasks t ${JOINS} WHERE t.id = ?`).get(id);

const taskSchema = z.object({
  title: zText(150),
  description: zOptText(2000),
  assignee_id: zOptId,
  due_date: z.union([zDate, z.literal(''), z.null()]).optional().transform((v) => v || null),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  status: z.enum(['new', 'in_progress', 'done', 'cancelled']).default('new'),
});

/** Tasks a manager sees: assigned to people in their scope, or created by them. */
const taskScope = (req) => `(t.created_by = ${Number(req.user.id)} OR (e.id IS NOT NULL ${scopeWhere(req.user.scope, { e: 'e' })}))`;
function assertTaskInScope(req, id) {
  if (req.user.scope.all) return;
  if (!getDb().prepare(`SELECT 1 FROM tasks t ${JOINS} WHERE t.id = ? AND ${taskScope(req)}`).get(id)) throw forbidden('המשימה לא באחריותך');
}
function assertAssignee(req, assigneeId) {
  if (assigneeId && !employeeInScope(req.user.scope, assigneeId)) throw forbidden('אפשר להקצות משימה רק לעובד שבאחריותך', { fields: { assignee_id: 'לא באחריותך' } });
}

router.get('/', (req, res) => {
  const { status, priority, assignee_id, search } = req.query;
  const where = [];
  const p = {};
  if (!req.can('tasks.manage')) {
    if (!req.user.employee_id) return res.json({ tasks: [] });
    where.push('t.assignee_id = @own'); p.own = req.user.employee_id;
  } else {
    if (assignee_id) { where.push('t.assignee_id = @assignee_id'); p.assignee_id = Number(assignee_id); }
    if (!req.user.scope.all) where.push(taskScope(req));
  }
  if (status && TASK_STATUS_LABEL[status]) { where.push('t.status = @status'); p.status = status; }
  if (status === 'open') where.push("t.status IN ('new','in_progress')");
  if (priority && PRIORITY_LABEL[priority]) { where.push('t.priority = @priority'); p.priority = priority; }
  if (search) { where.push('(t.title LIKE @q OR t.description LIKE @q)'); p.q = `%${String(search).slice(0, 80)}%`; }
  const tasks = getDb().prepare(
    `SELECT ${COLUMNS} FROM tasks t ${JOINS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE t.status WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 ELSE 1 END,
              CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              t.due_date IS NULL, t.due_date, t.id DESC`,
  ).all(p);
  res.json({ tasks });
});

router.post('/', requirePerm('tasks.manage'), ah((req, res) => {
  const data = validate(taskSchema, req.body);
  assertAssignee(req, data.assignee_id);
  const id = getDb().prepare(
    `INSERT INTO tasks (title, description, assignee_id, created_by, due_date, priority, status, completed_at)
     VALUES (@title, @description, @assignee_id, @created_by, @due_date, @priority, @status, CASE WHEN @status = 'done' THEN datetime('now') END)`,
  ).run({ ...data, created_by: req.user.id }).lastInsertRowid;
  const t = getTask(id);
  audit(req, { action: 'task.create', entityType: 'task', entityId: id, description: `${req.user.display_name} יצר/ה משימה "${t.title}"${t.assignee_name ? ` עבור ${t.assignee_name}` : ''}`, newValue: data });
  if (t.assignee_id) notifyEmployee(t.assignee_id, { type: 'task_assigned', title: 'משימה חדשה הוקצתה לך', body: `${t.title}${t.due_date ? ` · עד ${t.due_date}` : ''}`, link: '/tasks' });
  res.status(201).json({ task: t, message: 'המשימה נוצרה בהצלחה' });
}));

router.put('/:id', requirePerm('tasks.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const before = getTask(id);
  if (!before) throw notFound('המשימה לא נמצאה');
  assertTaskInScope(req, id);
  const data = validate(taskSchema, req.body);
  if (data.assignee_id !== before.assignee_id) assertAssignee(req, data.assignee_id);
  getDb().prepare(
    `UPDATE tasks SET title=@title, description=@description, assignee_id=@assignee_id, due_date=@due_date, priority=@priority,
     status=@status, due_notified = CASE WHEN due_date IS NOT @due_date THEN 0 ELSE due_notified END,
     completed_at = CASE WHEN @status = 'done' THEN COALESCE(completed_at, datetime('now')) ELSE NULL END,
     updated_at=datetime('now') WHERE id=@id`,
  ).run({ ...data, id });
  const after = getTask(id);
  const d = diff(before, data, ['title', 'description', 'assignee_id', 'due_date', 'priority', 'status']);
  if (d) audit(req, { action: 'task.update', entityType: 'task', entityId: id, description: `${req.user.display_name} עדכן/ה את המשימה "${after.title}"`, ...d });
  if (after.assignee_id && after.assignee_id !== before.assignee_id) {
    notifyEmployee(after.assignee_id, { type: 'task_assigned', title: 'משימה חדשה הוקצתה לך', body: after.title, link: '/tasks' });
  }
  res.json({ task: after, message: 'המשימה עודכנה בהצלחה' });
}));

// Assignee (or manager) changes status
router.patch('/:id/status', ah((req, res) => {
  const id = paramId(req.params.id);
  const t = getTask(id);
  if (!t) throw notFound('המשימה לא נמצאה');
  const isOwner = req.user.employee_id && t.assignee_id === req.user.employee_id;
  if (!req.can('tasks.manage') && !isOwner) throw forbidden();
  if (!isOwner) assertTaskInScope(req, id);
  const { status } = validate(z.object({ status: z.enum(['new', 'in_progress', 'done', 'cancelled']) }), req.body);
  if (!req.can('tasks.manage') && status === 'cancelled') throw forbidden('רק מנהל יכול לבטל משימה');
  getDb().prepare(
    `UPDATE tasks SET status = ?, completed_at = CASE WHEN ? = 'done' THEN datetime('now') ELSE NULL END, updated_at = datetime('now') WHERE id = ?`,
  ).run(status, status, id);
  audit(req, {
    action: 'task.status', entityType: 'task', entityId: id,
    description: `${req.user.display_name} שינה/תה את סטטוס המשימה "${t.title}" ל"${TASK_STATUS_LABEL[status]}"`,
    oldValue: { status: t.status }, newValue: { status },
  });
  if (status === 'done' && t.created_by && t.created_by !== req.user.id) {
    notifyUser(t.created_by, { type: 'task_done', title: 'משימה הושלמה', body: `${t.title}${t.assignee_name ? ` · ${t.assignee_name}` : ''}`, link: '/tasks' });
  }
  res.json({ task: getTask(id), message: status === 'done' ? 'כל הכבוד! המשימה סומנה כהושלמה' : 'סטטוס המשימה עודכן' });
}));

router.delete('/:id', requirePerm('tasks.manage'), ah((req, res) => {
  const id = paramId(req.params.id);
  const t = getTask(id);
  if (!t) throw notFound('המשימה לא נמצאה');
  assertTaskInScope(req, id);
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  audit(req, { action: 'task.delete', entityType: 'task', entityId: id, description: `${req.user.display_name} מחק/ה את המשימה "${t.title}"`, oldValue: t });
  res.json({ ok: true, message: 'המשימה נמחקה' });
}));

export default router;
