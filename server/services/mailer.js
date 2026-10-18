// Outgoing email. Configured in Settings → Email (Gmail with an "app password", or any SMTP server).
// Without configuration messages are only printed to the server log.
import nodemailer from 'nodemailer';
import { getDb } from '../db/index.js';
import { getSetting, updateSettings } from './settings.js';
import { config } from '../config.js';

export const sentInTests = []; // NODE_ENV=test: messages land here instead of being sent

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mailConfig() {
  return {
    host: getSetting('smtp_host') || '',
    port: Number(getSetting('smtp_port')) || 465,
    user: getSetting('smtp_user') || '',
    pass: getSetting('smtp_pass') || '',
    from_name: getSetting('smtp_from_name') || getSetting('business_name') || 'Shiftly',
  };
}
export const mailEnabled = () => { const c = mailConfig(); return !!(c.host && c.user && c.pass); };

function transportFor(c) {
  return nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
  });
}

/** Check the server and credentials (used before saving the settings). */
export async function verifyMailConfig(c) {
  if (process.env.NODE_ENV === 'test') return;
  try { await transportFor(c).verify(); } catch (e) {
    if (/Invalid login|535|Username and Password not accepted|BadCredentials/i.test(e.message)) {
      throw new Error('Gmail לא אישר את הכניסה. ודאו שהזנתם "סיסמת אפליקציה" (16 אותיות) ולא את הסיסמה הרגילה של החשבון.');
    }
    throw new Error(`לא ניתן להתחבר לשרת המייל: ${e.message}`);
  }
}

export function saveMailConfig(c) {
  updateSettings({ smtp_host: c.host, smtp_port: String(c.port), smtp_user: c.user, smtp_pass: c.pass, smtp_from_name: c.from_name || '' });
}
export const clearMailConfig = () => updateSettings({ smtp_host: '', smtp_user: '', smtp_pass: '' });

/** A simple RTL email with the business name and color. `lines` are paragraphs; `button` = { label, url }. */
export function renderEmail({ title, lines = [], button = null, footer = '' }) {
  const color = getSetting('brand_color') || '#0071e3';
  const biz = esc(getSetting('business_name') || 'Shiftly');
  const paras = lines.map((l) => `<p style="margin:0 0 12px;line-height:1.6">${esc(l).replace(/\n/g, '<br>')}</p>`).join('');
  const btn = button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="background:${color};color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold;display:inline-block">${esc(button.label)}</a></p>` : '';
  const html = `<!doctype html><html dir="rtl" lang="he"><body style="margin:0;background:#f4f5f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<div style="max-width:560px;margin:0 auto;padding:24px 12px">
<div style="background:${color};color:#fff;padding:16px 20px;border-radius:14px 14px 0 0;font-weight:bold;font-size:17px">${biz}</div>
<div style="background:#fff;padding:22px 20px;border-radius:0 0 14px 14px;text-align:right">
<h1 style="font-size:19px;margin:0 0 14px">${esc(title)}</h1>${paras}${btn}
${footer ? `<p style="margin:18px 0 0;color:#6b7280;font-size:12px">${esc(footer)}</p>` : ''}
</div></div></body></html>`;
  const text = [title, '', ...lines, button ? `${button.label}: ${button.url}` : '', footer].filter((x) => x !== '').join('\n\n');
  return { html, text };
}

/** Send one email. Never throws for "not configured"; throws on a real sending error when `strict`. */
export async function sendMail({ to, subject, text, html, strict = false }) {
  if (!to) return { sent: false };
  if (process.env.NODE_ENV === 'test') { sentInTests.push({ to, subject, text, html }); return { sent: true }; }
  if (!mailEnabled()) {
    console.log(`\n📧 [mail – not configured] to=${to}\n   subject: ${subject}\n   ${String(text).replace(/\n/g, '\n   ')}\n`);
    return { sent: false };
  }
  const c = mailConfig();
  try {
    await transportFor(c).sendMail({ from: { name: c.from_name, address: c.user }, to, subject, text, html });
    return { sent: true };
  } catch (e) {
    console.error('[mail]', e.message);
    updateSettings({ smtp_last_error: `${new Date().toISOString()} ${e.message}` });
    if (strict) throw new Error(`שליחת המייל נכשלה: ${e.message}`);
    return { sent: false };
  }
}

// ---------- important notifications by email, grouped so a busy minute becomes one email ----------
const queue = new Map(); // userId -> { to, name, items: [], timer }
const DELAY = process.env.NODE_ENV === 'test' ? 10 : 60_000;

export function queueNotificationEmail(userId, { title, body, link }) {
  if (process.env.NODE_ENV !== 'test' && !mailEnabled()) return;
  const u = getDb().prepare('SELECT email, display_name, email_notifications, is_active FROM users WHERE id = ?').get(userId);
  if (!u || !u.is_active || !u.email_notifications || !u.email || u.email.endsWith('.demo') || u.email.endsWith('.local')) return;
  let q = queue.get(userId);
  if (!q) {
    q = { to: u.email, name: u.display_name, items: [] };
    queue.set(userId, q);
    q.timer = setTimeout(() => flush(userId), DELAY);
    q.timer.unref?.();
  }
  q.items.push({ title, body, link });
}

async function flush(userId) {
  const q = queue.get(userId);
  queue.delete(userId);
  if (!q?.items.length) return;
  const base = config.appUrl.replace(/\/$/, '');
  const first = q.items[0];
  const many = q.items.length > 1;
  const { html, text } = renderEmail({
    title: many ? `יש לך ${q.items.length} עדכונים חדשים` : first.title,
    lines: many ? q.items.map((i) => `• ${i.title}${i.body ? ` – ${i.body}` : ''}`) : [first.body].filter(Boolean),
    button: { label: 'פתיחה באפליקציה', url: `${base}${many ? '/notifications' : first.link || '/'}` },
    footer: 'אפשר לכבות התראות במייל בהגדרות ← הפרופיל שלי.',
  });
  await sendMail({ to: q.to, subject: many ? `${q.items.length} עדכונים חדשים` : first.title, text, html });
}

/** Tests: send whatever is waiting right now. */
export async function flushAllMail() { for (const id of [...queue.keys()]) { clearTimeout(queue.get(id).timer); await flush(id); } }
