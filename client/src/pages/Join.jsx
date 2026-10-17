import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router';
import { UserPlus, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { Button, Field, Input, Skeleton, useForm } from '../components/ui.jsx';
import { AuthShell } from './Login.jsx';

/** Public sign-up page opened from a manager's invite link. */
export default function Join() {
  const { token } = useParams();
  const { refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [info, setInfo] = useState(undefined);
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({ first_name: '', last_name: '', phone: '', email: '', username: '', password: '', confirm: '' });
  useEffect(() => { api.get(`/join/${token}`).then(setInfo).catch(() => setInfo(null)); }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (v.password !== v.confirm) { setErrors({ confirm: 'הסיסמאות אינן תואמות' }); return; }
    setSaving(true);
    try {
      const { confirm, ...body } = v;
      const r = await api.post(`/join/${token}`, body);
      toast.success(r.message);
      await refresh();
      navigate('/', { replace: true });
    } catch (err) { setErrors(err.fields || {}); toast.error(err); } finally { setSaving(false); }
  };

  return (
    <AuthShell>
      {info === undefined ? <div className="auth-form"><Skeleton h={300} /></div> : info === null ? (
        <div className="auth-form">
          <div className="alert tone-danger"><AlertTriangle size={20} /><span>הקישור אינו תקף או שפג תוקפו. בקשו מהמנהל קישור חדש.</span></div>
          <Link to="/login">למסך הכניסה</Link>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit} noValidate>
          {info.logo && <img src={info.logo} alt="" className="join-logo" />}
          <div>
            <h1>הצטרפות ל{info.business_name}</h1>
            <p className="muted" style={{ marginTop: 6 }}>מלאו את הפרטים ובחרו סיסמה. {[info.position_name, info.department_name, info.location_name].filter(Boolean).join(' · ')}</p>
          </div>
          <div className="form-grid">
            <Field label="שם פרטי *" error={errors.first_name}><Input value={v.first_name} onChange={set('first_name')} invalid={errors.first_name} autoComplete="given-name" /></Field>
            <Field label="שם משפחה *" error={errors.last_name}><Input value={v.last_name} onChange={set('last_name')} invalid={errors.last_name} autoComplete="family-name" /></Field>
            <Field label="טלפון *" error={errors.phone}><Input type="tel" value={v.phone} onChange={set('phone')} invalid={errors.phone} dir="ltr" autoComplete="tel" /></Field>
            <Field label="אימייל *" error={errors.email}><Input type="email" value={v.email} onChange={set('email')} invalid={errors.email} dir="ltr" autoComplete="email" /></Field>
            <Field label="שם משתמש לכניסה *" error={errors.username} hint="באנגלית, לדוגמה: dana.cohen" className="full"><Input value={v.username} onChange={set('username')} invalid={errors.username} dir="ltr" autoComplete="username" /></Field>
            <Field label="סיסמה *" error={errors.password} hint="8 תווים לפחות, אות באנגלית וספרה"><Input type="password" value={v.password} onChange={set('password')} invalid={errors.password} dir="ltr" autoComplete="new-password" /></Field>
            <Field label="אימות סיסמה *" error={errors.confirm}><Input type="password" value={v.confirm} onChange={set('confirm')} invalid={errors.confirm} dir="ltr" autoComplete="new-password" /></Field>
          </div>
          <Button type="submit" variant="primary" size="lg" block loading={saving} icon={UserPlus}>יצירת החשבון</Button>
        </form>
      )}
    </AuthShell>
  );
}
