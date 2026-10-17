// Settings → Email: connect Gmail (app password) or another SMTP server, and send a test.
import { Router } from 'express';
import { ah, badRequest } from '../lib/errors.js';
import { validate, z } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { clearMailConfig, mailConfig, mailEnabled, renderEmail, saveMailConfig, sendMail, verifyMailConfig } from '../services/mailer.js';

const router = Router();

const status = () => {
  const c = mailConfig();
  return {
    enabled: mailEnabled(), provider: c.host === 'smtp.gmail.com' || !c.host ? 'gmail' : 'other',
    host: c.host, port: c.port, user: c.user, from_name: getSetting('smtp_from_name') || '', has_pass: !!c.pass,
    last_error: getSetting('smtp_last_error') || null,
  };
};

router.get('/status', (req, res) => res.json(status()));

router.put('/config', ah(async (req, res) => {
  const b = validate(z.object({
    provider: z.enum(['gmail', 'other']).default('gmail'),
    user: z.string().trim().toLowerCase().email('כתובת מייל לא תקינה').max(120),
    pass: z.string().max(200).optional().default(''),
    host: z.string().trim().max(120).optional().default(''),
    port: z.coerce.number().int().min(1).max(65535).optional().default(465),
    from_name: z.string().trim().max(80).optional().default(''),
  }), req.body);
  const current = mailConfig();
  const pass = (b.pass || '').replace(/\s+/g, '') || (b.user === current.user ? current.pass : '');
  if (!pass) throw badRequest('יש להזין סיסמת אפליקציה', { fields: { pass: 'שדה חובה' } });
  const c = b.provider === 'gmail'
    ? { host: 'smtp.gmail.com', port: 465, user: b.user, pass, from_name: b.from_name }
    : { host: b.host, port: b.port, user: b.user, pass, from_name: b.from_name };
  if (!c.host) throw badRequest('יש להזין שרת SMTP', { fields: { host: 'שדה חובה' } });
  try { await verifyMailConfig(c); } catch (e) { throw badRequest(e.message, { fields: { pass: 'לא אושר' } }); }
  saveMailConfig(c);
  audit(req, { action: 'mail.config', entityType: 'settings', description: `${req.user.display_name} חיבר/ה שליחת מיילים (${c.user})` });
  res.json({ ...status(), message: 'שליחת המיילים חוברה בהצלחה' });
}));

router.post('/test', ah(async (req, res) => {
  if (!mailEnabled() && process.env.NODE_ENV !== 'test') throw badRequest('יש לחבר קודם שליחת מיילים');
  const to = req.user.email;
  const { html, text } = renderEmail({ title: 'מייל בדיקה ✔', lines: ['אם קיבלת את המייל הזה – שליחת המיילים מהמערכת עובדת.'] });
  await sendMail({ to, subject: 'מייל בדיקה מהמערכת', text, html, strict: true }).catch((e) => { throw badRequest(e.message); });
  res.json({ message: `נשלח מייל בדיקה ל-${to}. בדקו את תיבת הדואר (וגם את הספאם).` });
}));

router.delete('/config', (req, res) => {
  clearMailConfig();
  audit(req, { action: 'mail.disconnect', entityType: 'settings', description: `${req.user.display_name} ניתק/ה את שליחת המיילים` });
  res.json({ ...status(), message: 'שליחת המיילים נותקה' });
});

export default router;
