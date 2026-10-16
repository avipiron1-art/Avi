import { useMemo, useState } from 'react';
import { AlertTriangle, Copy, Trash2, Search } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { Avatar, Button, Field, Input, Modal, Select, Textarea, useForm } from './ui.jsx';
import { addDays, time } from '../lib/format.js';

/** Modal that lists scheduling conflicts and lets the manager save anyway. */
export function ConflictDialog({ conflicts, onCancel, onForce, loading }) {
  return (
    <Modal open={!!conflicts} onClose={onCancel} title="נמצאו התנגשויות בשיבוץ"
      footer={<><Button onClick={onCancel}>חזרה לעריכה</Button><Button variant="danger" onClick={onForce} loading={loading}>שמירה בכל זאת</Button></>}>
      <p className="muted">לפני השמירה, שימו לב לבעיות הבאות:</p>
      <ul className="conflict-list">
        {conflicts?.map((c, i) => <li key={i}><AlertTriangle size={18} style={{ color: 'var(--warning)', flexShrink: 0 }} />{c.message}</li>)}
      </ul>
    </Modal>
  );
}

/**
 * Run a save function that may return 409 conflicts. Returns [run, dialog].
 * fn(force) must call the API with { force }.
 */
export function useConflictSave() {
  const toast = useToast();
  const [pending, setPending] = useState(null);
  const [loading, setLoading] = useState(false);
  const run = async (fn, onDone) => {
    try {
      const r = await fn(false);
      onDone?.(r);
      return r;
    } catch (e) {
      if (e.status === 409 && e.data.conflicts) { setPending({ fn, onDone, conflicts: e.data.conflicts }); return null; }
      toast.error(e);
      throw e;
    }
  };
  const dialog = (
    <ConflictDialog
      conflicts={pending?.conflicts}
      loading={loading}
      onCancel={() => setPending(null)}
      onForce={async () => {
        setLoading(true);
        try { const r = await pending.fn(true); pending.onDone?.(r); setPending(null); } catch (e) { toast.error(e); } finally { setLoading(false); }
      }}
    />
  );
  return [run, dialog];
}

