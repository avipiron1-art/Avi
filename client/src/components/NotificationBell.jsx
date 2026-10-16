import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { timeAgo } from '../lib/format.js';
import { NotificationIcon } from '../pages/Notifications.jsx';

export default function NotificationBell({ unread, setUnread }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;
    api.get('/notifications').then((r) => { setItems(r.notifications.slice(0, 8)); setUnread(r.unread); }).catch(() => setItems([]));
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, setUnread]);

  const openItem = async (n) => {
    setOpen(false);
    if (!n.is_read) {
      await api.patch(`/notifications/${n.id}/read`).catch(() => {});
      window.dispatchEvent(new Event('notifications:changed'));
    }
    if (n.link) navigate(n.link);
  };

  const readAll = async () => {
    await api.post('/notifications/read-all');
    setItems((xs) => xs.map((x) => ({ ...x, is_read: 1 })));
    setUnread(0);
  };

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="icon-btn" aria-label={`התראות${unread ? ` (${unread} שלא נקראו)` : ''}`} onClick={() => setOpen((v) => !v)}>
        <Bell size={19} />
        {unread > 0 && <span className="dot-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover" style={{ width: 'min(380px, 92vw)', insetInlineEnd: -50 }}>
          <div className="flex between" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
            <strong>התראות</strong>
            {unread > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={readAll}><CheckCheck size={15} />סמן הכל כנקרא</button>}
          </div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {items === null && <div className="subtle" style={{ padding: 16 }}>טוען...</div>}
            {items?.length === 0 && <div className="empty"><p>אין התראות חדשות</p></div>}
            {items?.map((n) => (
              <button key={n.id} type="button" className={`menu-item notif ${n.is_read ? '' : 'unread'}`} onClick={() => openItem(n)} style={{ padding: '12px 14px' }}>
                <NotificationIcon type={n.type} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: n.is_read ? 500 : 700 }}>{n.title}</div>
                  {n.body && <div className="subtle" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.body}</div>}
                  <div className="subtle">{timeAgo(n.created_at)}</div>
                </div>
              </button>
            ))}
          </div>
          <Link to="/notifications" className="menu-item" style={{ justifyContent: 'center', borderTop: '1px solid var(--border)', fontWeight: 600 }} onClick={() => setOpen(false)}>
            לכל ההתראות
          </Link>
        </div>
      )}
    </div>
  );
}
