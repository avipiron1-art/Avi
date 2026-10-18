import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  KeyRound, Building2, Network, UserCog, ShieldCheck, History, Plus, Pencil, Trash2, Save, Search, Lock, ChevronDown, ChevronUp, Moon, Sun, RotateCcw, MapPin, Upload, Image as ImageIcon, Fingerprint, CloudUpload, Mail, AlertTriangle,
} from 'lucide-react';
import { useApi, useDebounced } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { useTheme } from '../lib/theme.js';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, Modal, PageHeader, Select, SkeletonRows, Tabs, Textarea, useConfirm, useForm,
} from '../components/ui.jsx';
import { dateTime } from '../lib/format.js';
import { applyBrandColor, useBranding } from '../lib/branding.jsx';
import SecuritySettings from '../components/SecuritySettings.jsx';
import { SCOPES, scopeLabel } from '../lib/scopes.js';
import BackupSettings from '../components/BackupSettings.jsx';
import MailSettings from '../components/MailSettings.jsx';

// ---------------- profile ----------------
function Profile() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, setValues, errors, setErrors } = useForm({ current_password: '', new_password: '', confirm: '' });
  const save = async () => {
    if (v.new_password !== v.confirm) { setErrors({ confirm: 'הסיסמאות אינן תואמות' }); return; }
    setSaving(true);
    try {
      await api.post('/auth/change-password', { current_password: v.current_password, new_password: v.new_password });
      toast.success('הסיסמה עודכנה. נותקת מכל שאר המכשירים');
      setValues({ current_password: '', new_password: '', confirm: '' });
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <div className="grid grid-2">
      <Card title="שינוי סיסמה" icon={KeyRound}>
        <div className="grid">
          <Field label="סיסמה נוכחית" error={errors.current_password}><Input type="password" autoComplete="current-password" value={v.current_password} onChange={set('current_password')} dir="ltr" /></Field>
          <Field label="סיסמה חדשה" error={errors.new_password} hint="לפחות 8 תווים, כולל אות באנגלית וספרה"><Input type="password" autoComplete="new-password" value={v.new_password} onChange={set('new_password')} dir="ltr" /></Field>
          <Field label="אימות סיסמה חדשה" error={errors.confirm}><Input type="password" autoComplete="new-password" value={v.confirm} onChange={set('confirm')} dir="ltr" /></Field>
          <div><Button variant="primary" icon={Save} onClick={save} loading={saving}>עדכון סיסמה</Button></div>
        </div>
      </Card>
      <Account />
    </div>
  );
}

/** Important notifications also by email (shift assigned, request answered, urgent announcements). */
function EmailToggle() {
  const toast = useToast();
  const { user, refresh } = useAuth();
  const [on, setOn] = useState(!!user.email_notifications);
  const change = async (e) => {
    const enabled = e.target.checked;
    setOn(enabled);
    try { const r = await api.put('/auth/email-notifications', { enabled }); toast.success(r.message); refresh(); } catch (err) { setOn(!enabled); toast.error(err); }
  };
  return (
    <label className="checkbox mt" style={{ alignItems: 'flex-start' }}>
      <input type="checkbox" checked={on} onChange={change} />
      <span>קבלת התראות חשובות גם במייל<br /><span className="subtle">שיבוץ ושינוי משמרות, תשובות לבקשות והודעות דחופות</span></span>
    </label>
  );
}

/** Own account details. The main admin can edit name / username / email; the role title stays separate. */
function Account() {
  const toast = useToast();
  const { user, can, refresh } = useAuth();
  const [theme, toggle] = useTheme();
  const editable = can('users.manage');
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({ display_name: user.display_name, username: user.username, email: user.email, current_password: '' });
  const loginChanged = v.username.trim().toLowerCase() !== user.username.toLowerCase() || v.email.trim().toLowerCase() !== user.email.toLowerCase();
  const changed = loginChanged || v.display_name.trim() !== user.display_name;
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put('/auth/profile', v);
      toast.success(r.message);
      await refresh();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Card title="החשבון שלי" icon={UserCog}>
      {editable ? (
        <div className="grid">
          <Field label="השם שלך" error={errors.display_name} hint="השם שמוצג במערכת וביומן הפעולות"><Input value={v.display_name} onChange={set('display_name')} invalid={errors.display_name} /></Field>
          <Field label="שם משתמש (לכניסה)" error={errors.username}><Input value={v.username} onChange={set('username')} invalid={errors.username} dir="ltr" autoComplete="username" /></Field>
          <Field label="אימייל" error={errors.email}><Input type="email" value={v.email} onChange={set('email')} invalid={errors.email} dir="ltr" /></Field>
          {loginChanged && (
            <Field label="סיסמה נוכחית (לאישור השינוי)" error={errors.current_password}>
              <Input type="password" value={v.current_password} onChange={set('current_password')} invalid={errors.current_password} dir="ltr" autoComplete="current-password" />
            </Field>
          )}
          <div className="info-list"><div><div className="k">תפקיד</div><div className="v">{user.role_name}</div></div></div>
          <div><Button variant="primary" icon={Save} onClick={save} loading={saving} disabled={!changed}>שמירת פרטים</Button></div>
        </div>
      ) : (
        <div className="info-list">
          <div><div className="k">שם</div><div className="v">{user.display_name}</div></div>
          <div><div className="k">שם משתמש</div><div className="v ltr">{user.username}</div></div>
          <div><div className="k">אימייל</div><div className="v ltr">{user.email}</div></div>
          <div><div className="k">תפקיד</div><div className="v">{user.role_name}</div></div>
        </div>
      )}
      {user.mail_enabled && <EmailToggle />}
      <div className="mt"><Button icon={theme === 'dark' ? Sun : Moon} onClick={toggle}>{theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה'}</Button></div>
    </Card>
  );
}