export default function ShiftForm({ open, onClose, shift, defaults = {}, onSaved }) {
  const { meta } = useAuth();
  const toast = useToast();
  const isEdit = !!shift?.id;
  const [saving, setSaving] = useState(false);
  const [empSearch, setEmpSearch] = useState('');
  const [dupDate, setDupDate] = useState(shift ? addDays(shift.start_at.slice(0, 10), 7) : '');
  const [run, conflictDialog] = useConflictSave();
  const { values: v, set, setValues, errors, setErrors } = useForm(isEdit ? {
    date: shift.start_at.slice(0, 10), start_time: time(shift.start_at), end_time: time(shift.end_at),
    employee_id: String(shift.employee_id), employee_ids: [], position_id: shift.position_id ?? '', location_id: shift.location_id ?? '', note: shift.note ?? '',
  } : {
    date: defaults.date || '', start_time: '08:00', end_time: '16:00', employee_id: '', employee_ids: defaults.employee_ids || [],
    position_id: '', location_id: meta.locations[0]?.id ?? '', note: '',
  });

  const activeEmployees = useMemo(() => meta.employees.filter((e) => e.status !== 'inactive'
    && (!empSearch || e.name.includes(empSearch))), [meta.employees, empSearch]);
  const toggleEmp = (id) => setValues((s) => ({ ...s, employee_ids: s.employee_ids.includes(id) ? s.employee_ids.filter((x) => x !== id) : [...s.employee_ids, id] }));
  const overnight = v.end_time && v.start_time && v.end_time <= v.start_time;

  const submit = async () => {
    setSaving(true);
    setErrors({});
    const body = { date: v.date, start_time: v.start_time, end_time: v.end_time, position_id: v.position_id, location_id: v.location_id, note: v.note };
    try {
      await run(
        (force) => (isEdit
          ? api.put(`/shifts/${shift.id}`, { ...body, employee_id: Number(v.employee_id), force })
          : api.post('/shifts', { ...body, employee_ids: v.employee_ids, force })),
        (r) => { toast.success(r.message); onSaved?.(); onClose(); },
      );
    } catch (e) { setErrors(e.fields || {}); } finally { setSaving(false); }
  };

  const duplicate = async () => {
    if (!dupDate) return;
    await run((force) => api.post(`/shifts/${shift.id}/duplicate`, { date: dupDate, force }), (r) => { toast.success(r.message); onSaved?.(); onClose(); }).catch(() => {});
  };

  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancelShift = async () => {
    try { const r = await api.del(`/shifts/${shift.id}`); toast.success(r.message); onSaved?.(); onClose(); } catch (e) { toast.error(e); }
  };

  return (
    <>
      <Modal open={open} onClose={onClose} title={isEdit ? 'עריכת משמרת' : 'משמרת חדשה'} wide
        footer={(
          <>
            {isEdit && <Button variant="ghost" icon={Trash2} style={{ color: 'var(--danger)', marginInlineEnd: 'auto' }} onClick={() => setConfirmCancel(true)}>ביטול משמרת</Button>}
            <Button onClick={onClose}>סגירה</Button>
            <Button variant="primary" loading={saving} onClick={submit} disabled={!isEdit && !v.employee_ids.length}>
              {isEdit ? 'שמירת שינויים' : v.employee_ids.length > 1 ? `יצירת ${v.employee_ids.length} משמרות` : 'שמירת משמרת'}
            </Button>
          </>
        )}>
        {confirmCancel ? (
          <div className="alert tone-danger mb" style={{ alignItems: 'center' }}>
            <AlertTriangle size={20} />
            <div style={{ flex: 1 }}>לבטל את המשמרת? העובד יקבל התראה על הביטול.</div>
            <Button size="sm" onClick={() => setConfirmCancel(false)}>לא</Button>
            <Button size="sm" variant="danger" onClick={cancelShift}>כן, לבטל</Button>
          </div>
        ) : null}
        <div className="form-grid">
          <Field label="תאריך *" error={errors.date}><Input type="date" value={v.date} onChange={set('date')} invalid={errors.date} /></Field>
          <div className="form-grid" style={{ gap: 10 }}>
            <Field label="התחלה *" error={errors.start_time}><Input type="time" value={v.start_time} onChange={set('start_time')} invalid={errors.start_time} /></Field>
            <Field label="סיום *" error={errors.end_time} hint={overnight ? 'מסתיימת למחרת' : undefined}><Input type="time" value={v.end_time} onChange={set('end_time')} invalid={errors.end_time} /></Field>
          </div>
          {isEdit ? (
            <Field label="עובד *" className="full" error={errors.employee_id}>
              <Select value={v.employee_id} onChange={set('employee_id')}>{meta.employees.filter((e) => e.status !== 'inactive' || String(e.id) === v.employee_id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>
            </Field>
          ) : (
            <Field label={`עובדים * ${v.employee_ids.length ? `(${v.employee_ids.length} נבחרו)` : ''}`} className="full" error={errors.employee_ids} hint="ניתן לבחור כמה עובדים וליצור לכולם את אותה משמרת">
              <div className="input-icon" style={{ marginBottom: 6 }}><Search size={16} /><Input placeholder="סינון עובדים..." value={empSearch} onChange={(e) => setEmpSearch(e.target.value)} /></div>
              <div className="chips-select">
                {activeEmployees.map((e) => (
                  <button key={e.id} type="button" className={`chip-toggle ${v.employee_ids.includes(e.id) ? 'on' : ''}`} onClick={() => toggleEmp(e.id)} aria-pressed={v.employee_ids.includes(e.id)}>
                    <Avatar name={e.name} src={e.avatar} size={20} />{e.name}
                  </button>
                ))}
                {!activeEmployees.length && <span className="subtle">לא נמצאו עובדים</span>}
              </div>
            </Field>
          )}
          <Field label="תפקיד במשמרת">
            <Select value={v.position_id} onChange={set('position_id')}><option value="">לפי תפקיד העובד</option>{meta.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          </Field>
          <Field label="מיקום">
            <Select value={v.location_id} onChange={set('location_id')}><option value="">ללא</option>{meta.locations.filter((l) => l.is_active || l.id === Number(v.location_id)).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          </Field>
          <Field label="הערה" className="full" error={errors.note}><Textarea value={v.note} onChange={set('note')} maxLength={500} style={{ minHeight: 64 }} /></Field>
        </div>
        {isEdit && (
          <div className="card card-pad mt" style={{ background: 'var(--surface-2)' }}>
            <h3 className="flex" style={{ marginBottom: 10 }}><Copy size={16} />שכפול משמרת</h3>
            <div className="flex flex-wrap">
              <Input type="date" value={dupDate} onChange={(e) => setDupDate(e.target.value)} style={{ maxWidth: 200 }} aria-label="תאריך לשכפול" />
              <Button icon={Copy} onClick={duplicate} disabled={!dupDate}>שכפול לתאריך</Button>
            </div>
          </div>
        )}
      </Modal>
      {conflictDialog}
    </>
  );
}
