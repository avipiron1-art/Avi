import { Router } from 'express';
import { getDb } from '../db/index.js';

const router = Router();

/** Global search across employees, shifts, tasks and requests — scoped to the user's permissions. */
router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q}%`;
  const db = getDb();
  const own = req.user.employee_id || -1;
  const results = [];

  if (req.can('employees.view')) {
    for (const e of db.prepare(
      `SELECT e.id, e.first_name || ' ' || e.last_name AS name, e.employee_code, e.avatar, p.name AS position
       FROM employees e LEFT JOIN positions p ON p.id = e.position_id
       WHERE e.first_name || ' ' || e.last_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.phone LIKE ? LIMIT 6`,
    ).all(like, like, like, like)) {
      results.push({ type: 'employee', id: e.id, title: e.name, subtitle: [e.employee_code, e.position].filter(Boolean).join(' · '), avatar: e.avatar, link: `/employees/${e.id}` });
    }
  }

  const allShifts = req.can('shifts.view_all');
  for (const s of db.prepare(
    `SELECT s.id, s.start_at, s.end_at, e.first_name || ' ' || e.last_name AS name, l.name AS location, p.name AS position
     FROM shifts s JOIN employees e ON e.id = s.employee_id LEFT JOIN locations l ON l.id = s.location_id LEFT JOIN positions p ON p.id = s.position_id
     WHERE s.status = 'scheduled' AND (${allShifts ? '1' : 's.employee_id = @own'})
       AND (e.first_name || ' ' || e.last_name LIKE @q OR l.name LIKE @q OR p.name LIKE @q OR s.note LIKE @q OR s.start_at LIKE @q)
     ORDER BY s.start_at DESC LIMIT 6`,
  ).all({ q: like, own })) {
    results.push({ type: 'shift', id: s.id, title: `${s.name} · ${s.start_at.slice(8, 10)}/${s.start_at.slice(5, 7)}`, subtitle: `${s.start_at.slice(11)}–${s.end_at.slice(11)}${s.location ? ` · ${s.location}` : ''}`, link: `/shifts?date=${s.start_at.slice(0, 10)}&shift=${s.id}` });
  }

  for (const t of db.prepare(
    `SELECT t.id, t.title, t.status, e.first_name || ' ' || e.last_name AS name FROM tasks t LEFT JOIN employees e ON e.id = t.assignee_id
     WHERE (${req.can('tasks.manage') ? '1' : 't.assignee_id = @own'}) AND (t.title LIKE @q OR t.description LIKE @q) ORDER BY t.id DESC LIMIT 6`,
  ).all({ q: like, own })) {
    results.push({ type: 'task', id: t.id, title: t.title, subtitle: t.name || 'ללא אחראי', link: `/tasks?task=${t.id}` });
  }

  for (const r of db.prepare(
    `SELECT rq.id, rq.type, rq.start_date, rq.status, e.first_name || ' ' || e.last_name AS name FROM requests rq JOIN employees e ON e.id = rq.employee_id
     WHERE (${req.can('requests.review') ? '1' : 'rq.employee_id = @own'}) AND (e.first_name || ' ' || e.last_name LIKE @q OR rq.details LIKE @q) ORDER BY rq.id DESC LIMIT 6`,
  ).all({ q: like, own })) {
    results.push({ type: 'request', id: r.id, title: `${r.name} · ${r.start_date}`, subtitle: r.type, status: r.status, link: `/requests?request=${r.id}` });
  }

  res.json({ results });
});

export default router;
