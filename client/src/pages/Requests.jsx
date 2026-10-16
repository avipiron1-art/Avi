import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Inbox, Check, X, Trash2, ArrowLeftRight, MessageSquare } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Person, Select, SkeletonRows, StatusBadge, Tabs, Textarea, useConfirm, useForm,
} from '../components/ui.jsx';
import { REQUEST_STATUS, REQUEST_TYPE, addDays, dateTime, dayName, fullDate, localToday, shortDate, shiftRange, timeAgo } from '../lib/format.js';

function RequestForm({ initialType = 'vacation', onClose, onSaved }) {
  const { meta, user } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({ type: initialType, start_date: addDays(localToday(), 7), end_date: '', shift_id: '', swap_with_id: '', details: '' });
  const { data: shiftData } = useApi(v.type === 'shift_swap' ? '/shifts' : null, { from: localToday(), to: addDays(localToday(), 45) });
  const myShifts = (shiftData?.shifts || []).filter((s) => s.employee_id === user.employee_id && s.start_at > localToday());

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...v };
      if (v.type === 'shift_swap') { const s = myShifts.find((x) => String(x.id) === String(v.shift_id)); if (s) body.start_date = s.start_at.slice(0, 10); }
      const r = await api.post('/requests', body);
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };

  return (
    <Modal open onClose={onClose} title="הגשת בקשה חדשה" footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>שליחת הבקשה</Button></>}>
      <div className="form-grid">
        <Field label="סוג הבקשה" className="full"><Select value={v.type} onChange={set('type')}>{Object.entries(REQUEST_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {v.type === 'shift_swap' ? (
          <>
            <Field label="המשמרת להחלפה *" className="full" error={errors.shift_id}>
              <Select value={v.shift_id} onChange={set('shift_id')} invalid={errors.shift_id}>
                <option value="">בחרו משמרת</option>
                {myShifts.map((s) => <option key={s.id} value={s.id}>{dayName(s.start_at)} {shortDate(s.start_at)} · {shiftRange(s)}</option>)}
              </Select>
            </Field>
            <Field label="להחליף עם (אופציונלי)" className="full" hint="אם תואם עם עמית, בחרו אותו – באישור המנהל המשמרת תועבר אליו אוטומטית">
              <Select value={v.swap_with_id} onChange={set('swap_with_id')}><option value="">לא נקבע</option>{meta.employees.filter((e) => e.id !== user.employee_id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
            </Field>
          </>
        ) : (
          <>
            <Field label={v.type === 'vacation' ? 'מתאריך *' : v.type === 'availability' ? 'בתוקף מתאריך *' : 'תאריך *'} error={errors.start_date}><Input type="date" value={v.start_date} onChange={set('start_date')} invalid={errors.start_date} /></Field>
            {['vacation', 'availability'].includes(v.type) && <Field label={v.type === 'vacation' ? 'עד תאריך *' : 'עד תאריך (אופציונלי)'} error={errors.end_date}><Input type="date" value={v.end_date} onChange={set('end_date')} min={v.start_date} invalid={errors.end_date} /></Field>}
          </>
        )}
        <Field label="הסבר *" className="full" error={errors.details}><Textarea value={v.details} onChange={set('details')} invalid={errors.details} maxLength={2000} placeholder="פרטו בקצרה את הבקשה" /></Field>
      </div>
    </Modal>
  );
}

function ReviewModal({ request: r, readOnly, onClose, onSaved }) {
  const canAct = !readOnly && r.status === 'pending';
  const toast = useToast();
  const [response, setResponse] = useState('');
  const [busy, setBusy] = useState(null);
  const review = async (status) => {
    setBusy(status);
    try { const res = await api.patch(`/requests/${r.id}/review`, { status, response }); toast.success(res.message); onSaved(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(null); }
  };
  return (
    <Modal open onClose={onClose} title={REQUEST_TYPE[r.type]}
      footer={canAct ? (
        <><Button variant="danger" icon={X} loading={busy === 'rejected'} onClick={() => review('rejected')}>דחייה</Button><Button variant="success" icon={Check} loading={busy === 'approved'} onClick={() => review('approved')}>אישור</Button></>
      ) : <Button onClick={onClose}>סגירה</Button>}>
      <Person name={r.employee_name} avatar={r.employee_avatar} sub={`הוגשה ${timeAgo(r.created_at)}`} size={44} />
      <div className="info-list mt">
        <div><div className="k">תאריך</div><div className="v">{fullDate(r.start_date)}{r.end_date ? ` – ${fullDate(r.end_date)}` : ''}</div></div>
        {r.shift_start_at && <div><div className="k">משמרת</div><div className="v">{shortDate(r.shift_start_at)} <span className="ltr">{shiftRange({ start_at: r.shift_start_at, end_at: r.shift_end_at })}</span></div></div>}
        {r.swap_with_name && <div><div className="k">החלפה עם</div><div className="v">{r.swap_with_name}</div></div>}
        <div><div className="k">סטטוס</div><div className="v"><StatusBadge map={REQUEST_STATUS} value={r.status} /></div></div>
      </div>
      <div className="alert tone-neutral mt"><MessageSquare size={18} /><div style={{ whiteSpace: 'pre-wrap' }}>{r.details}</div></div>
      {canAct ? (
        <Field label="תגובה לעובד (אופציונלי)" className="mt"><Textarea value={response} onChange={(e) => setResponse(e.target.value)} maxLength={1000} style={{ minHeight: 64 }} /></Field>
      ) : r.manager_response && <p className="mt"><strong>תגובת {r.reviewed_by_name}:</strong> {r.manager_response}</p>}
      {r.type === 'shift_swap' && r.swap_with_name && canAct && <p className="subtle mt">באישור הבקשה המשמרת תועבר אוטומטית ל{r.swap_with_name}.</p>}
    </Modal>
  );
}

export default function Requests() {
  const { can, user } = useAuth();
  const toast = useToast();
  const reviewer = can('requests.review');
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(reviewer ? 'pending' : '');
  const [type, setType] = useState('');
  const [form, setForm] = useState(params.get('new') || null);
  const [review, setReview] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const { data, loading, error, reload } = useApi('/requests', { status, type });
  const all = useApi('/requests', {});
  const requests = data?.requests || [];
  const counts = (all.data?.requests || []).reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});

  useEffect(() => { if (params.get('new')) setParams({}, { replace: true }); }, []); // eslint-disable-line
  useEffect(() => {
    const id = Number(params.get('request'));
    if (!id || !data) return;
    const r = requests.find((x) => x.id === id) || all.data?.requests.find((x) => x.id === id);
    if (r) { setReview(r); setParams({}, { replace: true }); } else if (status) setStatus('');
  }, [data, all.data]); // eslint-disable-line

  const refresh = () => { reload({ silent: true }); all.reload({ silent: true }); };
  const withdraw = (r) => confirm({
    title: 'לבטל את הבקשה?', message: 'הבקשה תוסר ולא תגיע לאישור המנהל.', confirmText: 'ביטול הבקשה',
    onConfirm: async () => { try { const res = await api.del(`/requests/${r.id}`); toast.success(res.message); refresh(); } catch (e) { toast.error(e); throw e; } },
  });

  return (
    <>
      <PageHeader title={reviewer ? 'בקשות עובדים' : 'הבקשות שלי'} subtitle={reviewer ? 'אישור חופשות, החלפות משמרת ובקשות כלליות' : 'חופשות, ימי חופש, החלפות משמרת ועוד'}
        actions={user.employee_id && <Button variant="primary" icon={Plus} onClick={() => setForm('vacation')}>בקשה חדשה</Button>} />
      <Tabs value={status} onChange={setStatus} tabs={[
        { value: 'pending', label: 'ממתינות', count: counts.pending || 0 }, { value: 'approved', label: 'אושרו' }, { value: 'rejected', label: 'נדחו' }, { value: '', label: 'הכל' },
      ]} />
      <div className="toolbar">
        <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="סוג בקשה"><option value="">כל הסוגים</option>{Object.entries(REQUEST_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
      </div>
      <Card pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows /> : !requests.length ? (
          <EmptyState icon={Inbox} title={status === 'pending' ? 'אין בקשות שממתינות לטיפול' : 'אין בקשות להצגה'}
            text={reviewer ? 'כל הבקשות טופלו. 🎉' : 'צריכים חופש או החלפת משמרת? הגישו בקשה והמנהל יקבל התראה.'}
            action={user.employee_id && <Button variant="primary" icon={Plus} onClick={() => setForm('vacation')}>הגשת בקשה</Button>} />
        ) : (
          <div className="list">
            {requests.map((r) => (
              <div key={r.id} className="list-item" style={{ alignItems: 'flex-start', cursor: 'pointer' }} onClick={() => setReview(r)} role="button" tabIndex={0}>
                {reviewer ? <Person name={r.employee_name} avatar={r.employee_avatar} size={40} sub={null} /> : <span className="activity-icon tone-primary">{r.type === 'shift_swap' ? <ArrowLeftRight size={16} /> : <Inbox size={16} />}</span>}
                <div className="grow">
                  <div className="flex flex-wrap"><strong>{reviewer ? `${r.employee_name} · ` : ''}{REQUEST_TYPE[r.type]}</strong><StatusBadge map={REQUEST_STATUS} value={r.status} /></div>
                  <div className="muted" style={{ fontSize: '.9rem' }}>
                    {r.shift_start_at ? <>משמרת {shortDate(r.shift_start_at)} <span className="ltr">{shiftRange({ start_at: r.shift_start_at, end_at: r.shift_end_at })}</span>{r.swap_with_name && ` · עם ${r.swap_with_name}`}</> : <>{fullDate(r.start_date)}{r.end_date ? ` – ${fullDate(r.end_date)}` : ''}</>}
                  </div>
                  <div className="subtle" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.details}</div>
                  {r.manager_response && <div className="subtle">תגובה: {r.manager_response}</div>}
                </div>
                <div className="text-end" onClick={(e) => e.stopPropagation()}>
                  <div className="subtle nowrap" title={dateTime(r.created_at)}>{timeAgo(r.created_at)}</div>
                  {reviewer && r.status === 'pending' && r.employee_id !== user.employee_id && <Button size="sm" variant="primary" onClick={() => setReview(r)} style={{ marginTop: 6 }}>טיפול</Button>}
                  {!reviewer && r.status === 'pending' && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => withdraw(r)} style={{ marginTop: 6 }}>ביטול</Button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
      {user.employee_id && <button type="button" className="fab" aria-label="בקשה חדשה" onClick={() => setForm('vacation')}><Plus size={24} /></button>}
      {form && <RequestForm initialType={REQUEST_TYPE[form] ? form : 'vacation'} onClose={() => setForm(null)} onSaved={refresh} />}
      {review && <ReviewModal request={review} readOnly={!reviewer || review.employee_id === user.employee_id} onClose={() => setReview(null)} onSaved={refresh} />}
      {confirmDialog}
    </>
  );
}
