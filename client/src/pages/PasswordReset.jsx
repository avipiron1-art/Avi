import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, MailCheck, KeyRound } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Button, Field, Input } from '../components/ui.jsx';
import { AuthShell } from './Login.jsx';

export function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!identifier.trim()) { setError('יש להזין אימייל או שם משתמש'); return; }
    setLoading(true); setError('');
    try { setDone(await api.post('/auth/forgot', { identifier })); } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  return (
    <AuthShell>
      <form className="auth-form" onSubmit={submit} noValidate>
        <Link to="/login" className="flex" style={{ gap: 4 }}><ArrowRight size={16} />חזרה להתחברות</Link>
        <div>
          <h1>איפוס סיסמה</h1>
          <p className="muted" style={{ marginTop: 6 }}>נשלח אליכם קישור לבחירת סיסמה חדשה</p>
        </div>
        {done ? (
          <div className="alert tone-success"><MailCheck size={20} /><div>
            {done.message}
            {done.demo_reset_path && (
              <div style={{ marginTop: 8 }}>
                <span className="subtle">מצב דמו (אין שרת דואר): </span>
                <Link to={done.demo_reset_path}>לחצו כאן לאיפוס</Link>
              </div>
            )}
          </div></div>
        ) : (
          <>
            {error && <div className="alert tone-danger" role="alert">{error}</div>}
            <Field label="אימייל או שם משתמש"><Input value={identifier} onChange={(e) => setIdentifier(e.target.value)} dir="ltr" style={{ textAlign: 'right' }} autoFocus /></Field>
            <Button type="submit" variant="primary" size="lg" block loading={loading}>שליחת קישור לאיפוס</Button>
          </>
        )}
      </form>
    </AuthShell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) { setError('הסיסמאות אינן תואמות'); return; }
    setLoading(true); setError('');
    try {
      await api.post('/auth/reset', { token, password });
      toast.success('הסיסמה עודכנה בהצלחה. אפשר להתחבר עם הסיסמה החדשה');
      navigate('/login');
    } catch (err) {
      setError(err.fields?.password || err.message);
    } finally { setLoading(false); }
  };

  return (
    <AuthShell>
      <form className="auth-form" onSubmit={submit} noValidate>
        <div>
          <h1>בחירת סיסמה חדשה</h1>
          <p className="muted" style={{ marginTop: 6 }}>לפחות 8 תווים, הכוללים אות באנגלית וספרה</p>
        </div>
        {!token && <div className="alert tone-danger">הקישור חסר או שגוי. <Link to="/forgot-password">בקשו קישור חדש</Link></div>}
        {error && <div className="alert tone-danger" role="alert">{error}</div>}
        <Field label="סיסמה חדשה"><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" /></Field>
        <Field label="אימות סיסמה"><Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} dir="ltr" /></Field>
        <Button type="submit" variant="primary" size="lg" block loading={loading} icon={KeyRound} disabled={!token}>עדכון סיסמה</Button>
      </form>
    </AuthShell>
  );
}
