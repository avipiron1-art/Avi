import { useEffect, useState } from 'react';
import { LogIn, LogOut, MapPin, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Card, Ring, Skeleton, StatusBadge } from './ui.jsx';
import { ATTENDANCE_STATUS, dayName, shortDate, time } from '../lib/format.js';

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
/** Minutes → "5:42" */
const hm = (min) => `${Math.floor(Math.max(0, min) / 60)}:${pad(Math.floor(Math.max(0, min) % 60))}`;
const mins = (a, b) => (b - a) / 60000;

/** "My shift" card: a ring that fills up during the shift, the shift times, and one big clock-in / clock-out button. */
export default function ClockWidget({ data, onChange }) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  if (!data) return <Card><Skeleton h={320} /></Card>;
  const { active, next } = data;
  const onShift = active?.clock_in_at && !active?.clock_out_at;
  const done = active?.clock_out_at;
  const shift = active || next;

  const act = async (kind) => {
    setBusy(true);
    try {
      const geo = await getPosition();
      const r = await api.post(`/attendance/${kind}`, geo || {});
      toast.success(r.message);
      onChange?.();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  // What the ring shows
  let ring = 0; let tone = 'primary'; let top; let big; let bottom; let title;
  if (onShift) {
    const start = at(active.start_at); const end = at(active.end_at);
    ring = mins(start, now) / mins(start, end);
    if (now > end) tone = 'danger';
    title = 'את/ה במשמרת';
    top = 'זמן במשמרת';
    big = hm(mins(at(active.clock_in_at), now));
    const left = mins(now, end);
    bottom = left > 0 ? `נשארו ${hm(left)}` : 'המשמרת הסתיימה';
  } else if (done) {
    ring = 1; tone = 'success';
    title = 'המשמרת הסתיימה';
    top = 'עבדת היום';
    big = hm(mins(at(active.clock_in_at), at(active.clock_out_at)));
    bottom = 'תודה!';
  } else if (shift) {
    const start = at(shift.start_at);
    const today = shift.start_at.slice(0, 10) === `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    title = active ? 'הגיע הזמן להיכנס' : 'המשמרת הבאה';
    top = today ? 'מתחילים בעוד' : `יום ${dayName(shift.start_at)}`;
    big = today ? hm(mins(now, start)) : shortDate(shift.start_at);
    bottom = <span className="ltr">{time(shift.start_at)}–{time(shift.end_at)}</span>;
  } else {
    title = 'אין משמרת קרובה';
    top = now.toLocaleDateString('he-IL', { weekday: 'long' });
    big = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    bottom = 'כשתשובץ/י היא תופיע כאן';
  }

  const stats = shift && [
    ['כניסה', active?.clock_in_at ? time(active.clock_in_at) : time(shift.start_at)],
    ['סיום', active?.clock_out_at ? time(active.clock_out_at) : time(shift.end_at)],
    ['סה״כ', hm(mins(at(shift.start_at), at(shift.end_at)))],
  ];

  return (
    <section className="card ring-card" aria-label="המשמרת שלי">
      <div className="ring-card-head">
        <div>
          <div className="ring-card-label">המשמרת שלי</div>
          <h2 className="ring-card-title">{title}</h2>
        </div>
        {active && <StatusBadge map={ATTENDANCE_STATUS} value={active.attendance_status} />}
      </div>
      <Ring value={ring} tone={tone} label={`${top} ${big}`.trim()}>
        <span className="ring-top">{top}</span>
        <span className="ring-big">{big}</span>
        <span className="ring-bottom">{bottom}</span>
      </Ring>
      {stats && (
        <div className="ring-stats">
          {stats.map(([k, v]) => <div key={k}><span>{k}</span><strong className="ltr">{v}</strong></div>)}
        </div>
      )}
      {shift?.location_name && <div className="ring-place"><MapPin size={15} />{[shift.position_name, shift.location_name].filter(Boolean).join(' · ')}</div>}
      {onShift ? (
        <button type="button" className="ring-action out" disabled={busy} onClick={() => act('clock-out')}>
          {busy ? <Loader2 size={20} className="spin" /> : <LogOut size={20} />}יציאה
        </button>
      ) : active && !done ? (
        <button type="button" className="ring-action in" disabled={busy} onClick={() => act('clock-in')}>
          {busy ? <Loader2 size={20} className="spin" /> : <LogIn size={20} />}כניסה למשמרת
        </button>
      ) : next && !active ? (
        <div className="ring-wait">
          <button type="button" className="ring-action in" disabled><LogIn size={20} />כניסה למשמרת</button>
          <span>הכניסה נפתחת שעה לפני תחילת המשמרת</span>
        </div>
      ) : null}
    </section>
  );
}
