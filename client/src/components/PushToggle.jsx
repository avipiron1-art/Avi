import { useState } from 'react';
import { BellRing, BellOff, Smartphone } from 'lucide-react';
import { usePush } from '../lib/push.js';
import { useToast } from '../lib/toast.jsx';
import { Button } from './ui.jsx';

/** Card content that turns phone push notifications on/off for this device. */
export default function PushToggle({ compact }) {
  const push = usePush();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (fn, msg) => {
    setBusy(true);
    try { await fn(); toast.success(msg); } catch (e) { toast.error(e.message || 'לא הצלחנו להפעיל התראות'); } finally { setBusy(false); }
  };
  if (push.status === 'loading') return null;
  const text = {
    on: 'התראות בטלפון פעילות במכשיר הזה.',
    off: 'קבלו התראה קופצת בטלפון על שיבוץ, אישור בקשה, הודעה דחופה ועוד, גם כשהאפליקציה סגורה.',
    denied: 'ההתראות נחסמו בדפדפן. כדי להפעיל: הגדרות הדפדפן ← הרשאות אתר ← התראות ← אפשר.',
    'ios-install': 'באייפון, התראות עובדות רק אחרי התקנת האפליקציה למסך הבית. התקינו ופתחו את Shiftly מהאייקון.',
    unsupported: 'הדפדפן הזה לא תומך בהתראות. נסו בכרום (אנדרואיד/מחשב) או באפליקציה המותקנת באייפון.',
  }[push.status];
  if (compact && push.status !== 'off') return null;
  return (
    <div className={`push-toggle ${compact ? 'compact' : ''}`}>
      <span className={`push-toggle-icon tone-${push.status === 'on' ? 'success' : 'primary'}`}>
        {push.status === 'on' ? <BellRing size={18} /> : push.status === 'ios-install' ? <Smartphone size={18} /> : <BellOff size={18} />}
      </span>
      <div className="push-toggle-text">
        <strong>התראות בטלפון</strong>
        <span>{text}</span>
      </div>
      {push.status === 'off' && <Button size="sm" variant="primary" icon={BellRing} loading={busy} onClick={() => run(push.enable, 'התראות בטלפון הופעלו')}>הפעלה</Button>}
      {push.status === 'on' && !compact && <Button size="sm" variant="ghost" loading={busy} onClick={() => run(push.disable, 'ההתראות כובו במכשיר הזה')}>כיבוי</Button>}
    </div>
  );
}
