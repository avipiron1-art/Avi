import { useState } from 'react';
import { Copy, Link2, MessageCircle, Share2, Trash2, Check } from 'lucide-react';
import { api } from '../lib/api.js';
import { useApi } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { Badge, Button, Field, IconButton, Input, Modal, Select, useForm } from './ui.jsx';
import { dateTime } from '../lib/format.js';

/** Create & share join links for new employees. */
export default function InviteModal({ onClose }) {
  const { meta, user } = useAuth();
  const toast = useToast();
  const list = useApi('/invites');
  const [created, setCreated] = useState(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const { values: v, set } = useForm({ label: '', max_uses: 1, expires_days: 7, department_id: '', position_id: '', location_id: '', emails: '' });
  const [errors, setErrors] = useState({});

  const create = async () => {
    setSaving(true);
    try {
      const { emails, ...body } = v;
      const sendTo = emails.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const r = await api.post('/invites', { ...body, send_to: sendTo });
      if (sendTo.length) toast.success(r.message);
      setErrors({});
      setCreated({ ...r, link: `${window.location.origin}${r.path}` });
      list.reload({ silent: true });
    } catch (e) { setErrors(e.fields || {}); toast.error(e); } finally { setSaving(false); }
  };
  const message = created && `שלום! הוזמנת להצטרף למערכת המשמרות של ${meta.settings.business_name}.\nלהרשמה: ${created.link}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(created.link); setCopied(true); toast.success('הקישור הועתק'); setTimeout(() => setCopied(false), 2000); } catch { toast.error('לא ניתן להעתיק. סמנו את הקישור והעתיקו ידנית.'); }
  };
  const share = async () => { try { await navigator.share({ title: 'הצטרפות ל-Shiftly', text: message }); } catch { /* cancelled */ } };
  const revoke = async (id) => { try { const r = await api.del(`/invites/${id}`); toast.success(r.message); list.reload({ silent: true }); } catch (e) { toast.error(e); } };

  return (
    <Modal open onClose={onClose} title="הזמנת עובדים חדשים" wide footer={<Button onClick={onClose}>סגירה</Button>}>
      {created ? (
        <div className="invite-result">
          <div className="alert tone-success"><Check size={18} /><span>הקישור מוכן! שלחו אותו לעובד. הוא ימלא את הפרטים ויבחר סיסמה בעצמו, ואתם תקבלו התראה כשהוא מצטרף.</span></div>
          <div className="invite-link"><Link2 size={16} /><span className="ltr">{created.link}</span></div>
          <div className="invite-actions">
            <Button variant="primary" icon={copied ? Check : Copy} onClick={copy}>{copied ? 'הועתק' : 'העתקת הקישור'}</Button>
            <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer"><MessageCircle size={17} />שליחה בוואטסאפ</a>
            {'share' in navigator && <Button icon={Share2} onClick={share}>שיתוף</Button>}
          </div>
          <p className="subtle">תוקף: עד {dateTime(created.expires_at)} · {v.max_uses > 1 ? `עד ${v.max_uses} עובדים` : 'לעובד אחד'}. מטעמי אבטחה הקישור מוצג רק עכשיו.</p>
          <Button variant="ghost" onClick={() => setCreated(null)}>יצירת קישור נוסף</Button>
        </div>
      ) : (
        <>
          <p className="muted mb">צרו קישור הצטרפות ושלחו אותו לעובד חדש. הוא ימלא שם, טלפון, אימייל, שם משתמש וסיסמה, והחשבון ייפתח אוטומטית.</p>
          <div className="form-grid">
            <Field label="תיאור (לשימושכם)" className="full"><Input value={v.label} onChange={set('label')} placeholder="לדוגמה: מלצרים לקיץ" maxLength={80} /></Field>
            <Field label="כמה עובדים יכולים להשתמש בו"><Input type="number" min="1" max="200" value={v.max_uses} onChange={set('max_uses')} /></Field>
            <Field label="בתוקף למשך (ימים)"><Input type="number" min="1" max="30" value={v.expires_days} onChange={set('expires_days')} /></Field>
            <Field label="מחלקה"><Select value={v.department_id} onChange={set('department_id')}><option value="">ללא</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
            <Field label="תפקיד"><Select value={v.position_id} onChange={set('position_id')}><option value="">ללא</option>{meta.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            {user.mail_enabled && (
              <Field label="שליחה במייל (לא חובה)" className="full" hint="כתובת אחת או כמה, מופרדות בפסיק. אפשר גם לשלוח בוואטסאפ אחרי היצירה" error={errors.send_to ? 'כתובת מייל לא תקינה' : undefined}>
                <Input className="ltr" value={v.emails} onChange={set('emails')} placeholder="dana@gmail.com, avi@gmail.com" inputMode="email" />
              </Field>
            )}
            <Field label="סניף"><Select value={v.location_id} onChange={set('location_id')}><option value="">ללא</option>{meta.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          </div>
          <div className="mt"><Button variant="primary" icon={Link2} onClick={create} loading={saving}>יצירת קישור</Button></div>
        </>
      )}
      {list.data?.invites.some((i) => i.active) && (
        <div className="mt">
          <h3 className="mb">קישורים פעילים</h3>
          <div className="list">
            {list.data.invites.filter((i) => i.active).map((i) => (
              <div key={i.id} className="list-item">
                <div className="grow">
                  <strong>{i.label || 'קישור הצטרפות'}</strong>
                  <div className="subtle">נוצל {i.uses} מתוך {i.max_uses} · עד {dateTime(i.expires_at)}{i.location_name ? ` · ${i.location_name}` : ''}</div>
                </div>
                <Badge tone="success">פעיל</Badge>
                <IconButton icon={Trash2} label="ביטול הקישור" small onClick={() => revoke(i.id)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
