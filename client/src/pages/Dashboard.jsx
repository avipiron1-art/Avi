import { useState, useEffect } from 'react';
import { Link } from 'react-router';
import {
  Users, UserCheck, CalendarDays, Clock, Inbox, ListTodo, Activity, CalendarClock, BarChart3, LogIn, LogOut,
  CalendarPlus, CheckCircle2, XCircle, PencilLine, AlertTriangle, UserPlus, Coffee,
} from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import {
  Card, KpiCard, PageHeader, Person, StatusBadge, EmptyState, ErrorState, SkeletonPage, Badge,
} from '../components/ui.jsx';
import { HoursBar, HoursArea, StackedBar } from '../components/Charts.jsx';
import ClockWidget from '../components/ClockWidget.jsx';
import {
  ATTENDANCE_STATUS, PRIORITY, TASK_STATUS, dayName, longDate, monthShort, shortDate, shiftRange, time, timeAgo,
} from '../lib/format.js';

const ACTIVITY_ICON = {
  'attendance.clock_in': [LogIn, 'success'], 'attendance.clock_out': [LogOut, 'info'], 'attendance.update': [PencilLine, 'neutral'],
  'shift.create': [CalendarPlus, 'primary'], 'shift.update': [PencilLine, 'warning'], 'shift.cancel': [XCircle, 'danger'],
  'shift.duplicate': [CalendarPlus, 'primary'], 'shift.copy_week': [CalendarPlus, 'primary'], 'request.create': [Inbox, 'info'],
  'request.approved': [CheckCircle2, 'success'], 'request.rejected': [XCircle, 'danger'], 'task.create': [ListTodo, 'primary'],
  'task.status': [CheckCircle2, 'success'], 'employee.create': [UserPlus, 'primary'], 'incident.create': [AlertTriangle, 'danger'],
};

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
}

function ShiftRow({ s, showStatus = true, showDate }) {
  return (
    <div className="list-item">
      <div className="grow"><Person name={s.employee_name} avatar={s.employee_avatar} sub={[s.position_name, s.location_name].filter(Boolean).join(' · ')} /></div>
      <div className="text-end">
        {showDate && <div className="subtle">{dayName(s.start_at)} {shortDate(s.start_at)}</div>}
        <div className="ltr" style={{ fontWeight: 600 }}>{shiftRange(s)}</div>
        {showStatus && <StatusBadge map={ATTENDANCE_STATUS} value={s.attendance_status} />}
      </div>
    </div>
  );
}

