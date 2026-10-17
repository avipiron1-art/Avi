import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  KeyRound, Building2, Network, UserCog, ShieldCheck, History, Plus, Pencil, Trash2, Save, Search, Lock, ChevronDown, ChevronUp, Moon, Sun, RotateCcw,
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
      <div className="mt"><Button icon={theme === 'dark' ? Sun : Moon} onClick={toggle}>{theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה'}</Button></div>
    </Card>
  );
}

// ---------------- business settings ----------------
function Business() {
  const toast = useToast();
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
    try { const r = await api.put('/settings', v); toast.success(r.message); setErrors({}); reloadMeta(); } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
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
      </div>
    </Card>
  );
}

// ---------------- departments / positions / locations ----------------
const REF = {
  departments: { title: 'מחלקות', label: 'מחלקה', empty: { name: '', description: '', color: '#6366f1' } },
  positions: { title: 'תפקידים', label: 'תפקיד', empty: { name: '', department_id: '' } },
  locations: { title: 'סניפים ומיקומים', label: 'מיקום', empty: { name: '', address: '', is_active: true } },
};

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
                <div className="subtle">{kind === 'departments' ? `${it.employee_count} עובדים${it.description ? ` · ${it.description}` : ''}` : kind === 'positions' ? it.department_name || 'ללא מחלקה' : it.address}</div>
              </div>
              <IconButton icon={Pencil} label="עריכה" small onClick={() => setEdit({ ...it, is_active: kind === 'locations' ? !!it.is_active : undefined })} />
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
            {kind === 'positions' && <Field label="מחלקה"><Select value={edit.department_id ?? ''} onChange={(e) => setEdit((s) => ({ ...s, department_id: e.target.value }))}><option value="">ללא</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>}
            {kind === 'locations' && <>
              <Field label="כתובת"><Input value={edit.address || ''} onChange={(e) => setEdit((s) => ({ ...s, address: e.target.value }))} /></Field>
              <label className="checkbox"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit((s) => ({ ...s, is_active: e.target.checked }))} />פעיל</label>
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
    employee_id: u?.employee_id ?? '', is_active: u ? !!u.is_active : true, password: '',
  });
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
        <Field label="הרשאה *"><Select value={v.role} onChange={set('role')}>{meta.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select></Field>
        <Field label="כרטיס עובד משויך" error={errors.employee_id}><Select value={v.employee_id} onChange={set('employee_id')}><option value="">ללא</option>{meta.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
        {!u && <Field label="סיסמה ראשונית *" className="full" error={errors.password} hint="לפחות 8 תווים, כולל אות באנגלית וספרה"><Input type="text" value={v.password} onChange={set('password')} invalid={errors.password} dir="ltr" autoComplete="off" /></Field>}
        <label className="checkbox full"><input type="checkbox" checked={v.is_active} onChange={set('is_active')} />משתמש פעיל (רשאי להתחבר)</label>
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
          <Field label="סיסמה חדשה" error={pwErr} hint="המשתמש ינותק מכל המכשירים"><Input value={newPw} onChange={(e) => setNewPw(e.target.value)} dir="ltr" autoComplete="off" /></Field>
        </Modal>
      )}
      {confirmDialog}
    </Card>
  );
}

// ---------------- permissions matrix ----------------
function Permissions() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi('/permissions');
  const [roles, setRoles] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setRoles(data.roles); }, [data]);
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading || !roles) return <Card><SkeletonRows /></Card>;
  const toggle = (roleKey, perm) => setRoles((rs) => rs.map((r) => (r.key !== roleKey || r.locked ? r : {
    ...r, permissions: r.permissions.includes(perm) ? r.permissions.filter((p) => p !== perm) : [...r.permissions, perm],
  })));
  const save = async () => {
    setSaving(true);
    try {
      for (const r of roles.filter((x) => !x.locked)) await api.put(`/permissions/${r.key}`, { permissions: r.permissions });
      toast.success('ההרשאות עודכנו בהצלחה');
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Card title="הרשאות לפי תפקיד" icon={ShieldCheck} pad={false} actions={<Button size="sm" variant="primary" icon={Save} onClick={save} loading={saving}>שמירה</Button>}>
      <div className="table-wrap">
        <table className="table perm-table">
          <thead><tr><th>הרשאה</th>{roles.map((r) => <th key={r.key}>{r.name}{r.locked && <Lock size={12} style={{ marginInlineStart: 4 }} />}</th>)}</tr></thead>
          <tbody>
            {data.catalog.map((p) => (
              <tr key={p.key}>
                <td>{p.label}<div className="subtle ltr" style={{ display: 'block', textAlign: 'right' }}>{p.key}</div></td>
                {roles.map((r) => (
                  <td key={r.key}>
                    <input type="checkbox" checked={r.locked || r.permissions.includes(p.key)} disabled={r.locked} onChange={() => toggle(r.key, p.key)}
                      aria-label={`${p.label} – ${r.name}`} style={{ width: 18, height: 18, accentColor: 'var(--primary)' }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="subtle" style={{ padding: '12px 16px' }}>למנהל הראשי תמיד יש גישה מלאה. כדי לתת או להסיר הרשאה למשתמש מסוים בלבד, היכנסו ללשונית "משתמשים" ולחצו על סמל המגן ליד המשתמש. פעולות אישיות (צפייה במשמרות שלי, החתמת שעון, הגשת בקשות) זמינות לכל משתמש המשויך לכרטיס עובד.</p>
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

function Audit() {
  const [search, setSearch] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const q = useDebounced(search);
  useEffect(() => setPage(1), [q, entity]);
  const { data, loading, error, reload } = useApi('/audit', { search: q, entity_type: entity, page });
  return (
    <Card title="יומן פעולות" icon={History} pad={false}>
      <div className="toolbar" style={{ padding: '14px 16px 0' }}>
        <div className="input-icon"><Search size={17} /><Input placeholder="חיפוש בפעולות..." value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <Select value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">כל הישויות</option>
          {[['shift', 'משמרות'], ['employee', 'עובדים'], ['request', 'בקשות'], ['task', 'משימות'], ['user', 'משתמשים'], ['settings', 'הגדרות'], ['role', 'הרשאות'], ['report', 'דוחות'], ['incident', 'אירועים']].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <span className="subtle flex"><Lock size={14} />היומן לקריאה בלבד ואינו ניתן לשינוי</span>
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
    ...(can('settings.manage') ? [{ value: 'business', label: 'הגדרות עסק', icon: Building2 }, { value: 'structure', label: 'מבנה ארגוני', icon: Network }] : []),
    ...(can('users.manage') ? [{ value: 'users', label: 'משתמשים', icon: UserCog }, { value: 'permissions', label: 'הרשאות', icon: ShieldCheck }] : []),
    ...(can('audit.view') ? [{ value: 'audit', label: 'יומן פעולות', icon: History }] : []),
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab') : tabs[0].value;
  return (
    <>
      <PageHeader title="הגדרות" />
      <Tabs tabs={tabs} value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} />
      {tab === 'profile' && <Profile />}
      {tab === 'business' && <Business />}
      {tab === 'structure' && <div className="grid grid-3"><RefList kind="departments" /><RefList kind="positions" /><RefList kind="locations" /></div>}
      {tab === 'users' && <Users />}
      {tab === 'permissions' && <Permissions />}
      {tab === 'audit' && <Audit />}
    </>
  );
}
