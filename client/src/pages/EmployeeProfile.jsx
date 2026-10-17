import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowRight, Pencil, Phone, Mail, CalendarDays, Clock, AlertTriangle, UserX, TrendingUp, ListTodo, Inbox, StickyNote, History, CalendarClock, Send,
} from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorState, SkeletonPage, StatusBadge, Tabs, Textarea,
} from '../components/ui.jsx';
import { HoursBar } from '../components/Charts.jsx';
import EmployeeForm from '../components/EmployeeForm.jsx';
import {
  ATTENDANCE_STATUS, EMPLOYEE_STATUS, PRIORITY, REQUEST_STATUS, REQUEST_TYPE, TASK_STATUS, dateTime, dayName, fullDate,
  hours, money, monthShort, shiftRange, shortDate, time, duration,
} from '../lib/format.js';

function ShiftTable({ rows, history }) {
  if (!rows.length) return <EmptyState icon={CalendarDays} title={history ? 'אין היסטוריית משמרות' : 'אין משמרות קרובות'} />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>תאריך</th><th>מתוכנן</th>{history && <th className="hide-sm">בפועל</th>}{history && <th>שעות</th>}<th>סטטוס</th></tr></thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="nowrap">{dayName(s.start_at)} {shortDate(s.start_at)}<div className="subtle">{s.location_name}</div></td>
              <td><span className="ltr">{shiftRange(s)}</span></td>
              {history && <td className="hide-sm"><span className="ltr">{s.clock_in_at ? `${time(s.clock_in_at)}–${time(s.clock_out_at)}` : '—'}</span></td>}
              {history && <td>{hours(s.worked_minutes)}{s.overtime_minutes > 0 && <div className="subtle">+{duration(s.overtime_minutes)} נוספות</div>}</td>}
              <td>
                <StatusBadge map={ATTENDANCE_STATUS} value={s.attendance_status} />
                {s.late_minutes > 0 && <div className="subtle">איחור {s.late_minutes} דק׳</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Availability({ employeeId }) {
  const { data } = useApi(`/requests/availability/${employeeId}`);
  if (!data) return null;
  return (
    <div className="list">
      {data.availability.map((d) => (
        <div key={d.weekday} className="list-item">
          <strong style={{ width: 60 }}>{d.name}</strong>
          <div className="grow">{d.available ? <span className="ltr">{d.from_time && d.to_time ? `${d.from_time}–${d.to_time}` : 'כל היום'}</span> : <span className="muted">לא זמין/ה</span>}</div>
          {!d.reported ? <Badge>לא דווח</Badge> : d.available ? <Badge tone="success">זמין/ה</Badge> : <Badge tone="danger">לא זמין/ה</Badge>}
        </div>
      ))}
    </div>
  );
}

export default function EmployeeProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, meta, user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState('upcoming');
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const { data, loading, error, reload, setData } = useApi(`/employees/${id}`);

  if (loading && !data) return <SkeletonPage />;
  if (error) return <div className="card"><ErrorState error={error} onRetry={error.status >= 500 || !error.status ? reload : undefined} /></div>;
  const { employee: e, stats, upcoming, history, hours_by_month: hbm, tasks, requests, notes, account } = data;
  const isSelf = user.employee_id === e.id;

  const addNote = async () => {
    if (!note.trim()) return;
    setSavingNote(true);
    try {
      const r = await api.post(`/employees/${e.id}/notes`, { content: note });
      setData((d) => ({ ...d, notes: [r.note, ...d.notes] }));
      setNote('');
      toast.success('ההערה נשמרה');
    } catch (err) { toast.error(err); } finally { setSavingNote(false); }
  };

  const tabs = [
    { value: 'upcoming', label: 'משמרות קרובות', icon: CalendarClock, count: upcoming.length },
    { value: 'history', label: 'היסטוריה', icon: History },
    { value: 'tasks', label: 'משימות', icon: ListTodo, count: tasks.filter((t) => ['new', 'in_progress'].includes(t.status)).length },
    { value: 'requests', label: 'בקשות', icon: Inbox, count: requests.length },
    ...(notes ? [{ value: 'notes', label: 'הערות מנהלים', icon: StickyNote, count: notes.length }] : []),
    ...(can('shifts.view_all') ? [{ value: 'availability', label: 'זמינות', icon: CalendarDays }] : []),
  ];

  return (
    <>
      {can('employees.view') && <Link to="/employees" className="flex mb" style={{ gap: 4, width: 'fit-content' }}><ArrowRight size={16} />חזרה לרשימת העובדים</Link>}
      <div className="card card-pad mb">
        <div className="profile-hero">
          <Avatar name={e.full_name} src={e.avatar} size={88} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="flex flex-wrap">
              <h1>{e.full_name}</h1>
              <StatusBadge map={EMPLOYEE_STATUS} value={e.status} />
              {account && <Badge tone="primary">{account.role_name}</Badge>}
            </div>
            <p className="muted" style={{ marginTop: 4 }}>{[e.position_name, e.department_name, e.location_name].filter(Boolean).join(' · ')}</p>
            <div className="flex flex-wrap mt" style={{ gap: 16 }}>
              {e.phone && <a href={`tel:${e.phone}`} className="flex" style={{ gap: 6 }}><Phone size={15} /><span className="ltr">{e.phone}</span></a>}
              {e.email && <a href={`mailto:${e.email}`} className="flex" style={{ gap: 6 }}><Mail size={15} /><span className="ltr">{e.email}</span></a>}
            </div>
          </div>
          {can('employees.manage') && <Button icon={Pencil} onClick={() => setEditing(true)}>עריכה</Button>}
        </div>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '20px 0' }} />
        <div className="info-list">
          <div><div className="k">מזהה עובד</div><div className="v ltr">{e.employee_code}</div></div>
          <div><div className="k">תחילת עבודה</div><div className="v">{fullDate(e.start_date)}</div></div>
          <div><div className="k">תפקיד</div><div className="v">{e.position_name || '—'}</div></div>
          <div><div className="k">מחלקה</div><div className="v">{e.department_name || '—'}</div></div>
          {'hourly_wage' in e && <div><div className="k">שכר שעתי</div><div className="v">{e.hourly_wage != null ? money(e.hourly_wage, meta.settings.currency) : '—'}</div></div>}
          {account && <div><div className="k">שם משתמש</div><div className="v ltr">{account.username}</div></div>}
          {account?.last_login_at && can('users.manage') && <div><div className="k">התחברות אחרונה</div><div className="v">{dateTime(account.last_login_at)}</div></div>}
        </div>
      </div>

      <div className="grid grid-2 mb">
        <Card title={isSelf ? 'הנתונים שלי החודש' : 'נתוני החודש'} icon={TrendingUp}>
          <div className="stat-row">
            <div className="stat-box"><div className="v">{hours(stats.month_minutes)}</div><div className="k"><Clock size={13} /> שעות עבודה</div></div>
            <div className="stat-box"><div className="v">{stats.month_shifts}</div><div className="k">משמרות</div></div>
            <div className="stat-box"><div className="v" style={{ color: stats.late_count ? 'var(--warning)' : undefined }}>{stats.late_count}</div><div className="k"><AlertTriangle size={13} /> איחורים</div></div>
            <div className="stat-box"><div className="v" style={{ color: stats.absence_count ? 'var(--danger)' : undefined }}>{stats.absence_count}</div><div className="k"><UserX size={13} /> היעדרויות</div></div>
            <div className="stat-box"><div className="v">{hours(stats.overtime_minutes)}</div><div className="k">שעות נוספות</div></div>
          </div>
        </Card>
        <Card title="שעות עבודה לפי חודשים" icon={Clock}><HoursBar data={hbm} xKey="month" tickFormatter={monthShort} labelFormatter={monthShort} height={200} /></Card>
      </div>

      <div className="card">
        <div style={{ padding: '0 12px' }}><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
        <div style={{ paddingBottom: 8 }}>
          {tab === 'upcoming' && <ShiftTable rows={upcoming} />}
          {tab === 'history' && <ShiftTable rows={history} history />}
          {tab === 'tasks' && (tasks.length ? (
            <div className="list">{tasks.map((t) => (
              <div key={t.id} className="list-item">
                <div className="grow"><div style={{ fontWeight: 600 }}>{t.title}</div><div className="subtle">{t.due_date ? `יעד ${fullDate(t.due_date)}` : 'ללא יעד'} · נוצרה ע״י {t.created_by_name || '—'}</div></div>
                <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge>
                <StatusBadge map={TASK_STATUS} value={t.status} />
              </div>
            ))}</div>
          ) : <EmptyState icon={ListTodo} title="אין משימות" />)}
          {tab === 'requests' && (requests.length ? (
            <div className="list">{requests.map((r) => (
              <div key={r.id} className="list-item">
                <div className="grow"><div style={{ fontWeight: 600 }}>{REQUEST_TYPE[r.type]} · {fullDate(r.start_date)}{r.end_date ? ` – ${fullDate(r.end_date)}` : ''}</div><div className="subtle">{r.details}</div>{r.manager_response && <div className="subtle">תגובה: {r.manager_response}</div>}</div>
                <StatusBadge map={REQUEST_STATUS} value={r.status} />
              </div>
            ))}</div>
          ) : <EmptyState icon={Inbox} title="לא הוגשו בקשות" />)}
          {tab === 'notes' && notes && (
            <div className="card-body">
              <div className="flex mb" style={{ alignItems: 'flex-end' }}>
                <Textarea placeholder="הוספת הערת מנהל (גלויה למנהלים בלבד)..." value={note} onChange={(ev) => setNote(ev.target.value)} style={{ minHeight: 60 }} maxLength={2000} />
                <Button variant="primary" icon={Send} onClick={addNote} loading={savingNote} disabled={!note.trim()}>שמירה</Button>
              </div>
              {notes.length ? notes.map((n) => (
                <div key={n.id} className="activity">
                  <Avatar name={n.author_name || '?'} size={32} />
                  <div><div style={{ whiteSpace: 'pre-wrap' }}>{n.content}</div><div className="subtle">{n.author_name} · {dateTime(n.created_at)}</div></div>
                </div>
              )) : <EmptyState icon={StickyNote} title="אין הערות עדיין" text="הערות מנהלים עוזרות לתעד שיחות, הערכות ואירועים." />}
            </div>
          )}
          {tab === 'availability' && <Availability employeeId={e.id} />}
        </div>
      </div>
      {editing && <EmployeeForm open onClose={() => setEditing(false)} employee={e} onSaved={() => reload({ silent: true })} onDeleted={() => navigate('/employees', { replace: true })} />}
    </>
  );
}