// ---------------- business settings ----------------
function Business() {
  const toast = useToast();
  const branding = useBranding();
  useEffect(() => () => applyBrandColor(branding.brand_color), [branding.brand_color]); // undo unsaved preview on leave
  const { reloadMeta } = useAuth();
  const { data, loading, error, reload } = useApi('/settings');
  const [v, setV] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setV(data.settings); }, [data]);
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading || !v) return <Card><SkeletonRows /></Card>;
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const save = async () => {
    setSaving(true);
    try { const r = await api.put('/settings', v); toast.success(r.message); setErrors({}); reloadMeta(); branding.reload(); } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Card title="הגדרות העסק" icon={Building2} actions={<Button variant="primary" icon={Save} onClick={save} loading={saving}>שמירה</Button>}>
      <div className="form-grid">
        <Field label="שם העסק" error={errors.business_name}><Input value={v.business_name} onChange={set('business_name')} /></Field>
        <Field label="אזור זמן" error={errors.timezone}><Input value={v.timezone} onChange={set('timezone')} dir="ltr" /></Field>
        <Field label="מטבע" error={errors.currency}><Input value={v.currency} onChange={set('currency')} /></Field>
        <Field label="סבולת איחור (דקות)" hint="כניסה אחרי זמן זה תיחשב איחור" error={errors.late_grace_minutes}><Input type="number" min="0" value={v.late_grace_minutes} onChange={set('late_grace_minutes')} /></Field>
        <Field label="סבולת יציאה מוקדמת (דקות)" error={errors.early_leave_grace_minutes}><Input type="number" min="0" value={v.early_leave_grace_minutes} onChange={set('early_leave_grace_minutes')} /></Field>
        <Field label="שעות נוספות אחרי (שעות למשמרת)" error={errors.overtime_daily_hours}><Input type="number" min="1" step="0.5" value={v.overtime_daily_hours} onChange={set('overtime_daily_hours')} /></Field>
        <Field label="התראה על משימה (ימים לפני היעד)" error={errors.task_due_soon_days}><Input type="number" min="0" value={v.task_due_soon_days} onChange={set('task_due_soon_days')} /></Field>
        <Field label="תזכורת לסיום משמרת (דקות אחרי הסיום)" hint="לעובד שעדיין לא החתים יציאה. 0 = מיד בסיום" error={errors.shift_end_reminder_minutes}><Input type="number" min="0" max="240" value={v.shift_end_reminder_minutes} onChange={set('shift_end_reminder_minutes')} /></Field>
      </div>

      <h3 className="settings-section">מיתוג</h3>
      <div className="form-grid">
        <Field label="לוגו העסק" hint="PNG / JPG, יוצג בתפריט, במסך הכניסה ובהזמנות" error={errors.logo}>
          <div className="logo-picker">
            {v.logo ? <img src={v.logo} alt="לוגו" /> : <span className="logo-empty"><ImageIcon size={22} /></span>}
            <label className="btn btn-sm">
              <Upload size={15} />העלאה
              <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                try { const logo = await shrinkImage(f, 256); setV((x) => ({ ...x, logo })); } catch { toast.error('לא ניתן לקרוא את התמונה'); }
              }} />
            </label>
            {v.logo && <Button size="sm" variant="ghost" onClick={() => setV((x) => ({ ...x, logo: '' }))}>הסרה</Button>}
          </div>
        </Field>
        <Field label="צבע ראשי" hint="הכפתורים, הקישורים והתפריט ייצבעו בצבע הזה" error={errors.brand_color}>
          <div className="flex flex-wrap">
            <Input type="color" value={v.brand_color || '#4f46e5'} onChange={(e) => { set('brand_color')(e); applyBrandColor(e.target.value); }} style={{ width: 64, padding: 4 }} />
            {BRAND_COLORS.map((c) => <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`צבע ${c}`} onClick={() => { setV((x) => ({ ...x, brand_color: c })); applyBrandColor(c); }} />)}
          </div>
        </Field>
      </div>

      <h3 className="settings-section">שעות נוספות ותעריפים</h3>
      <p className="subtle" style={{ marginTop: 0 }}>ברירת המחדל לפי חוק שעות עבודה ומנוחה: 8 שעות רגילות ביום (8.6 בשבוע של 5 ימים), שעתיים ראשונות 125%, ומעבר לכך 150%. ביום המנוחה ובחגים 150%, ונוספות בהם 175%/200%. מומלץ לאמת מול רואה החשבון.</p>
      <div className="form-grid">
        <Field label="שעות נוספות 125% – כמה שעות" error={errors.ot_tier1_hours}><Input type="number" min="0" step="0.5" value={v.ot_tier1_hours} onChange={set('ot_tier1_hours')} /></Field>
        <Field label="תעריף נוספות ראשונות" hint="1.25 = 125%" error={errors.rate_ot1}><Input type="number" min="1" step="0.05" value={v.rate_ot1} onChange={set('rate_ot1')} /></Field>
        <Field label="תעריף נוספות מעבר לכך" hint="1.5 = 150%" error={errors.rate_ot2}><Input type="number" min="1" step="0.05" value={v.rate_ot2} onChange={set('rate_ot2')} /></Field>
        <Field label="תעריף יום מנוחה / חג" hint="1.5 = 150%" error={errors.rate_rest_day}><Input type="number" min="1" step="0.05" value={v.rate_rest_day} onChange={set('rate_rest_day')} /></Field>
        <Field label="יום המנוחה השבועי" error={errors.rest_day}>
          <Select value={v.rest_day} onChange={set('rest_day')}>
            {['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'].map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

const BRAND_COLORS = ['#4f46e5', '#0ea5e9', '#059669', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#334155'];

/** Resize an uploaded image to fit `max`×`max` and return a data URL (keeps the upload small). */
function shrinkImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------------- departments / positions / locations ----------------
const REF = {
  departments: { title: 'מחלקות', label: 'מחלקה', empty: { name: '', description: '', color: '#6366f1' } },
  positions: { title: 'תפקידים (סוגי עובדים)', label: 'תפקיד', empty: { name: '' } },
  locations: { title: 'סניפים ומיקומים', label: 'מיקום', empty: { name: '', address: '', is_active: true, latitude: '', longitude: '', radius_m: 150, require_location: false } },
};

/** Coordinates + radius for location-based clock-in. "Use my location" fills them from the phone's GPS. */
function LocationGeo({ edit, setEdit, errors }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const here = () => {
    if (!navigator.geolocation) { toast.error('הדפדפן לא תומך במיקום'); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setBusy(false); setEdit((s) => ({ ...s, latitude: p.coords.latitude.toFixed(6), longitude: p.coords.longitude.toFixed(6) })); toast.success(`המיקום נקלט (דיוק ${Math.round(p.coords.accuracy)} מ׳)`); },
      () => { setBusy(false); toast.error('לא ניתן לקבל מיקום. אשר/י גישה למיקום ונסה/י שוב.'); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  return (
    <div className="geo-box">
      <div style={{ fontWeight: 600 }}>החתמה לפי מיקום</div>
      <p className="subtle" style={{ margin: 0 }}>עמד/י בסניף ולחצ/י על "המיקום הנוכחי שלי". עובדים יוכלו להחתים רק בטווח שהגדרת.</p>
      <Button icon={MapPin} loading={busy} onClick={here}>המיקום הנוכחי שלי</Button>
      <div className="grid grid-2">
        <Field label="קו רוחב" error={errors.latitude}><Input inputMode="decimal" className="ltr" value={edit.latitude ?? ''} onChange={(e) => setEdit((s) => ({ ...s, latitude: e.target.value }))} /></Field>
        <Field label="קו אורך" error={errors.longitude}><Input inputMode="decimal" className="ltr" value={edit.longitude ?? ''} onChange={(e) => setEdit((s) => ({ ...s, longitude: e.target.value }))} /></Field>
      </div>
      <Field label="רדיוס מותר (מטרים)" error={errors.radius_m}><Input type="number" min={30} max={5000} value={edit.radius_m ?? 150} onChange={(e) => setEdit((s) => ({ ...s, radius_m: e.target.value }))} /></Field>
      <label className="checkbox"><input type="checkbox" checked={!!edit.require_location} onChange={(e) => setEdit((s) => ({ ...s, require_location: e.target.checked }))} />לחייב החתמה מתוך הסניף</label>
    </div>
  );
}

function RefList({ kind }) {
  const { meta, reloadMeta } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [confirm, confirmDialog] = useConfirm();
  const cfg = REF[kind];
  const items = meta[kind];

  const save = async () => {
    setSaving(true);
    try {
      const body = { ...edit };
      delete body.id;
      const r = edit.id ? await api.put(`/meta/${kind}/${edit.id}`, body) : await api.post(`/meta/${kind}`, body);
      toast.success(r.message); setEdit(null); setErrors({}); reloadMeta();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  const remove = (it) => confirm({
    title: `למחוק את "${it.name}"?`, message: 'עובדים ומשמרות המשויכים יישארו ללא שיוך. לא ניתן לבטל פעולה זו.', confirmText: 'מחיקה',
    onConfirm: async () => { try { const r = await api.del(`/meta/${kind}/${it.id}`); toast.success(r.message); reloadMeta(); } catch (e) { toast.error(e); throw e; } },
  });

  return (
    <Card title={cfg.title} pad={false} actions={<Button size="sm" icon={Plus} onClick={() => setEdit({ ...cfg.empty })}>הוספה</Button>}>
      {!items.length ? <EmptyState title={`אין ${cfg.title}`} action={<Button icon={Plus} onClick={() => setEdit({ ...cfg.empty })}>הוספת {cfg.label}</Button>} /> : (
        <div className="list">
          {items.map((it) => (
            <div key={it.id} className="list-item">
              {kind === 'departments' && <i style={{ width: 12, height: 12, borderRadius: 4, background: it.color }} />}
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{it.name}{kind === 'locations' && !it.is_active && <Badge> לא פעיל</Badge>}</div>
                <div className="subtle">{kind === 'departments' ? `${it.employee_count} עובדים${it.description ? ` · ${it.description}` : ''}` : kind === 'positions' ? '' : it.address}</div>
              </div>
              <IconButton icon={Pencil} label="עריכה" small onClick={() => setEdit(kind === 'locations' ? { ...it, is_active: !!it.is_active, require_location: !!it.require_location, latitude: it.latitude ?? '', longitude: it.longitude ?? '' } : it)} />
              <IconButton icon={Trash2} label="מחיקה" small onClick={() => remove(it)} />
            </div>
          ))}
        </div>
      )}
      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? `עריכת ${cfg.label}` : `${cfg.label} חדש/ה`} footer={<><Button onClick={() => setEdit(null)}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>שמירה</Button></>}>
          <div className="grid">
            <Field label="שם *" error={errors.name}><Input value={edit.name} onChange={(e) => setEdit((s) => ({ ...s, name: e.target.value }))} invalid={errors.name} /></Field>
            {kind === 'departments' && <>
              <Field label="תיאור"><Textarea value={edit.description || ''} onChange={(e) => setEdit((s) => ({ ...s, description: e.target.value }))} style={{ minHeight: 60 }} /></Field>
              <Field label="צבע בלוח המשמרות"><Input type="color" value={edit.color} onChange={(e) => setEdit((s) => ({ ...s, color: e.target.value }))} style={{ width: 80, padding: 4 }} /></Field>
            </>}
            {kind === 'positions' && <p className="subtle" style={{ margin: 0 }}>למשל מלצר, טבח, שוטף. התפקיד משותף לכל המחלקות והסניפים.</p>}
            {kind === 'locations' && <>
              <Field label="כתובת"><Input value={edit.address || ''} onChange={(e) => setEdit((s) => ({ ...s, address: e.target.value }))} /></Field>
              <label className="checkbox"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit((s) => ({ ...s, is_active: e.target.checked }))} />פעיל</label>
              <LocationGeo edit={edit} setEdit={setEdit} errors={errors} />
            </>}
          </div>
        </Modal>
      )}
      {confirmDialog}
    </Card>
  );
}

// ---------------- users ----------------
function UserForm({ user: u, onClose, onSaved }) {
  const { meta } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({
    username: u?.username || '', email: u?.email || '', display_name: u?.display_name || '', role: u?.role || 'employee',
    employee_id: u?.employee_id ?? '', is_active: u ? !!u.is_active : true, password: '', location_id: u?.location_id ?? '',
    department_id: u?.department_id ?? '', location_ids: u?.location_ids || [],
  });
  const roleScope = meta.roles.find((r) => r.key === v.role)?.scope || (v.role === 'admin' ? 'all' : 'self');
  const emp = meta.employees.find((e) => String(e.id) === String(v.employee_id));
  const empLoc = emp && meta.locations.find((l) => l.id === emp.location_id)?.name;
  const empDep = emp && meta.departments.find((d) => d.id === emp.department_id)?.name;
  const toggleLoc = (id) => set('location_ids')(v.location_ids.includes(id) ? v.location_ids.filter((x) => x !== id) : [...v.location_ids, id]);
  const [resetting, setResetting] = useState(false);
  const resetMfa = async () => {
    setResetting(true);
    try { const r = await api.post(`/users/${u.id}/reset-mfa`); toast.success(r.message); onSaved(); } catch (e) { toast.error(e); } finally { setResetting(false); }
  };
  const save = async () => {
    setSaving(true);
    try {
      const body = { ...v };
      if (u) delete body.password;
      const r = u ? await api.put(`/users/${u.id}`, body) : await api.post('/users', body);
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={u ? 'עריכת משתמש' : 'משתמש חדש'} footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>שמירה</Button></>}>
      <div className="form-grid">
        <Field label="שם תצוגה *" error={errors.display_name}><Input value={v.display_name} onChange={set('display_name')} invalid={errors.display_name} /></Field>
        <Field label="שם משתמש *" error={errors.username}><Input value={v.username} onChange={set('username')} invalid={errors.username} dir="ltr" /></Field>
        <Field label="אימייל *" className="full" error={errors.email}><Input type="email" value={v.email} onChange={set('email')} invalid={errors.email} dir="ltr" /></Field>
        <Field label="תפקיד *"><Select value={v.role} onChange={set('role')}>{meta.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></Field>
        <Field label="כרטיס עובד משויך" error={errors.employee_id}><Select value={v.employee_id} onChange={set('employee_id')}><option value="">ללא</option>{meta.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
        {!u && <Field label="סיסמה ראשונית *" className="full" error={errors.password} hint="לפחות 8 תווים, כולל אות באנגלית וספרה"><Input type="text" value={v.password} onChange={set('password')} invalid={errors.password} dir="ltr" autoComplete="off" /></Field>}
        <div className="full scope-box">
          <div className="scope-box-head"><ShieldCheck size={16} /> <strong>תחום אחריות:</strong> {scopeLabel(roleScope)}</div>
          {['branch', 'department'].includes(roleScope) && meta.locations.length > 0 && (
            <Field label="הסניף שבאחריותו" hint={empLoc ? `ריק = לפי כרטיס העובד (${empLoc})` : 'חובה כשאין כרטיס עובד עם סניף'} error={errors.location_id}>
              <Select value={v.location_id} onChange={set('location_id')}><option value="">{empLoc ? `לפי כרטיס העובד (${empLoc})` : 'בחירת סניף…'}</option>{meta.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
            </Field>
          )}
          {['department', 'department_all'].includes(roleScope) && (
            <Field label="המחלקה שבאחריותו" hint={empDep ? `ריק = לפי כרטיס העובד (${empDep})` : 'חובה כשאין כרטיס עובד עם מחלקה'} error={errors.department_id}>
              <Select value={v.department_id} onChange={set('department_id')}><option value="">{empDep ? `לפי כרטיס העובד (${empDep})` : 'בחירת מחלקה…'}</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
            </Field>
          )}
          {roleScope === 'branches' && (
            <Field label="הסניפים שבאחריותו">
              <div className="chips-select">
                {meta.locations.map((l) => (
                  <button key={l.id} type="button" className={`chip-toggle ${v.location_ids.includes(l.id) ? 'on' : ''}`} aria-pressed={v.location_ids.includes(l.id)} onClick={() => toggleLoc(l.id)}>{l.name}</button>
                ))}
              </div>
            </Field>
          )}
          {roleScope === 'lead' && <p className="subtle" style={{ margin: 0 }}>ההרשאות של התפקיד פועלות רק בזמן משמרת שבה הוא משובץ כאחמ"ש, ורק על העובדים שבאותה משמרת.</p>}
          {roleScope === 'self' && <p className="subtle" style={{ margin: 0 }}>רואה ומנהל רק את הדברים של עצמו.</p>}
          {roleScope === 'all' && <p className="subtle" style={{ margin: 0 }}>אחראי על כל הסניפים וכל העובדים.</p>}
        </div>
        <label className="checkbox full"><input type="checkbox" checked={v.is_active} onChange={set('is_active')} />משתמש פעיל (רשאי להתחבר)</label>
        {u && (u.totp_enabled || u.passkeys > 0) && (
          <div className="alert tone-info full" style={{ alignItems: 'center' }}>
            <ShieldCheck size={18} />
            <span className="grow">למשתמש מופעל {u.totp_enabled ? 'אימות דו-שלבי' : ''}{u.totp_enabled && u.passkeys ? ' ו' : ''}{u.passkeys ? 'כניסה בטביעת אצבע' : ''}. איבד/ה את הטלפון?</span>
            <Button size="sm" loading={resetting} onClick={resetMfa}>איפוס</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function UserPermissions({ user: u, onClose, onSaved }) {
  const toast = useToast();
  const { data, loading } = useApi(`/users/${u.id}/permissions`);
  const [set, setSet] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setSet(new Set(data.effective)); }, [data]);
  const role = new Set(data?.role_permissions || []);
  const toggle = (p) => setSet((cur) => { const n = new Set(cur); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const diffCount = set ? data.catalog.filter((p) => set.has(p.key) !== role.has(p.key)).length : 0;
  const save = async () => {
    setSaving(true);
    try { const r = await api.put(`/users/${u.id}/permissions`, { permissions: [...set] }); toast.success(r.message); onSaved(); onClose(); } catch (e) { toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} wide title={`הרשאות אישיות · ${u.display_name}`}
      footer={data?.locked ? <Button onClick={onClose}>סגירה</Button> : (
        <>
          <Button variant="ghost" icon={RotateCcw} onClick={() => setSet(new Set(role))} disabled={!diffCount} style={{ marginInlineEnd: 'auto' }}>איפוס להרשאות התפקיד</Button>
          <Button onClick={onClose}>ביטול</Button>
          <Button variant="primary" onClick={save} loading={saving}>שמירה</Button>
        </>
      )}>
      {loading || !set ? <SkeletonRows rows={6} /> : data.locked ? (
        <p className="muted">למנהל ראשי יש תמיד גישה מלאה לכל המערכת.</p>
      ) : (
        <>
          <p className="muted mb">ברירת המחדל היא ההרשאות של התפקיד <strong>{data.user.role_name}</strong>. כאן אפשר להוסיף או להסיר הרשאות רק למשתמש הזה, בלי לשנות את שאר המשתמשים באותו תפקיד.</p>
          <div className="perm-list">
            {data.catalog.map((p) => {
              const on = set.has(p.key);
              const custom = on !== role.has(p.key);
              return (
                <label key={p.key} className={`perm-item ${custom ? 'custom' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(p.key)} />
                  <span className="perm-item-label">{p.label}</span>
                  {custom && <Badge tone={on ? 'success' : 'danger'}>{on ? 'נוספה אישית' : 'הוסרה אישית'}</Badge>}
                </label>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Easy-to-read temporary password: letters + digits, no look-alike characters. */
function randomPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set, n) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => set[x % set.length]).join('');
  return `${pick(letters, 1).toUpperCase()}${pick(letters, 4)}${pick(digits, 4)}`;
}

function Users() {
  const toast = useToast();
  const { user: me } = useAuth();
  const { data, loading, error, reload } = useApi('/users');
  const [form, setForm] = useState(null);
  const [pw, setPw] = useState(null);
  const [permsFor, setPermsFor] = useState(null);
  const [newPw, setNewPw] = useState('');
  const [pwErr, setPwErr] = useState('');
  const [confirm, confirmDialog] = useConfirm();
  const remove = (u) => confirm({
    title: `למחוק את המשתמש ${u.display_name}?`, message: 'המשתמש לא יוכל להתחבר יותר. כרטיס העובד (אם קיים) לא יימחק.', confirmText: 'מחיקה',
    onConfirm: async () => { try { const r = await api.del(`/users/${u.id}`); toast.success(r.message); reload({ silent: true }); } catch (e) { toast.error(e); throw e; } },
  });
  const setPassword = async () => {
    try { const r = await api.post(`/users/${pw.id}/password`, { password: newPw }); toast.success(r.message); setPw(null); setNewPw(''); setPwErr(''); } catch (e) { setPwErr(e.fields?.password || e.message); }
  };
  return (
    <Card title="משתמשים והרשאות גישה" icon={UserCog} pad={false} actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => setForm({})}>משתמש חדש</Button>}>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>משתמש</th><th className="hide-sm">שם משתמש</th><th>הרשאה</th><th className="hide-sm">כרטיס עובד</th><th className="hide-sm">התחברות אחרונה</th><th>סטטוס</th><th /></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.display_name}</strong><div className="subtle ltr">{u.email}</div></td>
                  <td className="hide-sm ltr">{u.username}</td>
                  <td>
                    <div className="flex flex-wrap" style={{ gap: 4 }}>
                      <Badge tone={u.role === 'admin' ? 'danger' : u.role === 'shift_manager' ? 'warning' : 'neutral'}>{u.role_name}</Badge>
                      {u.custom_permissions > 0 && <Badge tone="primary">+ הרשאות אישיות</Badge>}
                      {u.role !== "admin" && u.scope_label && <Badge tone={u.scope_missing ? "warning" : "neutral"}>{u.scope_missing ? `⚠ ${u.scope_label}` : u.scope_label}</Badge>}
                      {u.totp_enabled ? <Badge tone="success">2FA</Badge> : null}
                    </div>
                  </td>
                  <td className="hide-sm">{u.employee_name || '—'}</td>
                  <td className="hide-sm subtle">{u.last_login_at ? dateTime(u.last_login_at) : 'אף פעם'}</td>
                  <td>{u.is_active ? <Badge tone="success" dot>פעיל</Badge> : <Badge dot>מושבת</Badge>}</td>
                  <td>
                    <div className="row-actions">
                      <IconButton icon={Pencil} label="עריכה" small onClick={() => setForm(u)} />
                      {u.role !== 'admin' && <IconButton icon={ShieldCheck} label="הרשאות אישיות" small onClick={() => setPermsFor(u)} />}
                      <IconButton icon={Lock} label="הגדרת סיסמה" small onClick={() => setPw(u)} />
                      {u.id !== me.id && <IconButton icon={Trash2} label="מחיקה" small onClick={() => remove(u)} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && <UserForm user={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => reload({ silent: true })} />}
      {permsFor && <UserPermissions user={permsFor} onClose={() => setPermsFor(null)} onSaved={() => reload({ silent: true })} />}
      {pw && (
        <Modal open onClose={() => setPw(null)} title={`סיסמה חדשה ל${pw.display_name}`} footer={<><Button onClick={() => setPw(null)}>ביטול</Button><Button variant="primary" onClick={setPassword}>עדכון</Button></>}>
          <Field label="סיסמה חדשה" error={pwErr} hint="הסיסמה מוצגת לכם כדי שתוכלו למסור אותה לעובד. המשתמש ינותק מכל המכשירים."><Input value={newPw} onChange={(e) => setNewPw(e.target.value)} dir="ltr" autoComplete="off" /></Field>
          <div className="mt"><Button size="sm" icon={RotateCcw} onClick={() => setNewPw(randomPassword())}>יצירת סיסמה אקראית</Button></div>
        </Modal>
      )}
      {confirmDialog}
    </Card>
  );
}

// ---------------- permissions matrix ----------------
/** Create or edit a role: name, description and its permissions. */
function RoleEditor({ role, catalog, roles, onClose, onSaved }) {
  const toast = useToast();
  const isNew = !role;
  const locked = role?.locked;
  const [v, setV] = useState({ name: role?.name || '', description: role?.description || '', permissions: role?.permissions || [], scope: role?.scope || 'branch' });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const toggle = (p) => setV((x) => ({ ...x, permissions: x.permissions.includes(p) ? x.permissions.filter((k) => k !== p) : [...x.permissions, p] }));
  const copyFrom = (key) => { const r = roles.find((x) => x.key === key); if (r) setV((x) => ({ ...x, permissions: [...r.permissions] })); };
  const save = async () => {
    setSaving(true);
    try {
      const body = { name: v.name, description: v.description, ...(locked ? {} : { permissions: v.permissions, scope: v.scope }) };
      const r = isNew ? await api.post('/roles', body) : await api.put(`/roles/${role.key}`, body);
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields || {}); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} wide title={isNew ? 'תפקיד חדש' : `עריכת תפקיד · ${role.name}`}
      footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" icon={Save} loading={saving} onClick={save} disabled={!v.name.trim()}>שמירה</Button></>}>
      <div className="grid">
        <div className="form-grid">
          <Field label="שם התפקיד *" error={errors.name}><Input value={v.name} maxLength={40} onChange={(e) => setV((x) => ({ ...x, name: e.target.value }))} placeholder="לדוגמה: קופאי, טבח, מנהל אזור" /></Field>
          <Field label="תיאור (לא חובה)"><Input value={v.description || ''} maxLength={200} onChange={(e) => setV((x) => ({ ...x, description: e.target.value }))} /></Field>
        </div>
        {locked ? <p className="muted">למנהל הראשי תמיד יש את כל ההרשאות על כל הרשת. אפשר לשנות רק את השם.</p> : (
          <>
            <div>
              <strong>על מי ההרשאות חלות? (תחום אחריות)</strong>
              <div className="scope-options" role="radiogroup" style={{ marginTop: 8 }}>
                {SCOPES.map((sc) => (
                  <label key={sc.key} className={`scope-option ${v.scope === sc.key ? 'on' : ''}`}>
                    <input type="radio" name="scope" checked={v.scope === sc.key} onChange={() => setV((x) => ({ ...x, scope: sc.key }))} />
                    <span><strong>{sc.label}</strong><br /><span className="subtle">{sc.hint}</span></span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap between">
              <strong>הרשאות ({v.permissions.length})</strong>
              <Select value="" onChange={(e) => copyFrom(e.target.value)} style={{ width: 'auto' }} aria-label="העתקת הרשאות מתפקיד">
                <option value="">העתקת הרשאות מתפקיד…</option>
                {roles.filter((r) => r.key !== role?.key).map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
              </Select>
            </div>
            <div className="perm-list perm-grid">
              {catalog.map((p) => (
                <label key={p.key} className="checkbox perm-item">
                  <input type="checkbox" checked={v.permissions.includes(p.key)} onChange={() => toggle(p.key)} />
                  <span>{p.label}</span>
                </label>
              ))}
            </div>
            <p className="subtle" style={{ margin: 0 }}>פעולות אישיות (המשמרות שלי, החתמת שעון, הגשת בקשות) זמינות לכל משתמש שמשויך לכרטיס עובד, בלי קשר לתפקיד.</p>
          </>
        )}
      </div>
    </Modal>
  );
}

function DeleteRole({ role, roles, onClose, onDone }) {
  const toast = useToast();
  const [moveTo, setMoveTo] = useState('employee');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const r = await api.del(`/roles/${role.key}${role.users ? `?move_to=${moveTo}` : ''}`); toast.success(r.message); onDone(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={`מחיקת התפקיד "${role.name}"`}
      footer={<><Button onClick={onClose}>ביטול</Button><Button variant="danger" icon={Trash2} loading={busy} onClick={go}>מחיקה</Button></>}>
      {role.users ? (
        <Field label={`ל-${role.users} משתמשים יש את התפקיד הזה. לאיזה תפקיד להעביר אותם?`}>
          <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {roles.filter((r) => r.key !== role.key && r.key !== 'admin').map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </Select>
        </Field>
      ) : <p style={{ margin: 0 }}>אין משתמשים עם התפקיד הזה. אפשר למחוק אותו בבטחה.</p>}
    </Modal>
  );
}

function Permissions() {
  const { reloadMeta } = useAuth();
  const { data, loading, error, reload: reloadRoles } = useApi('/permissions');
  const reload = (o) => { reloadRoles(o); reloadMeta(); }; // the user form's role list comes from meta
  const [edit, setEdit] = useState(null); // role object, or {} for a new one
  const [del, setDel] = useState(null);
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading && !data) return <Card><SkeletonRows /></Card>;
  const canEdit = data.can_edit;
  return (
    <Card title="תפקידים והרשאות" icon={ShieldCheck} pad={false}
      actions={canEdit && <Button size="sm" variant="primary" icon={Plus} onClick={() => setEdit({})}>תפקיד חדש</Button>}>
      <div className="list">
        {data.roles.map((r) => (
          <div key={r.key} className="list-item role-row">
            <span className={`kpi-icon tone-${r.key === 'admin' ? 'danger' : r.key === 'shift_manager' ? 'warning' : r.custom ? 'primary' : 'neutral'}`}>{r.locked ? <Lock size={16} /> : <ShieldCheck size={16} />}</span>
            <div className="grow">
              <div style={{ fontWeight: 600 }}>{r.name}{r.custom && <>{" "}<Badge tone="primary">מותאם</Badge></>}</div>
              <div className="subtle">{r.locked ? 'כל ההרשאות' : `${r.permissions.length} הרשאות`} · {scopeLabel(r.scope)} · {r.users} משתמשים</div>
            </div>
            {canEdit && <IconButton icon={Pencil} label={`עריכת ${r.name}`} small onClick={() => setEdit(r)} />}
            {canEdit && r.deletable && <IconButton icon={Trash2} label={`מחיקת ${r.name}`} small onClick={() => setDel(r)} />}
          </div>
        ))}
      </div>
      <p className="subtle" style={{ padding: '12px 16px', margin: 0 }}>
        {canEdit ? 'לחצו על העיפרון כדי לשנות שם או הרשאות. ' : 'רק המנהל הראשי יכול לשנות תפקידים והרשאות. '}
        כדי לתת או להסיר הרשאה למשתמש אחד בלבד, היכנסו ללשונית "משתמשים" ולחצו על סמל המגן ליד המשתמש.
      </p>
      {edit && <RoleEditor role={edit.key ? edit : null} catalog={data.catalog} roles={data.roles} onClose={() => setEdit(null)} onSaved={() => reload({ silent: true })} />}
      {del && <DeleteRole role={del} roles={data.roles} onClose={() => setDel(null)} onDone={() => reload({ silent: true })} />}
    </Card>
  );
}

// ---------------- audit log ----------------
function Json({ value }) {
  if (!value) return <span className="subtle">—</span>;
  let obj;
  try { obj = JSON.parse(value); } catch { return <span>{value}</span>; }
  if (typeof obj !== 'object' || obj === null) return <span>{String(obj)}</span>;
  return (
    <div style={{ fontSize: '.82rem' }}>
      {Object.entries(obj).slice(0, 14).map(([k, v]) => (
        <div key={k}><span className="subtle">{k}:</span> <span className="ltr">{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—')}</span></div>
      ))}
    </div>
  );
}

/** Main admin: delete activity history (all of it, or only old entries), confirmed with the password. */
function PurgeAudit({ onClose, onDone }) {
  const toast = useToast();
  const [keep, setKeep] = useState('0');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post('/audit/purge', { keep_days: Number(keep), password }); toast.success(r.message); onDone(); onClose(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="מחיקת היסטוריית פעילות"
      footer={<><Button onClick={onClose}>ביטול</Button><Button variant="danger" icon={Trash2} loading={busy} disabled={!password} onClick={go}>מחיקה</Button></>}>
      <div className="grid">
        {err && <div className="alert tone-danger">{err}</div>}
        <Field label="מה למחוק?">
          <Select value={keep} onChange={(e) => setKeep(e.target.value)}>
            <option value="0">את כל ההיסטוריה</option>
            <option value="30">רק פעולות ישנות מ-30 יום</option>
            <option value="90">רק פעולות ישנות מ-3 חודשים</option>
            <option value="365">רק פעולות ישנות משנה</option>
          </Select>
        </Field>
        <div className="alert tone-warning"><AlertTriangle size={18} /><span>לא ניתן לשחזר את ההיסטוריה אחרי המחיקה. ביומן תישאר רשומה אחת שמציינת מי מחק ומתי. ליתר ביטחון אפשר להוריד קודם גיבוי (הגדרות ← גיבוי).</span></div>
        <Field label="הסיסמה שלך (לאישור)"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && password && go()} /></Field>
      </div>
    </Modal>
  );
}

function Audit() {
  const { user } = useAuth();
  const [purge, setPurge] = useState(false);
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const q = useDebounced(search);
  useEffect(() => setPage(1), [q, entity]);
  const { data, loading, error, reload } = useApi('/audit', { search: q, entity_type: entity, page });
  return (
    <Card title="יומן פעולות" icon={History} pad={false}
      actions={user.role === 'admin' && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setPurge(true)}>מחיקת היסטוריה</Button>}>
      {purge && <PurgeAudit onClose={() => setPurge(false)} onDone={() => reload()} />}
      <div className="toolbar" style={{ padding: '14px 16px 0' }}>
        <div className="input-icon"><Search size={17} /><Input placeholder="חיפוש בפעולות..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">כל הישויות</option>
          {[['shift', 'משמרות'], ['employee', 'עובדים'], ['request', 'בקשות'], ['task', 'משימות'], ['user', 'משתמשים'], ['settings', 'הגדרות'], ['role', 'הרשאות'], ['report', 'דוחות'], ['incident', 'אירועים']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <span className="subtle flex"><Lock size={14} />אי אפשר לערוך את היומן. רק מנהל ראשי יכול למחוק אותו</span>
      </div>
      {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows rows={8} /> : !data.logs.length ? <EmptyState icon={History} title="לא נמצאו פעולות" /> : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>מועד</th><th>משתמש</th><th>פעולה</th><th /></tr></thead>
              <tbody>
                {data.logs.map((l) => (
                  <Fragment key={l.id}>
                    <tr className="clickable" onClick={() => setOpen(open === l.id ? null : l.id)}>
                      <td className="nowrap subtle">{dateTime(l.created_at)}</td>
                      <td className="nowrap">{l.user_name}</td>
                      <td>{l.description}<div className="subtle ltr">{l.action}</div></td>
                      <td>{(l.old_value || l.new_value) && (open === l.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />)}</td>
                    </tr>
                    {open === l.id && (l.old_value || l.new_value) && (
                      <tr>
                        <td colSpan={4} style={{ background: 'var(--surface-2)' }}>
                          <div className="grid grid-2">
                            <div><strong>ערך קודם</strong><Json value={l.old_value} /></div>
                            <div><strong>ערך חדש</strong><Json value={l.new_value} /></div>
                          </div>
                          {l.ip && <div className="subtle mt">IP: <span className="ltr">{l.ip}</span></div>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>הקודם</Button>
            <span className="subtle">עמוד {data.page} מתוך {data.pages} · {data.total} פעולות</span>
            <Button size="sm" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>הבא</Button>
          </div>
        </>
      )}
    </Card>
  );
}

export default function SettingsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { value: 'profile', label: 'הפרופיל שלי', icon: KeyRound },
    { value: 'security', label: 'אבטחה', icon: Fingerprint },
    ...(can('settings.manage') ? [{ value: 'business', label: 'הגדרות עסק', icon: Building2 }, { value: 'structure', label: 'מבנה ארגוני', icon: Network }, { value: 'mail', label: 'מיילים', icon: Mail }] : []),
    ...(can('users.manage') ? [{ value: 'users', label: 'משתמשים', icon: UserCog }, { value: 'permissions', label: 'הרשאות', icon: ShieldCheck }, { value: 'backup', label: 'גיבוי', icon: CloudUpload }] : []),
    ...(can('audit.view') ? [{ value: 'audit', label: 'יומן פעולות', icon: History }] : []),
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab') : tabs[0].value;
  return (
    <>
      <PageHeader title="הגדרות" />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} />
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <SecuritySettings />}
      {tab === 'business' && <Business />}
      {tab === 'structure' && <div className="grid grid-3"><RefList kind="departments" /><RefList kind="positions" /><RefList kind="locations" /></div>}
      {tab === 'users' && <Users />}
      {tab === 'permissions' && <Permissions />}
      {tab === 'audit' && <Audit />}
      {tab === 'backup' && <BackupSettings />}
      {tab === 'mail' && <MailSettings />}
    </>
  );
}
