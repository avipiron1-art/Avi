import { useRef, useState } from 'react';
import { AlertTriangle, Camera, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { Avatar, Button, Field, Input, Modal, Select, useForm } from './ui.jsx';
import { localToday } from '../lib/format.js';

const EMPTY = {
  employee_code: '', first_name: '', last_name: '', phone: '', email: '', position_id: '', department_id: '', location_id: '',
  start_date: localToday(), status: 'active', hourly_wage: '', avatar: null, can_lead: false, national_id: '', extra_location_ids: [],
};

/** Resize the selected image client-side to a small square JPEG data URL. */
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { reject(new Error('ניתן להעלות קבצי PNG, JPG או WEBP בלבד')); return; }
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('לא ניתן לקרוא את הקובץ'));
    img.src = URL.createObjectURL(file);
  });
}

export default function EmployeeForm({ open, onClose, employee, onSaved, onDeleted }) {
  const { meta, can, user, reloadMeta } = useAuth();
  const toast = useToast();
  const fileRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canDelete = employee && can('employees.delete') && user.employee_id !== employee.id;

  const remove = async () => {
    setDeleting(true);
    try {
      await api.del(`/employees/${employee.id}`);
      toast.success(`${employee.first_name} ${employee.last_name} נמחק/ה מהמערכת`);
      reloadMeta?.();
      onClose();
      onDeleted?.(employee);
    } catch (e) { toast.error(e); } finally { setDeleting(false); }
  };
  const init = employee ? { ...Object.fromEntries(Object.keys(EMPTY).map((k) => [k, employee[k] ?? ''])), can_lead: !!employee.can_lead, extra_location_ids: employee.extra_location_ids || [] } : EMPTY;
  const { values: v, set, setValues, errors, setErrors } = useForm({ ...init, avatar: employee?.avatar || null });

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { setValues((s) => ({ ...s, avatar: null })); const url = await resizeImage(f); setValues((s) => ({ ...s, avatar: url })); } catch (err) { toast.error(err.message); }
  };

  const submit = async (e) => {
    e?.preventDefault();
    setSaving(true);
    try {
      const body = { ...v };
      const r = employee ? await api.put(`/employees/${employee.id}`, body) : await api.post('/employees', body);
      toast.success(employee ? 'פרטי העובד עודכנו בהצלחה' : 'העובד נוסף בהצלחה');
      onSaved?.(r.employee);
      onClose();
    } catch (err) {
      setErrors(err.fields);
      toast.error(err);
    } finally { setSaving(false); }
  };

  const positions = meta.positions; // job types are shared by all departments and branches
  // a branch / department manager can only place people inside their responsibility
  const scope = user?.scope;
  const branches = scope && !scope.all && scope.branches?.length ? scope.branches : meta.locations;
  const departments = scope?.dep ? meta.departments.filter((d) => d.id === scope.dep) : meta.departments;
  const toggleExtra = (id) => set('extra_location_ids')(v.extra_location_ids.includes(id) ? v.extra_location_ids.filter((x) => x !== id) : [...v.extra_location_ids, id]);

  return (
    <Modal open={open} onClose={onClose} wide title={employee ? 'עריכת עובד' : 'הוספת עובד חדש'}
      footer={(
        <>
          {canDelete && !confirmDelete && (
            <Button variant="ghost" icon={Trash2} className="btn-danger-text" style={{ marginInlineEnd: 'auto' }} onClick={() => setConfirmDelete(true)}>מחיקת עובד</Button>
          )}
          <Button onClick={onClose}>ביטול</Button>
          <Button variant="primary" loading={saving} onClick={submit} disabled={confirmDelete}>{employee ? 'שמירת שינויים' : 'הוספת עובד'}</Button>
        </>
      )}>
      {confirmDelete && (
        <div className="alert tone-danger mb delete-confirm" role="alertdialog" aria-label="אישור מחיקה" ref={(el) => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
          <AlertTriangle size={20} className="delete-confirm-icon" />
          <div className="delete-confirm-text">
            <strong>למחוק את {employee.first_name} {employee.last_name} לצמיתות?</strong>
            <span>יימחקו גם המשמרות, הנוכחות, הבקשות וחשבון הכניסה שלו/ה. לא ניתן לבטל את הפעולה. אם העובד/ת רק עזב/ה, עדיף לשנות סטטוס ל"לא פעיל" ולשמור את ההיסטוריה.</span>
          </div>
          <div className="delete-confirm-actions">
            <Button size="sm" onClick={() => setConfirmDelete(false)} disabled={deleting}>ביטול</Button>
            <Button size="sm" variant="danger" icon={Trash2} onClick={remove} loading={deleting}>כן, למחוק</Button>
          </div>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <div className="flex gap-lg mb">
          <Avatar name={`${v.first_name} ${v.last_name}`.trim() || '?'} src={v.avatar} size={72} />
          <div className="flex flex-wrap">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={onFile} />
            <Button size="sm" icon={Camera} onClick={() => fileRef.current.click()}>העלאת תמונה</Button>
            {v.avatar && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setValues((s) => ({ ...s, avatar: null }))}>הסרה</Button>}
          </div>
        </div>
        <div className="form-grid">
          <Field label="שם פרטי *" error={errors.first_name}><Input value={v.first_name} onChange={set('first_name')} invalid={errors.first_name} /></Field>
          <Field label="שם משפחה *" error={errors.last_name}><Input value={v.last_name} onChange={set('last_name')} invalid={errors.last_name} /></Field>
          <Field label="מזהה עובד *" error={errors.employee_code} hint="לדוגמה EMP-1021"><Input value={v.employee_code} onChange={set('employee_code')} invalid={errors.employee_code} dir="ltr" /></Field>
          <Field label="תאריך תחילת עבודה *" error={errors.start_date}><Input type="date" value={v.start_date} onChange={set('start_date')} invalid={errors.start_date} /></Field>
          <Field label="טלפון" error={errors.phone}><Input type="tel" value={v.phone} onChange={set('phone')} invalid={errors.phone} dir="ltr" /></Field>
          <Field label="אימייל" error={errors.email}><Input type="email" value={v.email} onChange={set('email')} invalid={errors.email} dir="ltr" /></Field>
          <Field label="מחלקה" error={errors.department_id}>
            <Select value={v.department_id} onChange={set('department_id')}>{!scope?.dep && <option value="">ללא</option>}{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          </Field>
          <Field label="תפקיד" error={errors.position_id}>
            <Select value={v.position_id} onChange={set('position_id')}><option value="">ללא</option>{positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          </Field>
          <Field label="סניף עיקרי" error={errors.location_id}>
            <Select value={v.location_id} onChange={set('location_id')}><option value="">{scope && !scope.all && branches.length === 1 ? branches[0].name : 'ללא'}</option>{branches.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
          </Field>
          {meta.locations.length > 1 && (
            <Field label="עובד/ת גם בסניפים" className="full" hint="העובד יופיע גם בלוח השיבוץ ובסידור של הסניפים האלה">
              <div className="chips-select">
                {branches.filter((l) => String(l.id) !== String(v.location_id)).map((l) => (
                  <button key={l.id} type="button" className={`chip-toggle ${v.extra_location_ids.includes(l.id) ? 'on' : ''}`} aria-pressed={v.extra_location_ids.includes(l.id)} onClick={() => toggleExtra(l.id)}>{l.name}</button>
                ))}
              </div>
            </Field>
          )}
          <Field label="סטטוס">
            <Select value={v.status} onChange={set('status')}><option value="active">פעיל</option><option value="vacation">בחופשה</option><option value="inactive">לא פעיל</option></Select>
          </Field>
          <Field label="מספר זהות" error={errors.national_id} hint="לדוח החודשי לרואה החשבון"><Input value={v.national_id} onChange={set('national_id')} invalid={errors.national_id} dir="ltr" inputMode="numeric" maxLength={9} /></Field>
          <div className="field"><label>&nbsp;</label><label className="checkbox"><input type="checkbox" checked={!!v.can_lead} onChange={set('can_lead')} />יכול/ה לשמש אחמ״ש</label></div>
          {can('employees.wage') && (
            <Field label={`שכר שעתי (${meta.settings.currency})`} error={errors.hourly_wage}><Input type="number" min="0" step="0.5" value={v.hourly_wage} onChange={set('hourly_wage')} invalid={errors.hourly_wage} /></Field>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
