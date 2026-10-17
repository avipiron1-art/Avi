import { useNavigate } from 'react-router';
import {
  Bell, CheckCheck, CalendarPlus, CalendarClock, CalendarX, CheckCircle2, XCircle, ListTodo, AlarmClock, Timer, Inbox, AlertTriangle, Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Button, Card, EmptyState, ErrorState, IconButton, PageHeader, SkeletonRows, Tabs } from '../components/ui.jsx';
import { dateTime, timeAgo } from '../lib/format.js';
import PushToggle from '../components/PushToggle.jsx';

const ICONS = {
  shift_assigned: [CalendarPlus, 'primary'], shift_changed: [CalendarClock, 'warning'], shift_cancelled: [CalendarX, 'danger'],
  request_approved: [CheckCircle2, 'success'], request_rejected: [XCircle, 'danger'], request_new: [Inbox, 'info'],
  task_assigned: [ListTodo, 'primary'], task_due: [AlarmClock, 'warning'], task_done: [CheckCircle2, 'success'],
  employee_late: [Timer, 'warning'], incident: [AlertTriangle, 'danger'], availability: [CalendarClock, 'info'],
};

export function NotificationIcon({ type }) {
  const [Icon, tone] = ICONS[type] || [Bell, 'neutral'];
  return <span className={`activity-icon tone-${tone}`}><Icon size={16} /></span>;
}

export default function Notifications() {
  const [filter, setFilter] = useState('');
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, reload, setData } = useApi('/notifications', { filter });
  const changed = () => window.dispatchEvent(new Event('notifications:changed'));

  const markRead = async (n) => {
    if (n.is_read) return;
    await api.patch(`/notifications/${n.id}/read`);
    setData((d) => ({ ...d, unread: d.unread - 1, notifications: d.notifications.map((x) => (x.id === n.id ? { ...x, is_read: 1 } : x)) }));
    changed();
  };
  const readAll = async () => { const r = await api.post('/notifications/read-all'); toast.success(r.message); reload({ silent: true }); changed(); };
  const remove = async (n) => { await api.del(`/notifications/${n.id}`); setData((d) => ({ ...d, notifications: d.notifications.filter((x) => x.id !== n.id) })); changed(); };

  return (
    <>
      <PageHeader title="מרכז התראות" subtitle={data ? `${data.unread} התראות שלא נקראו` : undefined}
        actions={data?.unread > 0 && <Button icon={CheckCheck} onClick={readAll}>סימון הכל כנקרא</Button>} />
      <div className="mb"><PushToggle /></div>
      <Tabs value={filter} onChange={setFilter} tabs={[{ value: '', label: 'הכל' }, { value: 'unread', label: 'לא נקראו', count: data?.unread }]} />
      <Card pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows rows={6} /> : !data.notifications.length ? (
          <EmptyState icon={Bell} title={filter ? 'קראת את כל ההתראות' : 'אין התראות'} text="כאן יופיעו עדכונים על משמרות, בקשות ומשימות." />
        ) : data.notifications.map((n) => (
          <div key={n.id} className={`notif ${n.is_read ? '' : 'unread'}`}>
            <NotificationIcon type={n.type} />
            <div style={{ flex: 1, minWidth: 0, cursor: n.link ? 'pointer' : 'default' }} onClick={async () => { await markRead(n); if (n.link) navigate(n.link); }}>
              <div style={{ fontWeight: n.is_read ? 500 : 700 }}>{n.title}</div>
              {n.body && <div className="muted" style={{ fontSize: '.9rem' }}>{n.body}</div>}
              <div className="subtle" title={dateTime(n.created_at)}>{timeAgo(n.created_at)}</div>
            </div>
            <div className="flex" style={{ gap: 2 }}>
              {!n.is_read && <IconButton icon={CheckCheck} label="סימון כנקרא" small onClick={() => markRead(n)} />}
              <IconButton icon={Trash2} label="מחיקה" small onClick={() => remove(n)} />
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}
