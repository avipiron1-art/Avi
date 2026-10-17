import { useState } from 'react';
import { Megaphone, Plus, Pencil, Trash2, CheckCircle2, Eye, Users, AlertOctagon } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Modal, PageHeader, Segmented, Select, SkeletonRows, Textarea, useConfirm,
} from '../components/ui.jsx';
import { dateTime, shortDate, timeAgo } from '../lib/format.js';

export const URGENCY = {
  critical: { label: 'דחופה', tone: 'danger' },
  high: { label: 'חשובה', tone: 'warning' },
  normal: { label: 'רגילה', tone: 'info' },
  low: { label: 'לידיעה', tone: 'neutral' },
};
export function UrgencyBadge({ urgency }) {
  const u = URGENCY[urgency] || URGENCY.normal;
  return <Badge tone={u.tone} dot>{u.label}</Badge>;
}

function AnnouncementForm({ item, onClose, onSaved }) {
  const { meta, user } = useAuth();
  const toast = useToast();
  const [v, setV] = useState(() => ({
    title: item?.title || '', body: item?.body || '', urgency: item?.urgency || 'normal', requires_ack: item ? !!item.requires_ack : false,
    location_id: item?.location_id ?? '', department_id: item?.department_id ?? '', expires_on: item?.expires_at ? item.expires_at.slice(0, 10) : '',
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const save = async () => {
    setSaving(true);
    try {
      const r = item ? await api.put(`/announcements/${item.id}`, v) : await api.post('/announcements', v);
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields || {}); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={item ? 'עריכת הודעה' : 'הודעה חדשה'}
      footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" icon={Megaphone} loading={saving} onClick={save}>{item ? 'שמירה' : 'פרסום'}</Button></>}>
      <div className="grid">
        <Field label="כותרת *" error={errors.title}><Input value={v.title} maxLength={120} onChange={set('title')} invalid={errors.title} /></Field>
        <Field label="תוכן" error={errors.body}><Textarea value={v.body} maxLength={4000} onChange={set('body')} style={{ minHeight: 110 }} /></Field>
        <Field label="דחיפות">
          <Segmented value={v.urgency} onChange={(u) => setV((s) => ({ ...s, urgency: u, requires_ack: u === 'critical' ? true : s.requires_ack }))}
            options={['low', 'normal', 'high', 'critical'].map((k) => ({ value: k, label: URGENCY[k].label }))} />
        </Field>
        <label className="checkbox ack-check">
          <input type="checkbox" checked={v.requires_ack} onChange={set('requires_ack')} />
          <span><strong>הודעה קופצת עד לאישור</strong><br /><span className="subtle">ההודעה תקפוץ לעובד בכל כניסה לאפליקציה עד שילחץ "קראתי ואישרתי", ותוכלו לראות מי אישר.</span></span>
        </label>
        <div className="grid grid-2">
          {!user.location_id && (
            <Field label="סניף"><Select value={v.location_id} onChange={set('location_id')}><option value="">כל הסניפים</option>{meta.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          )}
          <Field label="מחלקה"><Select value={v.department_id} onChange={set('department_id')}><option value="">כל המחלקות</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          <Field label="מוצג עד (לא חובה)" error={errors.expires_on}><Input type="date" value={v.expires_on} onChange={set('expires_on')} /></Field>
        </div>
        {(v.urgency === 'high' || v.urgency === 'critical') && <div className="alert tone-warning"><AlertOctagon size={18} /><span>הודעה {URGENCY[v.urgency].label} נשלחת גם כהתראה לטלפון.</span></div>}
      </div>
    </Modal>
  );
}

function AckStatus({ item, onClose }) {
  const { data, loading, error } = useApi(`/announcements/${item.id}/status`);
  const people = data?.people || [];
  const acked = people.filter((p) => p.acked_at);
  const waiting = people.filter((p) => !p.acked_at);
  return (
    <Modal open onClose={onClose} title={`מי קרא: ${item.title}`}>
      {error ? <ErrorState error={error} /> : loading ? <SkeletonRows rows={4} /> : (
        <div className="grid">
          <div className="flex flex-wrap"><Badge tone="success">{acked.length} אישרו</Badge><Badge tone="warning">{waiting.length} טרם אישרו</Badge></div>
          {waiting.length > 0 && <div><strong>טרם אישרו</strong><ul className="ack-list">{waiting.map((p) => <li key={p.user_id}>{p.name}{p.read_at && <span className="subtle"> · ראה/תה {timeAgo(p.read_at)}</span>}</li>)}</ul></div>}
          {acked.length > 0 && <div><strong>אישרו</strong><ul className="ack-list">{acked.map((p) => <li key={p.user_id}><CheckCircle2 size={14} className="text-success" /> {p.name} <span className="subtle">· {dateTime(p.acked_at)}</span></li>)}</ul></div>}
        </div>
      )}
    </Modal>
  );
}

export default function Announcements() {
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi('/announcements');
  const [form, setForm] = useState(null);
  const [status, setStatus] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const manage = data?.can_manage;

  const markRead = (a) => {
    if (a.read_at || a.mine) return;
    api.post(`/announcements/${a.id}/read`).then(() => {
      setData((d) => ({ ...d, announcements: d.announcements.map((x) => (x.id === a.id ? { ...x, read_at: new Date().toISOString() } : x)) }));
      window.dispatchEvent(new Event('notifications:changed'));
    }).catch(() => {});
  };
  const ack = async (a) => {
    try { const r = await api.post(`/announcements/${a.id}/ack`); toast.success(r.message); reload({ silent: true }); window.dispatchEvent(new Event('notifications:changed')); } catch (e) { toast.error(e); }
  };
  const remove = (a) => confirm({
    title: 'למחוק את ההודעה?', message: a.title, confirmText: 'מחיקה',
    onConfirm: async () => { try { const r = await api.del(`/announcements/${a.id}`); toast.success(r.message); reload({ silent: true }); } catch (e) { toast.error(e); throw e; } },
  });

  return (
    <>
      <PageHeader title="לוח הודעות" subtitle={manage ? 'פרסום הודעות לצוות לפי דחיפות, עם מעקב אחרי מי קרא ואישר' : 'הודעות מההנהלה'}
        actions={manage && <Button variant="primary" icon={Plus} onClick={() => setForm({})}>הודעה חדשה</Button>} />
      {error ? <div className="card"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? <div className="card"><SkeletonRows rows={4} h={90} /></div>
        : !data.announcements.length ? (
          <div className="card"><EmptyState icon={Megaphone} title="אין הודעות כרגע" text={manage ? 'פרסמו הודעה לכל הצוות, לסניף או למחלקה.' : 'כשתתפרסם הודעה חדשה תקבלו התראה.'}
            action={manage && <Button variant="primary" icon={Plus} onClick={() => setForm({})}>הודעה חדשה</Button>} /></div>
        ) : (
          <div className="ann-list">
            {data.announcements.map((a) => (
              <article key={a.id} className={`card ann-card urgency-${a.urgency} ${!a.read_at && !a.mine ? 'unread' : ''} ${a.expired ? 'expired' : ''}`} onMouseEnter={() => markRead(a)} onFocus={() => markRead(a)} onClick={() => markRead(a)} tabIndex={0}>
                <header className="ann-head">
                  <UrgencyBadge urgency={a.urgency} />
                  {a.requires_ack && <Badge tone="primary">דורש אישור</Badge>}
                  {a.expired && <Badge>פג תוקף</Badge>}
                  {!a.read_at && !a.mine && <span className="ann-new">חדש</span>}
                  <span className="subtle ann-when">{timeAgo(a.created_at)}</span>
                </header>
                <h3 className="ann-title">{a.title}</h3>
                {a.body && <div className="ann-body">{a.body}</div>}
                <footer className="ann-foot">
                  <span className="subtle">{a.author_name || 'הנהלה'}{a.location_name ? ` · ${a.location_name}` : ''}{a.department_name ? ` · ${a.department_name}` : ''}{a.expires_at ? ` · עד ${shortDate(a.expires_at)}` : ''}</span>
                  <div className="ann-actions">
                    {a.requires_ack && !a.mine && (a.acked_at ? <Badge tone="success"><CheckCircle2 size={12} /> אישרת</Badge> : <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); ack(a); }}>קראתי ואישרתי</Button>)}
                    {manage && a.stats && (
                      <Button size="sm" variant="ghost" icon={a.requires_ack ? Users : Eye} onClick={(e) => { e.stopPropagation(); setStatus(a); }}>
                        {a.requires_ack ? `${a.stats.acked}/${a.stats.audience} אישרו` : `${a.stats.read}/${a.stats.audience} קראו`}
                      </Button>
                    )}
                    {manage && <IconButton icon={Pencil} label="עריכה" small onClick={(e) => { e.stopPropagation(); setForm(a); }} />}
                    {manage && <IconButton icon={Trash2} label="מחיקה" small onClick={(e) => { e.stopPropagation(); remove(a); }} />}
                  </div>
                </footer>
              </article>
            ))}
          </div>
        )}
      {form && <AnnouncementForm item={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => reload({ silent: true })} />}
      {status && <AckStatus item={status} onClose={() => setStatus(null)} />}
      {confirmDialog}
    </>
  );
}
