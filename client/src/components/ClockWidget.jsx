import { useEffect, useState } from 'react';
import { LogIn, LogOut, CalendarClock, MapPin, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Card, Skeleton, StatusBadge } from './ui.jsx';
import { ATTENDANCE_STATUS, duration, longDate, shiftRange, time } from '../lib/format.js';

/** Best-effort current position (never rejects; resolves null when unavailable or denied). */
function getPosition() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}

function useNow() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

const at = (s) => new Date(`${s}:00`);
const pad = (n) => String(n).padStart(2, '0');
const stopwatch = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;

/** "My shift" card: shift hours, and a big round clock-in / clock-out button. */
export default function ClockWidget({ data, onChange }) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  if (!data) return <Card><Skeleton h={220} /></Card>;
  const { active, next } = data;
  const onShift = active?.clock_in_at && !active?.clock_out_at;
  const done = active?.clock_out_at;

  const act = async (kind) => {
    setBusy(true);
    try {
      const geo = await getPosition();
      const r = await api.post(`/attendance/${kind}`, geo || {});
      toast.success(r.message);
      onChange?.();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const where = active && [active.position_name, active.location_name].filter(Boolean).join(' · ');
  let big; let sub; let progress = null; let title; let text;
  if (onShift) {
    const startMs = at(active.clock_in_at).getTime();
    const endMs = at(active.end_at).getTime();
    const plannedStart = at(active.start_at).getTime();
    big = stopwatch(Math.max(0, Math.floor((now - startMs) / 1000)));
    sub = <>נכנסת ב־<span className="ltr">{time(active.clock_in_at)}</span> · משמרת <span className="ltr">{shiftRange(active)}</span></>;
    progress = Math.min(100, Math.max(0, ((now - plannedStart) / (endMs - plannedStart)) * 100));
    const left = Math.round((endMs - now) / 60000);
    title = left > 0 ? `נשארו ${duration(left)}` : 'המשמרת הסתיימה – אל תשכח/י לצאת';
    text = 'בסיום לוחצים על "יציאה" כדי לרשום את שעת הסיום.';
  } else if (active) {
    big = shiftRange(active);
    sub = where || 'המשמרת שלך היום';
    title = done ? `המשמרת הסתיימה ב־${time(active.clock_out_at)}` : 'עוד לא נכנסת למשמרת';
    text = done ? 'תודה! השעות נרשמו.' : 'לוחצים על "כניסה" כשמגיעים לעבודה.';
  } else if (next) {
    big = shiftRange(next);
    sub = [longDate(next.start_at), next.position_name, next.location_name].filter(Boolean).join(' · ');
  } else {
    big = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    sub = now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  return (
    <div className="card my-shift">
      <div className="my-shift-head">
        <span className="my-shift-label">המשמרת שלי</span>
        {active ? <StatusBadge map={ATTENDANCE_STATUS} value={active.attendance_status} /> : next && <span className="badge tone-primary">המשמרת הבאה</span>}
      </div>
      <div>
        <div className="my-shift-big">{big}</div>
        <div className="my-shift-sub">{sub}</div>
      </div>
      {progress !== null && <div className="my-shift-progress" role="progressbar" aria-label="התקדמות המשמרת" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>}
      <div className="my-shift-divider" />
      {active ? (
        <div className="my-shift-row">
          {done ? (
            <span className="clock-round done" aria-hidden="true"><CheckCircle2 size={34} /></span>
          ) : (
            <button type="button" className={`clock-round ${onShift ? 'out' : 'in'}`} disabled={busy} onClick={() => act(onShift ? 'clock-out' : 'clock-in')}>
              {busy ? <Loader2 size={28} className="spin" /> : onShift ? <LogOut size={28} /> : <LogIn size={28} />}
              <span>{onShift ? 'יציאה' : 'כניסה'}</span>
            </button>
          )}
          <div className="my-shift-text">
            <strong>{title}</strong>
            <span className="muted">{text}</span>
            {!onShift && !done && active.location_name && <span className="my-shift-ok"><MapPin size={15} />{active.location_name}</span>}
          </div>
        </div>
      ) : next ? (
        <div className="my-shift-row">
          <button type="button" className="clock-round in" disabled aria-describedby="clock-wait">
            <LogIn size={28} />
            <span>כניסה</span>
          </button>
          <div className="my-shift-text">
            <strong>עוד לא נכנסת למשמרת</strong>
            <span className="muted" id="clock-wait">הכניסה נפתחת שעה לפני תחילת המשמרת</span>
            {next.location_name && <span className="my-shift-ok"><MapPin size={15} />{next.location_name}</span>}
          </div>
        </div>
      ) : (
        <div className="my-shift-text">
          <strong>אין משמרת קרובה</strong>
          <span className="muted flex" style={{ gap: 6 }}><CalendarClock size={15} />כשתשובץ/י למשמרת היא תופיע כאן.</span>
        </div>
      )}
    </div>
  );
}
