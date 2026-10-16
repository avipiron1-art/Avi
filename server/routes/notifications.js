import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, notFound } from '../lib/errors.js';
import { paramId } from '../lib/validate.js';

const router = Router();

router.get('/', (req, res) => {
  const filter = req.query.filter === 'unread' ? 'AND is_read = 0' : '';
  const db = getDb();
  const notifications = db.prepare(
    `SELECT * FROM notifications WHERE user_id = ? ${filter} ORDER BY created_at DESC, id DESC LIMIT 200`,
  ).all(req.user.id);
  const { unread } = db.prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
  res.json({ notifications, unread });
});

router.get('/unread-count', (req, res) => {
  const { unread } = getDb().prepare('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id);
  res.json({ unread });
});

router.patch('/:id/read', ah((req, res) => {
  const r = getDb().prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(paramId(req.params.id), req.user.id);
  if (!r.changes) throw notFound('ההתראה לא נמצאה');
  res.json({ ok: true });
}));

router.post('/read-all', (req, res) => {
  getDb().prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.user.id);
  res.json({ ok: true, message: 'כל ההתראות סומנו כנקראו' });
});

router.delete('/:id', ah((req, res) => {
  const r = getDb().prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(paramId(req.params.id), req.user.id);
  if (!r.changes) throw notFound('ההתראה לא נמצאה');
  res.json({ ok: true });
}));

export default router;
