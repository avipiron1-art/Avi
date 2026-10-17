import { useEffect, useState } from 'react';
import { Mail, Send, Unlink, ExternalLink, AlertTriangle } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Badge, Button, Card, ErrorState, Field, Input, Segmented, SkeletonRows, useConfirm } from './ui.jsx';

/** Settings → Email: Gmail with an app password (or any SMTP server). */
export default function MailSettings() {
  const toast = useToast();
  const { data: st, loading, error, reload, setData } = useApi('/mail/status');
  const [v, setV] = useState({ provider: 'gmail', user: '', pass: '', host: '', port: 465, from_name: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  useEffect(() => { if (st) setV((x) => ({ ...x, provider: st.provider, user: st.user, host: st.provider === 'other' ? st.host : '', port: st.port || 465, from_name: st.from_name })); }, [st]);
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading && !st) return <Card><SkeletonRows rows={5} /></Card>;
  const set = (k) => (e) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setBusy('save'); setErrors({});
    try { const r = await api.put('/mail/config', v); setData(r); setV((x) => ({ ...x, pass: '' })); toast.success(r.message); } catch (e) { setErrors(e.fields || {}); toast.error(e); } finally { setBusy(null); }
  };
  const test = async () => { setBusy('test'); try { const r = await api.post('/mail/test'); toast.success(r.message); } catch (e) { toast.error(e); } finally { setBusy(null); } };

  return (
    <div className="grid grid-2">
      <Card title="שליחת מיילים" icon={Mail} actions={st.enabled ? <Badge tone="success" dot>מחובר</Badge> : <Badge dot>לא מחובר</Badge>}>
        <p style={{ marginTop: 0 }}>המערכת שולחת מיילים ל"שכחתי סיסמה", להזמנת עובדים, להתראות חשובות (שיבוץ, אישור בקשות, הודעות דחופות) ולהתראות אבטחה.</p>
        {st.last_error && st.enabled && <div className="alert tone-warning mb"><AlertTriangle size={18} /><span>שגיאה אחרונה: {st.last_error.replace(/^\S+\s/, '')}</span></div>}
        <div className="grid">
          <Field label="ספק">
            <Segmented value={v.provider} onChange={(p) => setV((x) => ({ ...x, provider: p }))} options={[{ value: 'gmail', label: 'Gmail' }, { value: 'other', label: 'שרת אחר (SMTP)' }]} />
          </Field>
          <Field label={v.provider === 'gmail' ? 'כתובת ה-Gmail' : 'שם משתמש / כתובת שולח'} error={errors.user}>
            <Input className="ltr" type="email" value={v.user} onChange={set('user')} placeholder="business@gmail.com" autoComplete="off" />
          </Field>
          <Field label={v.provider === 'gmail' ? 'סיסמת אפליקציה (16 אותיות)' : 'סיסמה'} error={errors.pass} hint={st.has_pass ? 'שמורה. השאירו ריק כדי לא לשנות' : undefined}>
            <Input className="ltr" type="password" value={v.pass} onChange={set('pass')} placeholder={st.has_pass ? '••••••••••••••••' : 'abcd efgh ijkl mnop'} autoComplete="new-password" />
          </Field>
          {v.provider === 'other' && (
            <div className="grid grid-2">
              <Field label="שרת SMTP" error={errors.host}><Input className="ltr" value={v.host} onChange={set('host')} placeholder="smtp.example.com" /></Field>
              <Field label="פורט" error={errors.port}><Input type="number" value={v.port} onChange={set('port')} /></Field>
            </div>
          )}
          <Field label="שם השולח (לא חובה)" hint="מה שהעובדים יראו כשולח. ברירת מחדל: שם העסק"><Input value={v.from_name} onChange={set('from_name')} /></Field>
          <div className="flex flex-wrap">
            <Button variant="primary" icon={Mail} loading={busy === 'save'} onClick={save} disabled={!v.user}>{st.enabled ? 'שמירה' : 'חיבור'}</Button>
            {st.enabled && <Button icon={Send} loading={busy === 'test'} onClick={test}>שליחת מייל בדיקה אליי</Button>}
            {st.enabled && <Button variant="ghost" icon={Unlink} onClick={() => confirm({
              title: 'לנתק את שליחת המיילים?', message: 'המערכת תפסיק לשלוח מיילים (גם לאיפוס סיסמה).', confirmText: 'ניתוק',
              onConfirm: async () => { const r = await api.del('/mail/config'); setData(r); toast.success(r.message); },
            })}>ניתוק</Button>}
          </div>
        </div>
      </Card>

      {v.provider === 'gmail' && (
        <Card title="איך מקבלים סיסמת אפליקציה ב-Gmail? (פעם אחת, 2 דקות)">
          <ol className="steps" style={{ lineHeight: 1.7 }}>
            <li>היכנסו ל-<a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noreferrer">אימות דו-שלבי של Google <ExternalLink size={12} /></a> וודאו שהוא <strong>מופעל</strong> (בלי זה אין סיסמאות אפליקציה).</li>
            <li>היכנסו ל-<a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">סיסמאות אפליקציה <ExternalLink size={12} /></a>.</li>
            <li>בשם האפליקציה כתבו <code>Shiftly</code> ולחצו <strong>Create / יצירה</strong>.</li>
            <li>תופיע סיסמה של 16 אותיות – העתיקו אותה לשדה "סיסמת אפליקציה" כאן, הזינו את כתובת ה-Gmail ולחצו <strong>חיבור</strong>.</li>
            <li>לחצו "שליחת מייל בדיקה אליי" ובדקו שהמייל הגיע (אם לא – בדקו גם בספאם).</li>
          </ol>
          <p className="subtle" style={{ marginBottom: 0 }}>טיפ: אפשר לפתוח Gmail חדש לעסק (למשל shifts.business@gmail.com) כדי שהמיילים לא ייצאו מהחשבון הפרטי שלכם. Gmail מאפשר עד כ-500 מיילים ביום – הרבה מעבר למה שהמערכת צריכה.</p>
        </Card>
      )}
      {confirmDialog}
    </div>
  );
}
