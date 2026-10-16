import { useState } from 'react';
import {
  ChevronLeft, ChevronRight, Pencil, AlertTriangle, Clock, Users, UserCheck, UserX, CheckCircle2, Timer, Plus, ShieldAlert,
} from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, IconButton, Input, KpiCard, Modal, PageHeader, Person, Select, SkeletonRows,
  StatusBadge, Tabs, Textarea, useForm,
} from '../components/ui.jsx';
import ClockWidget from '../components/ClockWidget.jsx';
import {
  ATTENDANCE_STATUS, SEVERITY, addDays, dayName, duration, hours, localToday, longDate, shiftRange, shortDate, time,
} from '../lib/format.js';

function EditAttendance({ row, onClose, onSaved }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({
    clock_in_at: row.clock_in_at || '', clock_out_at: row.clock_out_at || '', marked_absent: !!row.marked_absent, note: row.attendance_note || '',
  });
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.put(`/attendance/${row.id}`, v);
      toast.success(r.message);
      onSaved();
      onClose();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title="עדכון נוכחות" footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>שמירה</Button></>}>
      <Person name={row.employee_name} avatar={row.employee_avatar} sub={`${longDate(row.start_at)} · מתוכנן ${shiftRange(row)}`} size={44} />
      <div className="form-grid mt">
        <Field label="כניסה בפועל" error={errors.clock_in_at}><Input type="datetime-local" value={v.clock_in_at} onChange={set('clock_in_at')} disabled={v.marked_absent} /></Field>
        <Field label="יציאה בפועל" error={errors.clock_out_at}><Input type="datetime-local" value={v.clock_out_at} onChange={set('clock_out_at')} disabled={v.marked_absent} /></Field>
        <div className="full"><label className="checkbox"><input type="checkbox" checked={v.marked_absent} onChange={set('marked_absent')} />סימון כנעדר/ת</label></div>
        <Field label="הערה" className="full"><Textarea value={v.note} onChange={set('note')} maxLength={500} style={{ minHeight: 64 }} placeholder="לדוגמה: אישור מנהל לאיחור" /></Field>
      </div>
    </Modal>
  );
}

function IncidentForm({ onClose, onSaved }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({ title: '', description: '', severity: 'medium' });
  const save = async () => {
    setSaving(true);
    try { const r = await api.post('/attendance/incidents', v); toast.success(r.message); onSaved(); onClose(); } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title="דיווח על אירוע" footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>שליחת דיווח</Button></>}>
      <div className="form-grid">
        <Field label="כותרת *" className="full" error={errors.title}><Input value={v.title} onChange={set('title')} invalid={errors.title} placeholder="לדוגמה: תקלה במקרר" /></Field>
        <Field label="חומרה"><Select value={v.severity} onChange={set('severity')}>{Object.entries(SEVERITY).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></Field>
        <Field label="תיאור" className="full"><Textarea value={v.description} onChange={set('description')} maxLength={2000} /></Field>
      </div>
    </Modal>
  );
}

