import { useEffect, useState } from 'react';
import { LogIn, LogOut, CalendarClock, MapPin } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Button, Card, Skeleton, StatusBadge } from './ui.jsx';
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

/** Big clock-in / clock-out card for the logged-in employee. */
export default function ClockWidget({ data, onChange }) {
  const toast = useToast();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  if (!data) return <Card><Skeleton h={220} /></Card>;
  const { active, next } = data;
  const onShift = active?.clock_in_at && !active?.clock_out_at;

  const act = async (kind) => {
    setBusy(true);
    try {
      const geo = await getPosition();
      const r = await api.post(`/attendance/${kind}`, geo || {});
      toast.success(r.message);
      onChange?.();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const elapsed = onShift ? Math.max(0, Math.round((now - new Date(`${active.clock_in_at}:00`)) / 60000)) : 0;

  return (
    <div className="card clock-card">
      <div className="subtle">{now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      <div className="clock-time">{now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
      {active ? (
        <>
          <div className="flex flex-wrap" style={{ justifyContent: 'center' }}>
            <StatusBadge map={ATTENDANCE_STATUS} value={active.attendance_status} />
            <span className="muted">משמרת <span className="ltr">{shiftRange(active)}</span></span>
            {active.location_name && <span className="muted flex" style={{ gap: 4 }}><MapPin size={14} />{active.location_name}</span>}
          </div>
          {onShift ? (
            <>
              <div className="flex" style={{ justifyContent: 'center' }}><span className="pulse" /> במשמרת מאז <strong className="ltr">{time(active.clock_in_at)}</strong> · {duration(elapsed)}</div>
              <Button variant="danger" className="clock-btn" icon={LogOut} loading={busy} onClick={() => act('clock-out')}>סיום משמרת</Button>
            </>
          ) : active.clock_out_at ? (
            <p className="muted">המשמרת הסתיימה ב-{time(active.clock_out_at)}. תודה!</p>
          ) : (
            <Button variant="success" className="clock-btn" icon={LogIn} loading={busy} onClick={() => act('clock-in')}>התחלת משמרת</Button>
          )}
        </>
      ) : (
        <>
          <p className="muted">אין משמרת פעילה כרגע</p>
          {next && (
            <div className="flex" style={{ justifyContent: 'center' }}>
              <CalendarClock size={16} className="muted" />
              <span>המשמרת הבאה: {longDate(next.start_at)} · <span className="ltr">{shiftRange(next)}</span></span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
