import { useState } from 'react';
import { ShieldCheck, Fingerprint, Smartphone, Trash2, KeyRound, Copy, Download } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { registerPasskey, usePasskeySupport } from '../lib/passkeys.js';
import { Badge, Button, Card, ErrorState, Field, IconButton, Input, Modal, SkeletonRows, useConfirm } from './ui.jsx';
import { dateTime } from '../lib/format.js';

function RecoveryCodes({ codes, onClose }) {
  const toast = useToast();
  const text = codes.join('\n');
  const copy = async () => { try { await navigator.clipboard.writeText(text); toast.success('הקודים הועתקו'); } catch { toast.error('לא ניתן להעתיק'); } };
  const save = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`קודי שחזור – כל קוד עובד פעם אחת\n\n${text}\n`], { type: 'text/plain' }));
    a.download = 'recovery-codes.txt'; a.click();
  };
  return (
    <Modal open locked title="קודי שחזור – שמרו אותם עכשיו" footer={<Button variant="primary" onClick={onClose}>שמרתי, אפשר לסגור</Button>}>
      <p style={{ marginTop: 0 }}>אם הטלפון יאבד, אפשר להיכנס עם אחד הקודים האלה במקום הקוד מהאפליקציה. <strong>כל קוד עובד פעם אחת</strong>, והם לא יוצגו שוב.</p>
      <div className="recovery-codes ltr">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="flex flex-wrap" style={{ marginTop: 12 }}>
        <Button size="sm" icon={Copy} onClick={copy}>העתקה</Button>
        <Button size="sm" icon={Download} onClick={save}>הורדה כקובץ</Button>
      </div>
    </Modal>
  );
}

function TotpSetup({ onClose, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState('password');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const start = async () => {
    setBusy(true); setErr('');
    try { setSetup(await api.post('/auth/2fa/setup', { password })); setStep('scan'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const enable = async () => {
    setBusy(true); setErr('');
    try { const r = await api.post('/auth/2fa/enable', { code: code.trim() }); toast.success(r.message); onDone(r.recovery_codes); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="הפעלת אימות דו-שלבי"
      footer={step === 'password'
        ? <><Button onClick={onClose}>ביטול</Button><Button variant="primary" loading={busy} onClick={start} disabled={!password}>המשך</Button></>
        : <><Button onClick={onClose}>ביטול</Button><Button variant="primary" loading={busy} onClick={enable} disabled={code.trim().length < 6}>הפעלה</Button></>}>
      {err && <div className="alert tone-danger mb">{err}</div>}
      {step === 'password' ? (
        <Field label="הסיסמה הנוכחית שלך" hint="לאישור שזה אתם"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && password && start()} /></Field>
      ) : (
        <div className="grid totp-setup">
          <ol className="steps">
            <li>התקינו בטלפון אפליקציית אימות: <strong>Google Authenticator</strong> או <strong>Microsoft Authenticator</strong> (חינם).</li>
            <li>באפליקציה לחצו על <strong>+</strong> ואז <strong>סריקת קוד QR</strong>, וסרקו את הקוד:</li>
          </ol>
          <img src={setup.qr} alt="קוד QR לאפליקציית האימות" className="totp-qr" />
          <details className="subtle"><summary>אי אפשר לסרוק? (למשל כשאתם בטלפון עצמו)</summary>
            <p>באפליקציה בחרו "הזנת מפתח" והקלידו: <code className="ltr totp-secret">{setup.secret}</code></p>
            <a className="btn btn-sm" href={setup.otpauth_url}>פתיחה באפליקציית האימות</a>
          </details>
          <ol className="steps" start={3}><li>הזינו את הקוד בן 6 הספרות שמופיע באפליקציה:</li></ol>
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="code-input ltr" onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && enable()} />
        </div>
      )}
    </Modal>
  );
}

function PasswordPrompt({ title, confirmText, danger, onClose, onSubmit }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => { setBusy(true); setErr(''); try { await onSubmit(password); } catch (e) { setErr(e.message); setBusy(false); } };
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button onClick={onClose}>ביטול</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={go} disabled={!password}>{confirmText}</Button></>}>
      {err && <div className="alert tone-danger mb">{err}</div>}
      <Field label="הסיסמה הנוכחית שלך"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && password && go()} /></Field>
    </Modal>
  );
}