function Board() {
  const { meta } = useAuth();
  const [date, setDate] = useState(localToday());
  const [dep, setDep] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const { data, loading, error, reload } = useApi('/attendance', { date, department_id: dep });
  const rows = (data?.rows || []).filter((r) => !statusFilter || (statusFilter === 'late' ? r.is_late : r.attendance_status === statusFilter));
  const s = data?.summary;

  return (
    <>
      <div className="toolbar">
        <div className="flex">
          <IconButton icon={ChevronRight} label="יום קודם" onClick={() => setDate((d) => addDays(d, -1))} />
          <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 170 }} aria-label="תאריך" />
          <IconButton icon={ChevronLeft} label="יום הבא" onClick={() => setDate((d) => addDays(d, 1))} />
          {date !== localToday() && <Button size="sm" onClick={() => setDate(localToday())}>היום</Button>}
        </div>
        <Select value={dep} onChange={(e) => setDep(e.target.value)} aria-label="מחלקה"><option value="">כל המחלקות</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
      </div>
      {s && (
        <div className="kpis">
          {[
            ['', 'משובצים', s.total, Users, 'primary'], ['on_shift', 'במשמרת', s.on_shift, UserCheck, 'success'], ['finished', 'סיימו', s.finished, CheckCircle2, 'info'],
            ['late', 'איחורים', s.late, Timer, 'warning'], ['absent', 'נעדרים', s.absent, UserX, 'danger'], ['not_started', 'טרם התחילו', s.not_started, Clock, 'neutral'],
          ].map(([key, label, value, Icon, tone]) => (
            <button key={label} type="button" className={`card kpi kpi-link ${statusFilter === key ? 'selected' : ''}`} style={{ textAlign: 'start', cursor: 'pointer', outline: statusFilter === key && key ? '2px solid var(--primary)' : undefined }} onClick={() => setStatusFilter((f) => (f === key ? '' : key))}>
              <div className="kpi-top"><span className="kpi-label">{label}</span><span className={`kpi-icon tone-${tone}`}><Icon size={18} /></span></div>
              <div className="kpi-value">{value}</div>
            </button>
          ))}
        </div>
      )}
      <Card title={`נוכחות · ${longDate(date)}`} icon={Clock} pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows rows={6} /> : !rows.length ? (
          <EmptyState icon={Clock} title={statusFilter ? 'אין עובדים בסטטוס זה' : 'אין משמרות ביום זה'} text={statusFilter ? 'לחצו שוב על הכרטיס כדי לבטל את הסינון.' : 'כאשר ישובצו משמרות, הנוכחות תופיע כאן.'} />
        ) : (
          <>
            <div className="table-wrap desktop-table">
              <table className="table">
                <thead><tr><th>עובד</th><th>מתוכנן</th><th>כניסה</th><th>יציאה</th><th>סה״כ</th><th>חריגות</th><th>סטטוס</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Person name={r.employee_name} avatar={r.employee_avatar} sub={r.position_name || r.department_name} size={32} /></td>
                      <td><span className="ltr">{shiftRange(r)}</span></td>
                      <td><span className="ltr">{time(r.clock_in_at)}</span></td>
                      <td><span className="ltr">{time(r.clock_out_at)}</span></td>
                      <td>{r.worked_minutes ? `${hours(r.worked_minutes)} ש׳` : '—'}</td>
                      <td>
                        <div className="flex flex-wrap" style={{ gap: 4 }}>
                          {r.late_minutes > 0 && <Badge tone="warning">איחור {r.late_minutes} דק׳</Badge>}
                          {r.early_leave_minutes > 0 && <Badge tone="warning">יציאה מוקדמת {r.early_leave_minutes} דק׳</Badge>}
                          {r.overtime_minutes > 0 && <Badge tone="info">+{duration(r.overtime_minutes)} נוספות</Badge>}
                          {r.attendance_note && <span className="subtle" title={r.attendance_note}>📝</span>}
                        </div>
                      </td>
                      <td><StatusBadge map={ATTENDANCE_STATUS} value={r.attendance_status} /></td>
                      <td><IconButton icon={Pencil} label="עדכון נוכחות" small onClick={() => setEditing(r)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-list">
              {rows.map((r) => (
                <div key={r.id} className="list-item" onClick={() => setEditing(r)} role="button" tabIndex={0}>
                  <div className="grow">
                    <Person name={r.employee_name} avatar={r.employee_avatar} sub={<span className="ltr">{shiftRange(r)}{r.clock_in_at ? ` · בפועל ${time(r.clock_in_at)}–${time(r.clock_out_at)}` : ''}</span>} />
                  </div>
                  <div className="text-end"><StatusBadge map={ATTENDANCE_STATUS} value={r.attendance_status} />{r.late_minutes > 0 && <div className="subtle">איחור {r.late_minutes}′</div>}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
      {editing && <EditAttendance row={editing} onClose={() => setEditing(null)} onSaved={() => reload({ silent: true })} />}
    </>
  );
}

function Incidents() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const { data, loading, reload } = useApi('/attendance/incidents/list');
  return (
    <Card title="אירועים שדווחו" icon={ShieldAlert} pad={false} actions={can('incidents.report') && <Button size="sm" variant="primary" icon={Plus} onClick={() => setOpen(true)}>דיווח אירוע</Button>}>
      {loading && !data ? <SkeletonRows rows={3} /> : !data?.incidents.length ? (
        <EmptyState icon={ShieldAlert} title="לא דווחו אירועים" text="דווחו כאן על תקלות, פציעות או אירועים חריגים במשמרת." />
      ) : (
        <div className="list">
          {data.incidents.map((i) => (
            <div key={i.id} className="list-item" style={{ alignItems: 'flex-start' }}>
              <span className={`activity-icon tone-${SEVERITY[i.severity].tone}`}><AlertTriangle size={16} /></span>
              <div className="grow">
                <div className="flex flex-wrap"><strong>{i.title}</strong><StatusBadge map={SEVERITY} value={i.severity} /></div>
                {i.description && <div className="muted" style={{ fontSize: '.9rem' }}>{i.description}</div>}
                <div className="subtle">{dayName(i.occurred_at)} {shortDate(i.occurred_at)} <span className="ltr">{time(i.occurred_at)}</span> · דווח ע״י {i.reported_by_name || '—'}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <IncidentForm onClose={() => setOpen(false)} onSaved={() => reload({ silent: true })} />}
    </Card>
  );
}

function MyAttendance() {
  const { data, loading, error, reload } = useApi('/attendance/me');
  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const st = data?.stats;
  return (
    <>
      <div className="grid grid-2 mb">
        <ClockWidget data={data} onChange={() => reload({ silent: true })} />
        <div className="kpis" style={{ margin: 0, gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
          <KpiCard label="שעות ב-30 יום" value={st ? hours(st.worked_minutes) : '…'} icon={Clock} tone="primary" />
          <KpiCard label="שעות נוספות" value={st ? hours(st.overtime_minutes) : '…'} icon={Timer} tone="info" />
          <KpiCard label="איחורים" value={st?.late_count ?? '…'} icon={AlertTriangle} tone="warning" />
          <KpiCard label="היעדרויות" value={st?.absent_count ?? '…'} icon={UserX} tone="danger" />
        </div>
      </div>
      <Card title="היסטוריית נוכחות (30 יום)" icon={Clock} pad={false}>
        {loading && !data ? <SkeletonRows /> : !data.history.length ? <EmptyState icon={Clock} title="אין עדיין רישומי נוכחות" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>תאריך</th><th>מתוכנן</th><th>בפועל</th><th>שעות</th><th className="hide-sm">חריגות</th><th>סטטוס</th></tr></thead>
              <tbody>
                {data.history.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{dayName(r.start_at)} {shortDate(r.start_at)}</td>
                    <td><span className="ltr">{shiftRange(r)}</span></td>
                    <td><span className="ltr">{r.clock_in_at ? `${time(r.clock_in_at)}–${time(r.clock_out_at)}` : '—'}</span></td>
                    <td>{hours(r.worked_minutes)}</td>
                    <td className="hide-sm">
                      {r.late_minutes > 0 && <Badge tone="warning">איחור {r.late_minutes}′</Badge>} {r.overtime_minutes > 0 && <Badge tone="info">+{duration(r.overtime_minutes)}</Badge>}
                    </td>
                    <td><StatusBadge map={ATTENDANCE_STATUS} value={r.attendance_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

export default function Attendance() {
  const { can, user } = useAuth();
  const isManager = can('attendance.manage');
  const showIncidents = can('incidents.report', 'attendance.manage');
  const tabs = [
    ...(isManager ? [{ value: 'board', label: 'לוח נוכחות' }] : []),
    ...(user.employee_id ? [{ value: 'mine', label: 'השעון שלי' }] : []),
    ...(showIncidents ? [{ value: 'incidents', label: 'אירועים' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.value);
  if (!tabs.length) return <div className="card"><EmptyState title="אין נתוני נוכחות להצגה" /></div>;
  return (
    <>
      <PageHeader title="נוכחות" subtitle={isManager ? 'מעקב כניסות, יציאות, איחורים ושעות נוספות' : 'החתמת שעון והשעות שלך'} />
      {tabs.length > 1 && <Tabs tabs={tabs} value={tab} onChange={setTab} />}
      {tab === 'board' && <Board />}
      {tab === 'mine' && <MyAttendance />}
      {tab === 'incidents' && <Incidents />}
    </>
  );
}
