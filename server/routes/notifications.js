import { Router } from 'express';
import { getDb } from '../db/index.js';
import { ah, notFound } from '../lib/errors.js';
import { paramId, validate, z } from '../lib/validate.js';
import { publicKey } from '../services/push.js';

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

// ---------- push subscriptions ----------
router.get('/push/key', (req, res) => {
  const n = getDb().prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?').get(req.user.id).c;
  res.json({ key: publicKey(), devices: n });
});

router.post('/push/subscribe', ah((req, res) => {
  const sub = validate(z.object({
    endpoint: z.string().url().max(1000).refine((u) => u.startsWith('https://'), 'כתובת לא תקינה'),
    keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  }), req.body);
  getDb().prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(req.user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, String(req.get('user-agent') || '').slice(0, 200));
  res.json({ ok: true, message: 'התראות בטלפון הופעלו' });
}));

router.post('/push/unsubscribe', ah((req, res) => {
  const { endpoint } = validate(z.object({ endpoint: z.string().max(1000) }), req.body);
  getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id);
  res.json({ ok: true, message: 'התראות בטלפון כובו במכשיר זה' });
}));

export default router;