function ManagerDashboard({ data }) {
  const { kpis, current, upcoming, activity, charts } = data;
  const { user } = useAuth();
  return (
    <>
      <PageHeader title={`${greeting()}, ${user.display_name.split(' ')[0]}`} subtitle={`${longDate(data.now)} · הנה מה שקורה היום בעסק`}
        actions={<Link to="/shifts" className="btn btn-primary"><CalendarPlus size={17} /><span className="btn-label">לוח משמרות</span></Link>} />
      <div className="kpis">
        <KpiCard label="עובדים פעילים" value={kpis.active_employees} icon={Users} tone="primary" />
        <KpiCard label="כרגע במשמרת" value={kpis.on_shift_now} icon={UserCheck} tone="success" hint={`מתוך ${kpis.scheduled_now} משובצים כעת`} />
        <KpiCard label="עובדים במשמרת היום" value={kpis.today_employees} icon={CalendarDays} tone="info" />
        <KpiCard label="שעות עבודה החודש" value={kpis.month_hours.toLocaleString('he-IL')} icon={Clock} tone="warning" />
        {kpis.pending_requests !== null && <KpiCard label="בקשות ממתינות" value={kpis.pending_requests} icon={Inbox} tone="danger" to="/requests" />}
        <KpiCard label="משימות פתוחות" value={kpis.open_tasks} icon={ListTodo} tone="neutral" />
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <Card title="המשמרת הנוכחית" icon={UserCheck} pad={false} actions={<Link to="/attendance" className="btn btn-ghost btn-sm">לנוכחות</Link>} className="span-2">
          {current.length ? (
            <div className="table-wrap">
              <table className="table desktop-table">
                <thead><tr><th>עובד</th><th>תפקיד</th><th>התחלה</th><th>סיום</th><th>סטטוס נוכחות</th></tr></thead>
                <tbody>
                  {current.map((s) => (
                    <tr key={s.id}>
                      <td><Link to={`/employees/${s.employee_id}`} style={{ color: 'inherit', textDecoration: 'none' }}><Person name={s.employee_name} avatar={s.employee_avatar} sub={s.department_name} size={32} /></Link></td>
                      <td>{s.position_name || '—'}</td>
                      <td className="ltr">{time(s.start_at)}{s.clock_in_at && <div className="subtle">בפועל {time(s.clock_in_at)}</div>}</td>
                      <td className="ltr">{time(s.end_at)}</td>
                      <td><StatusBadge map={ATTENDANCE_STATUS} value={s.attendance_status} />{s.late_minutes > 0 && <div className="subtle">איחור {s.late_minutes} דק׳</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mobile-list">{current.map((s) => <ShiftRow key={s.id} s={s} />)}</div>
            </div>
          ) : <EmptyState icon={Coffee} title="אין משמרת פעילה כרגע" text="אף עובד לא משובץ לשעה זו." action={<Link to="/shifts" className="btn">לשיבוץ משמרות</Link>} />}
        </Card>
        <Card title="פעילות אחרונה" icon={Activity}>
          {activity.length ? activity.map((a) => {
            const [Icon, tone] = ACTIVITY_ICON[a.action] || [Activity, 'neutral'];
            return (
              <div key={a.id} className="activity">
                <span className={`activity-icon tone-${tone}`}><Icon size={16} /></span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: '.9rem' }}>{a.description}</div>
                  <div className="subtle">{timeAgo(a.created_at)}</div>
                </div>
              </div>
            );
          }) : <EmptyState icon={Activity} title="אין פעילות עדיין" />}
        </Card>
      </div>

      <Card title="המשמרות הקרובות" icon={CalendarClock} pad={false} className="mb" actions={<Link to="/shifts" className="btn btn-ghost btn-sm">לכל המשמרות</Link>}>
        {upcoming.length ? (
          <div className="table-wrap">
            <table className="table desktop-table">
              <thead><tr><th>תאריך</th><th>שעות</th><th>עובד</th><th>תפקיד</th><th>מיקום</th></tr></thead>
              <tbody>
                {upcoming.map((s) => (
                  <tr key={s.id}>
                    <td className="nowrap">{dayName(s.start_at)} {shortDate(s.start_at)}</td>
                    <td><span className="ltr">{shiftRange(s)}</span></td>
                    <td><Person name={s.employee_name} avatar={s.employee_avatar} size={30} /></td>
                    <td>{s.position_name || '—'}</td>
                    <td>{s.location_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mobile-list">{upcoming.map((s) => <ShiftRow key={s.id} s={s} showStatus={false} showDate />)}</div>
          </div>
        ) : <EmptyState icon={CalendarClock} title="אין משמרות קרובות" text="זה הזמן לבנות את סידור העבודה לשבוע הבא." action={<Link to="/shifts" className="btn btn-primary">יצירת משמרות</Link>} />}
      </Card>

      <div className="grid grid-2">
        <Card title="שעות עבודה לפי יום" icon={BarChart3}><HoursBar data={charts.hoursByDay} xKey="date" tickFormatter={shortDate} labelFormatter={(d) => `${dayName(d)} ${shortDate(d)}`} /></Card>
        <Card title="שעות עבודה לפי עובד (החודש)" icon={Users}><HoursBar data={charts.hoursByEmployee} xKey="name" horizontal /></Card>
        <Card title="כמות עובדים לפי משמרת (השבוע)" icon={CalendarDays}><StackedBar data={charts.employeesByShift} xKey="day" keys={['בוקר', 'צהריים/ערב', 'לילה']} /></Card>
        <Card title="השוואת שעות בין חודשים" icon={Clock}><HoursArea data={charts.monthComparison} xKey="month" tickFormatter={monthShort} labelFormatter={monthShort} /></Card>
      </div>
    </>
  );
}

function EmployeeDashboard({ data, reload }) {
  const { user } = useAuth();
  const [clock, setClock] = useState(null);
  const loadClock = () => api.get('/attendance/me').then(setClock).catch(() => {});
  useEffect(() => { loadClock(); }, []);
  const { kpis, upcoming, tasks, charts } = data;
  return (
    <>
      <PageHeader title={`${greeting()}, ${user.display_name.split(' ')[0]}`} subtitle={longDate(data.now)} />
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <ClockWidget data={clock} onChange={() => { loadClock(); reload({ silent: true }); }} />
        <div className="kpis" style={{ margin: 0, gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
          <KpiCard label="משמרות השבוע" value={kpis.week_shifts} icon={CalendarDays} tone="primary" />
          <KpiCard label="שעות החודש" value={kpis.month_hours} icon={Clock} tone="success" />
          <KpiCard label="משימות פתוחות" value={kpis.open_tasks} icon={ListTodo} tone="warning" />
          <KpiCard label="בקשות ממתינות" value={kpis.pending_requests} icon={Inbox} tone="info" />
        </div>
      </div>
      <div className="grid grid-2">
        <Card title="המשמרות הקרובות שלי" icon={CalendarClock} pad={false} actions={<Link to="/shifts" className="btn btn-ghost btn-sm">ללוח</Link>}>
          {upcoming.length ? (
            <div className="list">
              {upcoming.map((s) => (
                <div key={s.id} className="list-item">
                  <div className="kpi-icon tone-primary" style={{ flexDirection: 'column', width: 48, height: 48, lineHeight: 1.1 }}>
                    <small style={{ fontSize: '.68rem' }}>{dayName(s.start_at)}</small><strong>{s.start_at.slice(8, 10)}</strong>
                  </div>
                  <div className="grow">
                    <div className="ltr" style={{ fontWeight: 700 }}>{shiftRange(s)}</div>
                    <div className="subtle">{[s.position_name, s.location_name].filter(Boolean).join(' · ')}</div>
                  </div>
                  <StatusBadge map={ATTENDANCE_STATUS} value={s.attendance_status} />
                </div>
              ))}
            </div>
          ) : <EmptyState icon={CalendarClock} title="אין משמרות קרובות" text="כשתשובץ/י למשמרת היא תופיע כאן ותקבל/י התראה." />}
        </Card>
        <Card title="המשימות שלי" icon={ListTodo} pad={false} actions={<Link to="/tasks" className="btn btn-ghost btn-sm">לכל המשימות</Link>}>
          {tasks.length ? (
            <div className="list">
              {tasks.map((t) => (
                <div key={t.id} className="list-item">
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{t.title}</div>
                    <div className="subtle">{t.due_date ? `יעד: ${shortDate(t.due_date)}` : 'ללא תאריך יעד'}</div>
                  </div>
                  <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge>
                  <StatusBadge map={TASK_STATUS} value={t.status} />
                </div>
              ))}
            </div>
          ) : <EmptyState icon={CheckCircle2} title="אין משימות פתוחות" text="כל הכבוד! אין משימות שממתינות לך." />}
        </Card>
        <Card title="השעות שלי לפי חודש" icon={BarChart3}><HoursBar data={charts.monthComparison} xKey="month" tickFormatter={monthShort} labelFormatter={monthShort} /></Card>
        <Card title="פעולות מהירות" icon={Activity}>
          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Link to="/requests?new=vacation" className="btn btn-lg">בקשת חופשה</Link>
            <Link to="/requests?new=shift_swap" className="btn btn-lg">החלפת משמרת</Link>
            <Link to="/schedule?tab=submit" className="btn btn-lg">הגשת זמינות</Link>
            <Link to="/attendance" className="btn btn-lg">השעות שלי</Link>
          </div>
        </Card>
      </div>
    </>
  );
}

export default function Dashboard() {
  const { data, loading, error, reload } = useApi('/dashboard');
  if (loading && !data) return <SkeletonPage />;
  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (data.kind === 'manager') return <ManagerDashboard data={data} />;
  if (data.kind === 'employee') return <EmployeeDashboard data={data} reload={reload} />;
  return <div className="card"><EmptyState title="ברוכים הבאים" text="המשתמש שלך אינו משויך לכרטיס עובד. פנו למנהל המערכת." /></div>;
}