/** Personal security: two-step login (authenticator app) and fingerprint / Face ID sign-in. */
export default function SecuritySettings() {
  const toast = useToast();
  const { data, loading, error, reload } = useApi('/auth/security');
  const supported = usePasskeySupport();
  const [modal, setModal] = useState(null);
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading && !data) return <Card><SkeletonRows rows={4} /></Card>;

  const addPasskey = async () => {
    setBusy(true);
    try { const r = await registerPasskey(); toast.success(r.message); reload({ silent: true }); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  const removePasskey = (p) => confirm({
    title: `להסיר את "${p.name}"?`, message: 'לא יהיה אפשר להיכנס מהמכשיר הזה בטביעת אצבע עד שתפעילו שוב.', confirmText: 'הסרה',
    onConfirm: async () => { try { const r = await api.del(`/auth/passkeys/${p.id}`); toast.success(r.message); reload({ silent: true }); } catch (e) { toast.error(e); throw e; } },
  });

  return (
    <div className="grid grid-2">
      <Card title="אימות דו-שלבי" icon={ShieldCheck}>
        <p style={{ marginTop: 0 }}>בכל כניסה עם סיסמה תתבקשו גם קוד מתחלף מאפליקציה בטלפון. גם אם מישהו ידע את הסיסמה – הוא לא יוכל להיכנס.</p>
        {data.totp_enabled ? (
          <>
            <div className="flex flex-wrap mb"><Badge tone="success" dot>פעיל</Badge><span className="subtle">נותרו {data.recovery_left} קודי שחזור</span></div>
            <div className="flex flex-wrap">
              <Button icon={KeyRound} onClick={() => setModal('recovery')}>קודי שחזור חדשים</Button>
              <Button variant="danger" onClick={() => setModal('disable')}>כיבוי</Button>
            </div>
          </>
        ) : (
          <>
            <div className="mb"><Badge dot>כבוי</Badge></div>
            <Button variant="primary" icon={Smartphone} onClick={() => setModal('setup')}>הפעלת אימות דו-שלבי</Button>
          </>
        )}
      </Card>

      <Card title="כניסה בטביעת אצבע / Face ID" icon={Fingerprint}>
        <p style={{ marginTop: 0 }}>כניסה מהירה ובטוחה בלי להקליד סיסמה, עם החיישן של הטלפון. מפעילים פעם אחת בכל מכשיר.</p>
        {data.passkeys.length > 0 && (
          <div className="list mb">
            {data.passkeys.map((p) => (
              <div key={p.id} className="list-item">
                <Fingerprint size={18} className="muted" />
                <div className="grow"><div style={{ fontWeight: 600 }}>{p.name}</div><div className="subtle">נוסף {dateTime(p.created_at)}{p.last_used_at ? ` · שימוש אחרון ${dateTime(p.last_used_at)}` : ''}</div></div>
                <IconButton icon={Trash2} label="הסרה" small onClick={() => removePasskey(p)} />
              </div>
            ))}
          </div>
        )}
        {supported
          ? <Button variant="primary" icon={Fingerprint} loading={busy} onClick={addPasskey}>הפעלה במכשיר הזה</Button>
          : <div className="alert tone-info">כדי להפעיל, היכנסו מהטלפון (באפליקציה המותקנת או בדפדפן) – שם תופיע האפשרות.</div>}
      </Card>

      {modal === 'setup' && <TotpSetup onClose={() => setModal(null)} onDone={(c) => { setModal(null); setCodes(c); reload({ silent: true }); }} />}
      {modal === 'disable' && <PasswordPrompt title="כיבוי אימות דו-שלבי" confirmText="כיבוי" danger onClose={() => setModal(null)}
        onSubmit={async (password) => { const r = await api.post('/auth/2fa/disable', { password }); toast.success(r.message); setModal(null); reload({ silent: true }); }} />}
      {modal === 'recovery' && <PasswordPrompt title="יצירת קודי שחזור חדשים" confirmText="יצירה" onClose={() => setModal(null)}
        onSubmit={async (password) => { const r = await api.post('/auth/2fa/recovery', { password }); setModal(null); setCodes(r.recovery_codes); reload({ silent: true }); }} />}
      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
      {confirmDialog}
    </div>
  );
}
