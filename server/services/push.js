// Web Push: notifications that pop up on the phone even when the app is closed.
import webpush from 'web-push';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { getSetting, updateSettings } from './settings.js';

let ready = false;

/** Create the server's VAPID key pair once and keep it in settings. */
export function initPush() {
  let pub = getSetting('vapid_public');
  let priv = getSetting('vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    updateSettings({ vapid_public: keys.publicKey, vapid_private: keys.privateKey });
    pub = keys.publicKey; priv = keys.privateKey;
  }
  const subject = config.appUrl.startsWith('https://') ? config.appUrl : 'mailto:admin@shiftly.local';
  webpush.setVapidDetails(subject, pub, priv);
  ready = true;
  return pub;
}

export const publicKey = () => getSetting('vapid_public');

/** Send a push to every device of a user. Never throws; removes dead subscriptions. */
export function pushToUser(userId, { title, body, link, tag, urgent }) {
  if (!ready || process.env.NODE_ENV === 'test') return;
  const db = getDb();
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  const payload = JSON.stringify({ title, body: body || '', url: link || '/', tag, urgent: !!urgent });
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 * 24, urgency: urgent ? 'high' : 'normal' })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      });
  }
}
