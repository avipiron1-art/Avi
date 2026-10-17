import { useEffect, useState } from 'react';
import { CloudUpload, Download, Link2, Unlink, CheckCircle2, AlertTriangle, ExternalLink, Copy, HardDriveDownload } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api, download } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Badge, Button, Card, ErrorState, Field, Input, SkeletonRows, useConfirm } from './ui.jsx';
import { dateTime, timeAgo } from '../lib/format.js';

/** Step-by-step guide for creating the Google sign-in client (done once, in the owner's Google account). */
function DriveGuide() {
  return (
    <details className="guide" open>
      <summary>איך מקבלים Client ID ו-Client Secret? (פעם אחת, כ-5 דקות)</summary>
      <ol className="steps">
        <li>היכנסו ל-<a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noreferrer">Google Cloud <ExternalLink size={12} /></a> עם אותו חשבון Google שבו נמצא השרת, ולחצו <strong>Enable</strong> (הפעלת Google Drive API).</li>
        <li>עברו ל-<a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform <ExternalLink size={12} /></a> ולחצו <strong>Get started</strong>. שם האפליקציה: <code>Shiftly</code>, אימייל: שלכם. ב-Audience בחרו <strong>External</strong>, ואשרו עד הסוף (<strong>Create</strong>).</li>
        <li>בתפריט בצד לחצו <strong>Audience</strong> ואז <strong>Publish app</strong> ← <strong>Confirm</strong>. <span className="subtle">(חשוב! בלי זה החיבור מתנתק כל 7 ימים)</span></li>
        <li>בתפריט בצד לחצו <strong>Clients</strong> ← <strong>Create client</strong>. ב-Application type בחרו <strong>TVs and Limited Input devices</strong>, תנו שם כלשהו ולחצו <strong>Create</strong>.</li>
        <li>יופיעו <strong>Client ID</strong> ו-<strong>Client secret</strong> – העתיקו אותם לשדות כאן למטה ולחצו "שמירה".</li>
      </ol>
    </details>
  );
}

