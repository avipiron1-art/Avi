import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Button, Modal } from './ui.jsx';
import { URGENCY, UrgencyBadge } from '../pages/Announcements.jsx';
import { timeAgo } from '../lib/format.js';

/**
 * Pops up announcements that must be confirmed, one at a time, until the employee presses
 * "read and confirmed". Re-checks when the app comes back to the foreground and every 2 minutes.
 */
export default function AckGate() {
  const toast = useToast();
  const location = useLocation();
  const [queue, setQueue] = useState([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.get('/announcements/pending').then((r) => setQueue(r.announcements)).catch(() => {}); }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 120000);
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('notifications:changed', load);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('notifications:changed', load); };
  }, [load]);
  useEffect(() => { load(); }, [location.pathname, load]);

  const a = queue[0];
  if (!a) return null;
  const ack = async () => {
    setBusy(true);
    try {
      await api.post(`/announcements/${a.id}/ack`);
      setQueue((q) => q.slice(1));
      window.dispatchEvent(new Event('notifications:changed'));
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return (
    <Modal open locked title="הודעה שדורשת אישור" className={`ack-modal urgency-${a.urgency}`}
      footer={<Button variant="primary" icon={CheckCircle2} loading={busy} onClick={ack} className="ack-btn">קראתי ואישרתי</Button>}>
      <div className="ack-head">
        <UrgencyBadge urgency={a.urgency} />
        {queue.length > 1 && <span className="subtle">עוד {queue.length - 1} הודעות ממתינות</span>}
      </div>
      <h3 className="ack-title">{a.title}</h3>
      {a.body && <div className="ann-body">{a.body}</div>}
      <div className="subtle" style={{ marginTop: 12 }}>{a.author_name || 'הנהלה'} · {timeAgo(a.created_at)}{URGENCY[a.urgency]?.hint ? ` · ${URGENCY[a.urgency].hint}` : ''}</div>
    </Modal>
  );
}
