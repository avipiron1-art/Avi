import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, Link } from 'react-router';
import {
  Users, CalendarDays, Clock, ListTodo, Inbox, BarChart3, Bell, Settings, Menu, Search, Moon, Sun,
  LogOut, KeyRound, ChevronDown, CalendarCheck, X, Receipt, Megaphone, AlertTriangle, Home, MoreHorizontal,
} from 'lucide-react';
import { useAuth } from '../lib/auth.jsx';
import { useTheme } from '../lib/theme.js';
import { api } from '../lib/api.js';
import { Avatar, IconButton } from './ui.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import NotificationBell from './NotificationBell.jsx';
import { InstallBanner, InstallButton } from './InstallApp.jsx';
import { BrandLogo } from '../lib/branding.jsx';
import AckGate from './AckGate.jsx';
import { HeaderSlot } from '../lib/headerSlot.js';

/** Navigation items; `perm` = any of these permissions, `employee` = needs an employee card. */
export const NAV = [
  { to: '/', label: 'דף הבית', icon: Home, end: true, mobile: true, short: 'ראשי' },
  { to: '/employees', label: 'עובדים', icon: Users, perm: ['employees.view'], mobile: true },
  { to: '/schedule', label: 'סידור עבודה', icon: CalendarCheck, mobile: true, short: 'סידור' },
  { to: '/shifts', label: 'משמרות', icon: CalendarDays, mobile: (can) => !can('employees.view') },
  { to: '/attendance', label: 'נוכחות', icon: Clock, mobile: true },
  { to: '/tasks', label: 'משימות', icon: ListTodo },
  { to: '/requests', label: 'בקשות', icon: Inbox, badge: 'requests' },
  { to: '/reports', label: 'דוחות', icon: BarChart3, perm: ['reports.view'] },
  { to: '/my-hours', label: 'תלוש שעות', icon: Receipt, show: (user, can) => !!user.employee_id || can('reports.view') },
  { to: '/announcements', label: 'לוח הודעות', icon: Megaphone, badge: 'announcements' },
  { to: '/notifications', label: 'התראות', icon: Bell, badge: 'notifications' },
  { to: '/settings', label: 'הגדרות', icon: Settings },
];

// Phone bottom bar order: home, schedule, attendance, then employees (managers) or shifts (employees)
const MOBILE_ORDER = ['/', '/schedule', '/attendance', '/employees', '/shifts'];