export default function BackupSettings() {
  const toast = useToast();
  const { data: st, loading, error, reload, setData } = useApi('/backup/status');
  const [cfg, setCfg] = useState({ client_id: '', client_secret: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => { if (st?.client_id) setCfg((c) => ({ ...c, client_id: c.client_id || st.client_id })); }, [st?.client_id]);
  // While waiting for the code to be approved, check every 3 seconds.
  useEffect(() => {
    if (!st?.pending) return undefined;
    const t = setInterval(() => reload({ silent: true }), 3000);
    return () => clearInterval(t);
  }, [st?.pending, reload]);

  const run = async (key, fn) => {
    setBusy(key);
    try { const r = await fn(); if (r && typeof r === 'object' && 'connected' in r) setData(r); if (r?.message) toast.success(r.message); else reload({ silent: true }); } catch (e) { setErrors(e.fields || {}); toast.error(e); } finally { setBusy(null); }
  };
  if (error) return <Card><ErrorState error={error} onRetry={reload} /></Card>;
  if (loading && !st) return <Card><SkeletonRows rows={5} /></Card>;

  const copyCode = async () => { try { await navigator.clipboard.writeText(st.pending.user_code); toast.success('הקוד הועתק'); } catch { /* ignore */ } };

  return (
    <div className="grid grid-2">
      <Card title="גיבוי אוטומטי ל-Google Drive" icon={CloudUpload}>
        {st.connected ? (
          <div className="grid">
            <div className="flex flex-wrap"><Badge tone="success" dot>מחובר</Badge><span className="subtle">גיבוי אוטומטי כל לילה אחרי 03:00 · נשמרים {st.keep} הגיבויים האחרונים בתיקייה "Shiftly Backups"</span></div>
            {st.last_backup && <div className="flex"><CheckCircle2 size={16} className="text-success" />גיבוי אחרון: {dateTime(st.last_backup)} ({timeAgo(st.last_backup)})</div>}
            {st.last_error && <div className="alert tone-danger"><AlertTriangle size={18} /><span>הגיבוי האחרון נכשל: {st.last_error.replace(/^\S+\s/, '')}</span></div>}
            <div className="flex flex-wrap">
              <Button variant="primary" icon={CloudUpload} loading={busy === 'run'} onClick={() => run('run', () => api.post('/backup/run'))}>גיבוי עכשיו</Button>
              <Button variant="ghost" icon={Unlink} onClick={() => confirm({
                title: 'לנתק את הגיבוי ל-Google Drive?', message: 'הגיבויים הקיימים יישארו ב-Drive, אבל גיבויים חדשים לא יישמרו.', confirmText: 'ניתוק',
                onConfirm: () => run('dis', () => api.post('/backup/drive/disconnect')),
              })}>ניתוק</Button>
            </div>
          </div>
        ) : st.pending ? (
          <div className="grid device-code">
            <p style={{ margin: 0 }}>כמעט סיימנו! בטלפון או במחשב:</p>
            <ol className="steps">
              <li>פתחו את <a href={st.pending.verification_url} target="_blank" rel="noreferrer" className="ltr">{st.pending.verification_url.replace(/^https?:\/\//, '')}</a></li>
              <li>הקלידו את הקוד:</li>
            </ol>
            <button type="button" className="device-code-box ltr" onClick={copyCode} title="העתקה">{st.pending.user_code} <Copy size={16} /></button>
            <ol className="steps" start={3}><li>בחרו את חשבון ה-Google שלכם ואשרו גישה. המסך כאן יתעדכן לבד.</li></ol>
            {st.pending.error ? <div className="alert tone-danger">{st.pending.error}</div> : <div className="subtle flex"><span className="pulse" /> ממתין לאישור…</div>}
          </div>
        ) : (
          <div className="grid">
            <p style={{ margin: 0 }}>כל לילה נשמר עותק של כל הנתונים ב-Google Drive שלכם. אם השרת יימחק או ייפגע – אפשר לשחזר.</p>
            <DriveGuide />
            <Field label="Client ID" error={errors.client_id}><Input className="ltr" value={cfg.client_id} onChange={(e) => setCfg((c) => ({ ...c, client_id: e.target.value }))} placeholder="xxxx.apps.googleusercontent.com" autoComplete="off" /></Field>
            <Field label="Client secret" error={errors.client_secret}><Input className="ltr" type="password" value={cfg.client_secret} onChange={(e) => setCfg((c) => ({ ...c, client_secret: e.target.value }))} placeholder={st.configured ? '•••••• (שמור)' : 'GOCSPX-…'} autoComplete="off" /></Field>
            <div className="flex flex-wrap">
              <Button icon={Link2} loading={busy === 'cfg'} disabled={!cfg.client_id || !cfg.client_secret} onClick={() => run('cfg', () => api.put('/backup/drive/config', cfg))}>שמירה</Button>
              <Button variant="primary" icon={CloudUpload} loading={busy === 'con'} disabled={!st.configured} onClick={() => run('con', async () => { await api.post('/backup/drive/connect'); reload({ silent: true }); })}>חיבור ל-Google Drive</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="הורדת גיבוי למכשיר" icon={HardDriveDownload}>
        <p style={{ marginTop: 0 }}>קובץ אחד שמכיל את כל נתוני המערכת (עובדים, משמרות, נוכחות, הגדרות). שמרו אותו במקום בטוח – הוא מכיל מידע אישי.</p>
        <Button icon={Download} loading={busy === 'dl'} onClick={() => run('dl', async () => { await download('/backup/download', {}, `shiftly-backup-${new Date().toISOString().slice(0, 10)}.db.gz`); return { message: 'הגיבוי הורד' }; })}>הורדת גיבוי עכשיו</Button>
      </Card>
      {confirmDialog}
    </div>
  );
}
