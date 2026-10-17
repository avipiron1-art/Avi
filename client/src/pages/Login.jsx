import { useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router';
import { CalendarDays, Clock, ShieldCheck, BarChart3, Eye, EyeOff, LogIn, Fingerprint } from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Button, Field, Input } from '../components/ui.jsx';
import { InstallButton } from '../components/InstallApp.jsx';
import { BrandLogo, useBranding } from '../lib/branding.jsx';
import { loginWithPasskey, usePasskeySupport } from '../lib/passkeys.js';

const DEMO = [
  { label: 'מנהל ראשי', id: 'admin', pw: 'Admin1234' },
  { label: 'מנהל משמרת', id: 'michal', pw: 'Manager1234' },
  { label: 'עובד', id: 'yossi', pw: 'Employee1234' },
];

export function AuthShell({ children }) {
  const { logo, business_name: name } = useBranding();
  return (
    <div className="auth-page">
      <div className="auth-form-wrap">{children}</div>
      <div className="auth-side">
        <div className="flex" style={{ gap: 12 }}>
          <BrandLogo fallback={CalendarDays} style={{ background: logo ? '#fff' : 'rgba(255,255,255,.18)', boxShadow: 'none' }} />
          <strong style={{ fontSize: '1.2rem' }}>{name || 'Shiftly'}</strong>
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

/** Logo + business name above the form (the side panel is hidden on phones). */
export function AuthBrand() {
  const { logo, business_name: name } = useBranding();
  if (!logo && !name) return null;
  return (
    <div className="auth-brand">
      <BrandLogo fallback={CalendarDays} />
      {name && <strong>{name}</strong>}
    </div>
  );
}

export default function Login() {
  const { login, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [demo, setDemo] = useState(false);
  const [mfa, setMfa] = useState(null); // { token, code } – second step
  const passkeys = usePasskeySupport();

  const done = async () => { await refresh(); navigate(location.state?.from || '/', { replace: true }); };
  const submitCode = async (e) => {
    e?.preventDefault();
    if (!mfa.code.trim()) { setError('יש להזין את הקוד'); return; }
    setLoading(true); setError('');
    try { await api.post('/auth/login/mfa', { mfa_token: mfa.token, code: mfa.code.trim() }); await done(); } catch (err) {
      setError(err.message);
      if (err.status === 401) setMfa(null);
    } finally { setLoading(false); }
  };
  const passkeyLogin = async () => {
    setLoading(true); setError('');
    try { await loginWithPasskey(remember); await done(); } catch (err) { if (err.message) setError(err.message); } finally { setLoading(false); }
  };
  useEffect(() => { api.get('/auth/options').then((o) => setDemo(o.demo)).catch(() => {}); }, []);

  const submit = async (e, creds) => {
    e?.preventDefault();
    const id = creds?.id ?? identifier;
    const pw = creds?.pw ?? password;
    if (!id || !pw) { setError('יש להזין שם משתמש וסיסמה'); return; }
    setLoading(true);
    setError('');
    try {
      const r = await login(id, pw, remember);
      if (r?.mfa_required) { setMfa({ token: r.mfa_token, code: '' }); return; }
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (mfa) {
    return (
      <AuthShell>
        <form className="auth-form" onSubmit={submitCode} noValidate>
          <AuthBrand />
          <div>
            <h1>אימות דו-שלבי 🔐</h1>
            <p className="muted" style={{ marginTop: 6 }}>פתחו את אפליקציית האימות בטלפון והזינו את הקוד בן 6 הספרות.</p>
          </div>
          {error && <div className="alert tone-danger" role="alert">{error}</div>}
          <Field label="קוד אימות" htmlFor="code" hint="אין גישה לטלפון? אפשר להזין אחד מקודי השחזור">
            <Input id="code" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={12} value={mfa.code}
              onChange={(e) => setMfa((m) => ({ ...m, code: e.target.value }))} dir="ltr" className="code-input" />
          </Field>
          <Button type="submit" variant="primary" size="lg" block loading={loading} icon={ShieldCheck}>אימות וכניסה</Button>
          <Button variant="ghost" block onClick={() => { setMfa(null); setError(''); }}>חזרה</Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form className="auth-form" onSubmit={submit} noValidate>
        <AuthBrand />
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
            <Input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" style={{ textAlign: 'right', paddingLeft: 46 }} />
            {/* the eye sits on the left; the LTR input reserves that side with physical padding-left */}
            <button type="button" className="icon-btn sm" style={{ position: 'absolute', left: 5, top: 5 }} onClick={() => setShow((v) => !v)} aria-label={show ? 'הסתרת סיסמה' : 'הצגת סיסמה'}>
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        <div className="flex between">
          <label className="checkbox"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />זכור אותי</label>
          <Link to="/forgot-password">שכחתי סיסמה</Link>
        </div>
        <Button type="submit" variant="primary" size="lg" block loading={loading} icon={LogIn}>התחברות</Button>
        {passkeys && <Button block size="lg" icon={Fingerprint} onClick={passkeyLogin} disabled={loading}>כניסה בטביעת אצבע / Face ID</Button>}

        <InstallButton block />

        {demo && (
        <div className="demo-box">
          <span className="subtle">כניסה מהירה למערכת הדמו:</span>
          <div className="btns">
            {DEMO.map((d) => (
              <Button key={d.id} size="sm" onClick={() => { setIdentifier(d.id); setPassword(d.pw); submit(null, d); }} disabled={loading}>{d.label}</Button>
            ))}
          </div>
        </div>
        )}
      </form>
    </AuthShell>
  );
}
