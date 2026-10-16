import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router';
import { CalendarDays, Clock, ShieldCheck, BarChart3, Eye, EyeOff, LogIn } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { Button, Field, Input } from '../components/ui.jsx';

const DEMO = [
  { label: 'מנהל ראשי', id: 'admin', pw: 'Admin1234' },
  { label: 'מנהל משמרת', id: 'michal', pw: 'Manager1234' },
  { label: 'עובד', id: 'yossi', pw: 'Employee1234' },
];

export function AuthShell({ children }) {
  return (
    <div className="auth-page">
      <div className="auth-form-wrap">{children}</div>
      <div className="auth-side">
        <div className="flex" style={{ gap: 12 }}>
          <div className="brand-logo" style={{ background: 'rgba(255,255,255,.18)', boxShadow: 'none' }}><CalendarDays size={20} /></div>
          <strong style={{ fontSize: '1.2rem' }}>Shiftly</strong>
        </div>
        <div>
          <h2>כל כוח האדם שלך.<br />במקום אחד.</h2>
          <p style={{ opacity: 0.85, maxWidth: 420 }}>סידורי עבודה, נוכחות, משימות ובקשות עובדים – בממשק פשוט שעובד מצוין גם בטלפון.</p>
          <div className="auth-feature"><div><CalendarDays size={18} /></div>לוח משמרות עם גרירה וזיהוי התנגשויות</div>
          <div className="auth-feature"><div><Clock size={18} /></div>שעון נוכחות חכם עם איחורים ושעות נוספות</div>
          <div className="auth-feature"><div><BarChart3 size={18} /></div>דוחות שכר ונוכחות עם ייצוא ל-Excel</div>
          <div className="auth-feature"><div><ShieldCheck size={18} /></div>הרשאות לפי תפקיד ויומן פעולות מלא</div>
        </div>
        <span style={{ opacity: 0.6, fontSize: '.8rem' }}>© Shiftly</span>
      </div>
    </div>
  );
}

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e, creds) => {
    e?.preventDefault();
    const id = creds?.id ?? identifier;
    const pw = creds?.pw ?? password;
    if (!id || !pw) { setError('יש להזין שם משתמש וסיסמה'); return; }
    setLoading(true);
    setError('');
    try {
      await login(id, pw, remember);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <form className="auth-form" onSubmit={submit} noValidate>
        <div>
          <h1>ברוכים השבים 👋</h1>
          <p className="muted" style={{ marginTop: 6 }}>התחברו כדי לנהל את הצוות שלכם</p>
        </div>
        {error && <div className="alert tone-danger" role="alert">{error}</div>}
        <Field label="אימייל או שם משתמש" htmlFor="identifier">
          <Input id="identifier" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} dir="ltr" style={{ textAlign: 'right' }} />
        </Field>
        <Field label="סיסמה" htmlFor="password">
          <div style={{ position: 'relative' }}>
            <Input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" style={{ textAlign: 'right', paddingInlineStart: 42 }} />
            <button type="button" className="icon-btn sm" style={{ position: 'absolute', insetInlineStart: 5, top: 5 }} onClick={() => setShow((v) => !v)} aria-label={show ? 'הסתרת סיסמה' : 'הצגת סיסמה'}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        <div className="flex between">
          <label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />זכור אותי</label>
          <Link to="/forgot-password">שכחתי סיסמה</Link>
        </div>
        <Button type="submit" variant="primary" size="lg" block loading={loading} icon={LogIn}>התחברות</Button>

        <div className="demo-box">
          <span className="subtle">כניסה מהירה למערכת הדמו:</span>
          <div className="btns">
            {DEMO.map((d) => (
              <Button key={d.id} size="sm" onClick={() => { setIdentifier(d.id); setPassword(d.pw); submit(null, d); }} disabled={loading}>{d.label}</Button>
            ))}
          </div>
        </div>
      </form>
    </AuthShell>
  );
}