export default function Layout() {
  const { user, meta, logout, can } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [unread, setUnread] = useState(0);
  const [annUnread, setAnnUnread] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const userMenuRef = useRef(null);

  const items = NAV.filter((n) => (!n.perm || can(...n.perm)) && (!n.employee || user.employee_id) && (!n.show || n.show(user, can)));

  useEffect(() => { setMenuOpen(false); setUserMenu(false); }, [location.pathname]);

  // Poll unread notifications
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.get('/notifications/unread-count').then((r) => alive && setUnread(r.unread)).catch(() => {});
      api.get('/announcements/unread-count').then((r) => alive && setAnnUnread(r.unread)).catch(() => {});
    };
    load();
    const t = setInterval(load, 30000);
    window.addEventListener('notifications:changed', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('notifications:changed', load); };
  }, []);

  // Ctrl/Cmd + K opens global search
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!userMenu) return undefined;
    const close = (e) => { if (!userMenuRef.current?.contains(e.target)) setUserMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [userMenu]);

  const onLogout = async () => { await logout(); navigate('/login'); };

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`} aria-label="תפריט ראשי">
        <div className="sidebar-brand">
          <BrandLogo fallback={CalendarDays} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="brand-name">Shiftly</div>
            <div className="brand-sub" title={meta?.settings?.business_name}>{meta?.settings?.business_name || 'ניהול כוח אדם'}</div>
          </div>
          {menuOpen && <IconButton icon={X} label="סגירת תפריט" onClick={() => setMenuOpen(false)} small />}
        </div>
        <nav className="nav">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <n.icon size={19} />
              <span>{n.label}</span>
              {n.badge === 'notifications' && unread > 0 && <span className="badge tone-danger nav-badge">{unread}</span>}
              {n.badge === 'announcements' && annUnread > 0 && <span className="badge tone-danger nav-badge">{annUnread}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-quick">
            <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); setSearchOpen(true); }}><Search size={17} />חיפוש</button>
            <button type="button" className="menu-item" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}{theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}</button>
            <Link className="menu-item" to="/settings?tab=profile"><KeyRound size={17} />הפרופיל שלי</Link>
          </div>
          <div className="sidebar-install"><InstallButton block variant="ghost" /></div>
          <div className="person" style={{ padding: 6 }}>
            <Avatar name={user.display_name} size={34} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="person-name">{user.display_name}</div>
              <div className="person-sub" title={user.scope?.label}>{user.role_name}{user.scope && !user.scope.all && user.scope.type !== 'self' ? ` · ${user.scope.label}` : ''}</div>
            </div>
            <IconButton icon={LogOut} label="התנתקות" onClick={onLogout} small />
          </div>
        </div>
      </aside>
      {menuOpen && <div className="backdrop" onClick={() => setMenuOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <IconButton icon={Menu} label="פתיחת תפריט" className="menu-btn" onClick={() => setMenuOpen(true)} />
          <button type="button" className="search-trigger" onClick={() => setSearchOpen(true)} aria-label="חיפוש">
            <Search size={17} />
            <span>חיפוש עובדים, משמרות, משימות...</span>
            <kbd>Ctrl K</kbd>
          </button>
          <div className="topbar-actions">
            <IconButton icon={Search} label="חיפוש" className="search-icon-btn" onClick={() => setSearchOpen(true)} />
            <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'} onClick={toggleTheme} />
            <NotificationBell unread={unread} setUnread={setUnread} />
            <div style={{ position: 'relative' }} ref={userMenuRef}>
              <button type="button" className="btn btn-ghost" style={{ paddingInline: 6 }} onClick={() => setUserMenu((v) => !v)} aria-haspopup="menu" aria-expanded={userMenu}>
                <Avatar name={user.display_name} size={30} />
                <span className="hide-sm">{user.display_name.split(' ')[0]}</span>
                <ChevronDown size={15} className="hide-sm" />
              </button>
              {userMenu && (
                <div className="popover" role="menu">
                  <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ fontWeight: 700 }}>{user.display_name}</div>
                    <div className="subtle">{user.email} · {user.role_name}</div>
                  </div>
                  {user.employee_id && <Link className="menu-item" to={`/employees/${user.employee_id}`}><Users size={16} />הכרטיס שלי</Link>}
                  <Link className="menu-item" to="/settings?tab=profile"><KeyRound size={16} />שינוי סיסמה</Link>
                  <button type="button" className="menu-item" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}{theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}</button>
                  <button type="button" className="menu-item" style={{ color: 'var(--danger)' }} onClick={onLogout}><LogOut size={16} />התנתקות</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="content">
          <InstallBanner />
          {user.scope?.missing && (
            <div className="alert tone-warning mb" role="alert">
              <AlertTriangle size={18} />
              <span>{user.scope.missing === 'department' ? 'לא הוגדרה לך מחלקה' : 'לא הוגדר לך סניף'}, ולכן אינך רואה עובדים ולא יכול/ה לבנות סידור. פנו למנהל הראשי כדי שיגדיר את זה בהגדרות ← משתמשים.</span>
            </div>
          )}
          <HeaderSlot.Provider value={<NotificationBell unread={unread} setUnread={setUnread} />}>
            <Outlet />
          </HeaderSlot.Provider>
          <AckGate />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="ניווט מהיר">
        {items.filter((n) => (typeof n.mobile === 'function' ? n.mobile(can) : n.mobile))
          .sort((a, b) => MOBILE_ORDER.indexOf(a.to) - MOBILE_ORDER.indexOf(b.to)).slice(0, 4).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <n.icon size={21} />
            <span>{n.short || n.label}</span>
          </NavLink>
        ))}
        <a href="#menu" onClick={(e) => { e.preventDefault(); setMenuOpen(true); }}>
          <MoreHorizontal size={21} />
          <span>עוד</span>
          {unread > 0 && <span className="dot-badge">{unread}</span>}
        </a>
      </nav>

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
