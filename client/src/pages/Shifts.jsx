import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ChevronRight, ChevronLeft, Plus, CopyPlus, CalendarDays, CalendarRange, Calendar, MapPin, Clock, StickyNote,
} from 'lucide-react';
import { useApi, useMediaQuery } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Badge, Button, EmptyState, ErrorState, IconButton, Modal, PageHeader, Person, Segmented, Select, SkeletonRows, StatusBadge, useConfirm,
} from '../components/ui.jsx';
import ShiftForm, { useConflictSave } from '../components/ShiftForm.jsx';
import {
  ATTENDANCE_STATUS, DAYS_SHORT, MONTHS, addDays, addMonths, dayName, endOfMonth, localToday, longDate, shiftRange,
  shortDate, startOfMonth, startOfWeek, time,
} from '../lib/format.js';

function rangeFor(view, anchor) {
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'week') { const s = startOfWeek(anchor); return { from: s, to: addDays(s, 6) }; }
  const s = startOfWeek(startOfMonth(anchor));
  const e = addDays(startOfWeek(endOfMonth(anchor)), 6);
  return { from: s, to: e };
}

function titleFor(view, anchor) {
  if (view === 'day') return longDate(anchor);
  if (view === 'week') { const s = startOfWeek(anchor); const e = addDays(s, 6); return `${shortDate(s)} – ${shortDate(e)}`; }
  return `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
}

function ShiftChip({ s, canEdit, onOpen, onDragStart, onDragEnd, dragging }) {
  return (
    <div
      className={`shift-chip ${dragging ? 'dragging' : ''}`}
      style={{ '--chip': s.department_color || 'var(--primary)', cursor: canEdit ? 'grab' : 'pointer' }}
      draggable={canEdit}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(s.id)); e.dataTransfer.effectAllowed = 'copyMove'; onDragStart(s); }}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(s)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(s)}
      title={`${s.employee_name} ${shiftRange(s)}`}
    >
      <div className="t">{shiftRange(s)}</div>
      <div className="n">{s.employee_name}</div>
      <div className="p">{[s.position_name, s.location_name].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

function ShiftDetails({ shift, onClose }) {
  if (!shift) return null;
  return (
    <Modal open onClose={onClose} title="פרטי משמרת" footer={<Button onClick={onClose}>סגירה</Button>}>
      <Person name={shift.employee_name} avatar={shift.employee_avatar} sub={shift.department_name} size={48} />
      <div className="info-list mt">
        <div><div className="k">תאריך</div><div className="v">{longDate(shift.start_at)}</div></div>
        <div><div className="k">שעות</div><div className="v ltr">{shiftRange(shift)}</div></div>
        <div><div className="k">תפקיד</div><div className="v">{shift.position_name || '—'}</div></div>
        <div><div className="k">מיקום</div><div className="v">{shift.location_name || '—'}</div></div>
        <div><div className="k">נוכחות</div><div className="v"><StatusBadge map={ATTENDANCE_STATUS} value={shift.attendance_status} /></div></div>
        {shift.clock_in_at && <div><div className="k">כניסה / יציאה בפועל</div><div className="v ltr">{time(shift.clock_in_at)}–{time(shift.clock_out_at)}</div></div>}
      </div>
      {shift.note && <div className="alert tone-neutral mt"><StickyNote size={18} />{shift.note}</div>}
    </Modal>
  );
}

export default function Shifts() {
  const { can, meta, user } = useAuth();
  const toast = useToast();
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState(params.get('date') ? 'day' : isMobile ? 'day' : 'week');
  const [anchor, setAnchor] = useState(params.get('date') || localToday());
  const [filters, setFilters] = useState({ department_id: '', employee_id: '', location_id: '' });
  const [form, setForm] = useState(null);
  const [details, setDetails] = useState(null);
  const [dragged, setDragged] = useState(null);
  const [dropDay, setDropDay] = useState(null);
  const [run, conflictDialog] = useConflictSave();
  const [confirm, confirmDialog] = useConfirm();
  const canEdit = can('shifts.manage');
  const viewAll = can('shifts.view_all');
  const today = localToday();

  const { from, to } = rangeFor(view, anchor);
  const { data, loading, error, reload } = useApi('/shifts', { from, to, ...filters });
  const shifts = data?.shifts || [];

  // Open a specific shift when arriving from search (?shift=ID)
  useEffect(() => {
    const id = Number(params.get('shift'));
    if (!id || !data) return;
    const s = shifts.find((x) => x.id === id);
    if (s) { canEdit ? setForm(s) : setDetails(s); setParams({}, { replace: true }); }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of shifts) {
      const d = s.start_at.slice(0, 10);
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(s);
    }
    return m;
  }, [shifts]);

  const move = (step) => {
    if (view === 'day') setAnchor((a) => addDays(a, step));
    else if (view === 'week') setAnchor((a) => addDays(a, 7 * step));
    else setAnchor((a) => addMonths(a, step));
  };

  const openShift = (s) => (canEdit ? setForm(s) : setDetails(s));

  /** Drop handler: move shift to another day (hold Ctrl/Alt to duplicate instead). */
  const onDrop = async (e, date) => {
    e.preventDefault();
    setDropDay(null);
    const s = dragged;
    setDragged(null);
    if (!s || !canEdit) return;
    const copy = e.ctrlKey || e.altKey || e.metaKey;
    if (!copy && s.start_at.slice(0, 10) === date) return;
    try {
      await run(
        (force) => (copy
          ? api.post(`/shifts/${s.id}/duplicate`, { date, force })
          : api.put(`/shifts/${s.id}`, {
            employee_id: s.employee_id, date, start_time: time(s.start_at), end_time: time(s.end_at),
            position_id: s.position_id, location_id: s.location_id, note: s.note, force,
          })),
        (r) => { toast.success(copy ? 'המשמרת שוכפלה' : `המשמרת הועברה ל${dayName(date)} ${shortDate(date)}`); reload({ silent: true }); return r; },
      );
    } catch { /* toast already shown */ }
  };

  const dropProps = (date) => (canEdit ? {
    onDragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move'; if (dropDay !== date) setDropDay(date); },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropDay(null); },
    onDrop: (e) => onDrop(e, date),
  } : {});

  const copyWeek = () => {
    const src = startOfWeek(anchor);
    const target = addDays(src, 7);
    confirm({
      title: 'שכפול השבוע לשבוע הבא',
      message: `כל המשמרות של השבוע ${shortDate(src)}–${shortDate(addDays(src, 6))} ישוכפלו לשבוע ${shortDate(target)}–${shortDate(addDays(target, 6))}. משמרות שמתנגשות עם שיבוץ קיים או חופשה מאושרת ידולגו.`,
      confirmText: 'שכפול שבוע',
      danger: false,
      onConfirm: async () => {
        try {
          const r = await api.post('/shifts/copy-week', { source_week_start: src, target_week_start: target });
          toast.success(r.message);
          setAnchor(target);
        } catch (err) { toast.error(err); throw err; }
      },
    });
  };

  const days = view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : [];
  const monthDays = view === 'month' ? (() => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; })() : [];

  return (
    <>
      <PageHeader title={canEdit || viewAll ? 'סידור משמרות' : 'המשמרות שלי'}
        subtitle={canEdit && !isMobile ? 'גררו משמרת ליום אחר כדי להעביר אותה · החזיקו Ctrl בזמן הגרירה כדי לשכפל' : undefined}
        actions={canEdit && (
          <>
            {view === 'week' && <Button icon={CopyPlus} onClick={copyWeek}><span className="btn-label">שכפול לשבוע הבא</span></Button>}
            <Button variant="primary" icon={Plus} onClick={() => setForm({ new: true, date: view === 'day' ? anchor : today < from ? from : today })}>משמרת חדשה</Button>
          </>
        )} />

      <div className="cal-toolbar">
        <div className="flex">
          <IconButton icon={ChevronRight} label="הקודם" onClick={() => move(-1)} />
          <Button size="sm" onClick={() => setAnchor(today)}>היום</Button>
          <IconButton icon={ChevronLeft} label="הבא" onClick={() => move(1)} />
        </div>
        <div className="cal-title">{titleFor(view, anchor)}</div>
        <div style={{ marginInlineStart: 'auto' }} className="flex flex-wrap">
          {viewAll && (
            <>
              <Select value={filters.department_id} onChange={(e) => setFilters((f) => ({ ...f, department_id: e.target.value }))} aria-label="מחלקה" style={{ width: 'auto' }}>
                <option value="">כל המחלקות</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
              <Select value={filters.employee_id} onChange={(e) => setFilters((f) => ({ ...f, employee_id: e.target.value }))} aria-label="עובד" style={{ width: 'auto' }} className="hide-sm">
                <option value="">כל העובדים</option>{meta.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
            </>
          )}
          <Segmented value={view} onChange={setView} options={[
            { value: 'day', label: 'יום', icon: CalendarDays }, { value: 'week', label: 'שבוע', icon: CalendarRange }, { value: 'month', label: 'חודש', icon: Calendar },
          ]} />
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows rows={6} h={60} /> : (
          <>
            {view === 'week' && (
              <div className="cal-week">
                {days.map((d) => {
                  const list = byDay.get(d) || [];
                  return (
                    <div key={d} className={`cal-day ${d === today ? 'today' : ''}`}>
                      <div className="cal-day-head">
                        <div className="dname">{dayName(d)}</div>
                        <div className="dnum">{Number(d.slice(8, 10))}</div>
                        {isMobile && <Badge>{list.length} משמרות</Badge>}
                      </div>
                      <div className={`cal-day-body ${dropDay === d ? 'drop-target' : ''}`} {...dropProps(d)}>
                        {list.map((s) => (
                          <ShiftChip key={s.id} s={s} canEdit={canEdit} onOpen={openShift} dragging={dragged?.id === s.id}
                            onDragStart={setDragged} onDragEnd={() => { setDragged(null); setDropDay(null); }} />
                        ))}
                        {!list.length && !canEdit && <div className="subtle" style={{ textAlign: 'center', padding: 8 }}>—</div>}
                        {canEdit && <button type="button" className="cal-add" onClick={() => setForm({ new: true, date: d })} aria-label={`הוספת משמרת ב${dayName(d)}`}><Plus size={15} /></button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {view === 'month' && (
              <div className="cal-month">
                {DAYS_SHORT.map((d) => <div key={d} className="mhead">{d}</div>)}
                {monthDays.map((d) => {
                  const list = byDay.get(d) || [];
                  const other = d.slice(0, 7) !== anchor.slice(0, 7);
                  return (
                    <div key={d} className={`cal-cell ${other ? 'other' : ''} ${d === today ? 'today' : ''} ${dropDay === d ? 'drop-target' : ''}`}
                      onClick={() => { setAnchor(d); setView('day'); }} {...dropProps(d)}>
                      <div className="flex between"><span className="cnum">{Number(d.slice(8, 10))}</span>{list.length > 0 && <span className="badge tone-primary count" style={{ display: 'none' }}>{list.length}</span>}</div>
                      {list.slice(0, 3).map((s) => (
                        <div key={s.id} className="cal-mini" style={{ '--chip': s.department_color }} draggable={canEdit}
                          onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('text/plain', String(s.id)); setDragged(s); }}
                          onDragEnd={() => { setDragged(null); setDropDay(null); }}
                          onClick={(e) => { e.stopPropagation(); openShift(s); }} title={`${s.employee_name} ${shiftRange(s)}`}>
                          <span className="ltr">{time(s.start_at)}</span> {s.employee_name}
                        </div>
                      ))}
                      {list.length > 3 && <div className="subtle cal-mini" style={{ background: 'none', border: 0 }}>+{list.length - 3} נוספות</div>}
                    </div>
                  );
                })}
              </div>
            )}

            {view === 'day' && (
              (byDay.get(anchor) || []).length ? (
                <div className="day-view" {...dropProps(anchor)}>
                  {(byDay.get(anchor) || []).map((s) => {
                    const startH = Number(s.start_at.slice(11, 13)) + Number(s.start_at.slice(14, 16)) / 60;
                    const len = (new Date(`${s.end_at}:00Z`) - new Date(`${s.start_at}:00Z`)) / 3600000;
                    return (
                      <div key={s.id} className="day-row" role="button" tabIndex={0} onClick={() => openShift(s)} style={{ cursor: 'pointer' }}>
                        <div style={{ minWidth: 0, flex: '0 1 240px' }}><Person name={s.employee_name} avatar={s.employee_avatar} sub={s.position_name} /></div>
                        <div className="timeline-bar hide-sm" style={{ '--chip': s.department_color }} aria-hidden>
                          <span style={{ right: `${(startH / 24) * 100}%`, width: `${(Math.min(len, 24 - startH) / 24) * 100}%` }} />
                        </div>
                        <div className="grow hide-sm subtle flex" style={{ flex: '0 1 160px' }}>{s.location_name && <><MapPin size={14} />{s.location_name}</>}</div>
                        <div className="text-end">
                          <div className="ltr" style={{ fontWeight: 700 }}><Clock size={14} style={{ verticalAlign: -2 }} /> {shiftRange(s)}</div>
                          <StatusBadge map={ATTENDANCE_STATUS} value={s.attendance_status} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState icon={CalendarDays} title="אין משמרות ביום זה"
                  text={canEdit ? 'צרו משמרת חדשה ושבצו אליה עובד אחד או יותר.' : 'לא שובצת למשמרת ביום זה.'}
                  action={canEdit && <Button variant="primary" icon={Plus} onClick={() => setForm({ new: true, date: anchor })}>יצירת משמרת</Button>} />
              )
            )}
            {view !== 'day' && !shifts.length && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                <EmptyState icon={CalendarDays} title="אין משמרות בתקופה זו"
                  text={canEdit ? 'התחילו לבנות את סידור העבודה, או שכפלו שבוע קודם.' : 'לא שובצת למשמרות בתקופה זו.'}
                  action={canEdit && <Button variant="primary" icon={Plus} onClick={() => setForm({ new: true, date: from < today ? today : from })}>יצירת משמרת</Button>} />
              </div>
            )}
          </>
        )}
      </div>

      {!viewAll && user.employee_id && <p className="subtle mt">רוצים להחליף משמרת? הגישו בקשה בעמוד הבקשות.</p>}
      {canEdit && <button type="button" className="fab" aria-label="משמרת חדשה" onClick={() => setForm({ new: true, date: view === 'day' ? anchor : today })}><Plus size={24} /></button>}
      {form && (
        <ShiftForm open onClose={() => setForm(null)} shift={form.new ? null : form} defaults={{ date: form.date }} onSaved={() => reload({ silent: true })} />
      )}
      <ShiftDetails shift={details} onClose={() => setDetails(null)} />
      {conflictDialog}
      {confirmDialog}
    </>
  );
}
