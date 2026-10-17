import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ChevronRight, ChevronLeft, CalendarCheck, Send, LayoutGrid, Clock, Plus, Pencil, Crown, X, Save, CheckCircle2, UserX,
  AlertTriangle, Users, Lock, StickyNote, Check, Repeat,
} from 'lucide-react';
import { useApi, useHolidays } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Avatar, Badge, Button, Card, EmptyState, ErrorState, Field, HolidayTags, IconButton, Input, Modal, PageHeader, Select, SkeletonRows, Tabs, Textarea, useConfirm, useForm,
} from '../components/ui.jsx';
import { addDays, dateTime, dayName, localToday, shortDate, startOfWeek, time } from '../lib/format.js';

const PREF = {
  preferred: { label: 'מעדיף/ה', short: 'מעדיף', tone: 'success' },
  available: { label: 'יכול/ה', short: 'יכול', tone: 'info' },
  unavailable: { label: 'לא יכול/ה', short: 'לא יכול', tone: 'danger' },
};
const typeTime = (t) => `${t.start_time}–${t.end_time}`;
const weekLabel = (ws) => `${shortDate(ws)} – ${shortDate(addDays(ws, 6))}`;

/** Week picker: previous / next, with quick "this week" and "next week". */
function WeekNav({ week, setWeek }) {
  const thisWeek = startOfWeek(localToday());
  const label = week === thisWeek ? 'השבוע' : week === addDays(thisWeek, 7) ? 'השבוע הבא' : null;
  return (
    <div className="week-nav">
      <IconButton icon={ChevronRight} label="השבוע הקודם" onClick={() => setWeek(addDays(week, -7))} />
      <div className="week-nav-label">
        <strong className="ltr">{weekLabel(week)}</strong>
        {label && <span className="subtle">{label}</span>}
      </div>
      <IconButton icon={ChevronLeft} label="השבוע הבא" onClick={() => setWeek(addDays(week, 7))} />
      {week !== thisWeek && <Button size="sm" onClick={() => setWeek(thisWeek)}>השבוע</Button>}
      {week !== addDays(thisWeek, 7) && <Button size="sm" onClick={() => setWeek(addDays(thisWeek, 7))}>השבוע הבא</Button>}
    </div>
  );
}

function LeadBadge() {
  return <span className="lead-badge"><Crown size={12} />אחמ״ש</span>;
}

// ============================ published schedule ============================
function Published({ week, setWeek }) {
  const hol = useHolidays(week, addDays(week, 6));
  const { data, loading, error, reload } = useApi('/schedule/published', { week });
  const total = data?.days.reduce((t, d) => t + d.shifts.length, 0) || 0;
  return (
    <>
      <div className="schedule-toolbar">
        <WeekNav week={week} setWeek={setWeek} />
        {data?.state.status === 'published' && <Badge tone="success" dot>פורסם{data.state.published_at && <> · <span className="ltr">{dateTime(data.state.published_at)}</span></>}</Badge>}
      </div>
      {error ? <div className="card"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? <div className="card"><SkeletonRows rows={5} h={70} /></div> : !total ? (
        <div className="card"><EmptyState icon={CalendarCheck} title="הסידור לשבוע זה עדיין לא פורסם" text="כשהמנהל יאשר את הסידור תקבלו התראה, והוא יופיע כאן." /></div>
      ) : (
        <div className="schedule-days">
          {data.days.map((d) => (
            <section key={d.date} className={`card day-card ${d.date === localToday() ? 'is-today' : ''}`}>
              <header className="day-card-head">
                <strong>יום {dayName(d.date)}</strong>
                <span className="subtle ltr">{shortDate(d.date)}</span>
                <HolidayTags list={hol.get(d.date)} />
              </header>
              {!d.shifts.length ? <p className="subtle day-empty">אין משמרות</p> : d.shifts.map((s) => (
                <div key={s.key} className="pub-shift">
                  <div className="pub-shift-head">
                    <span className="pub-shift-name">{s.name}</span>
                    <span className="ltr subtle">{time(s.start_at)}–{time(s.end_at)}</span>
                  </div>
                  <ul className="pub-workers">
                    {s.workers.map((w) => (
                      <li key={w.shift_id} className={w.is_me ? 'is-me' : ''}>
                        <Avatar name={w.name} src={w.avatar} size={26} />
                        <span className="pub-worker-name">{w.name}{w.is_me && ' (אני)'}</span>
                        {w.is_lead && <LeadBadge />}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

// ============================ employee submission ============================
function Submit({ week, setWeek }) {
  const hol = useHolidays(week, addDays(week, 6));
  const toast = useToast();
  const { data, loading, error, reload } = useApi('/schedule/my', { week });
  const [prefs, setPrefs] = useState({});
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!data) return;
    setPrefs(Object.fromEntries(data.prefs.map((p) => [`${p.date}|${p.shift_type_id}`, p.preference])));
    setNote(data.note || '');
  }, [data]);
  const locked = data?.locked;
  const set = (date, typeId, value) => !locked && setPrefs((p) => ({ ...p, [`${date}|${typeId}`]: p[`${date}|${typeId}`] === value ? undefined : value }));
  const fillAll = (value) => !locked && setPrefs(Object.fromEntries(data.days.flatMap((d) => data.types.map((t) => [`${d}|${t.id}`, value]))));
  const answered = Object.values(prefs).filter(Boolean).length;

  const save = async () => {
    setSaving(true);
    try {
      const list = Object.entries(prefs).filter(([, v]) => v).map(([k, preference]) => {
        const [date, id] = k.split('|');
        return { date, shift_type_id: Number(id), preference };
      });
      const r = await api.put('/schedule/my', { week_start: data.week_start, note, prefs: list });
      toast.success(r.message);
      reload({ silent: true });
    } catch (e) { toast.error(e); } finally { setSaving(false); }
  };

  return (
    <>
      <div className="schedule-toolbar">
        <WeekNav week={week} setWeek={setWeek} />
        {data?.submitted_at && <Badge tone="success" dot>הוגש · <span className="ltr">{dateTime(data.submitted_at)}</span></Badge>}
      </div>
      {error ? <div className="card"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? <div className="card"><SkeletonRows rows={7} h={56} /></div> : !data.types.length ? (
        <div className="card"><EmptyState icon={Clock} title="עדיין לא הוגדרו משמרות" text="המנהל צריך להגדיר את המשמרות (למשל בוקר וערב) לפני שאפשר להגיש זמינות." /></div>
      ) : (
        <>
          {locked && <div className="alert tone-warning mb"><Lock size={18} /><span>{data.status === 'published' ? 'הסידור לשבוע זה כבר פורסם, ולכן אי אפשר לשנות את הזמינות. לשינויים פנו למנהל.' : 'השבוע הזה כבר עבר.'}</span></div>}
          {!locked && (
            <div className="card card-pad mb submit-help">
              <p>סמנו לכל משמרת אם אתם <strong>מעדיפים</strong>, <strong>יכולים</strong> או <strong>לא יכולים</strong> לעבוד בה. לחיצה נוספת מבטלת את הבחירה.</p>
              <div className="flex flex-wrap">
                <span className="subtle">מילוי מהיר:</span>
                <Button size="sm" onClick={() => fillAll('available')}>יכול/ה בכל המשמרות</Button>
                <Button size="sm" variant="ghost" onClick={() => setPrefs({})}>ניקוי</Button>
              </div>
            </div>
          )}
          <div className="schedule-days">
            {data.days.map((d) => (
              <section key={d} className="card day-card">
                <header className="day-card-head"><strong>יום {dayName(d)}</strong><span className="subtle ltr">{shortDate(d)}</span><HolidayTags list={hol.get(d)} /></header>
                {data.types.map((t) => {
                  const v = prefs[`${d}|${t.id}`];
                  return (
                    <div key={t.id} className="pref-row">
                      <div className="pref-row-label"><span className="pub-shift-name">{t.name}</span><span className="ltr subtle">{typeTime(t)}</span></div>
                      <div className="pref-choices" role="radiogroup" aria-label={`${t.name} ביום ${dayName(d)}`}>
                        {Object.entries(PREF).map(([k, p]) => (
                          <button key={k} type="button" role="radio" aria-checked={v === k} disabled={locked}
                            className={`pref-btn pref-${k} ${v === k ? 'on' : ''}`} onClick={() => set(d, t.id, k)}>
                            {v === k && <Check size={14} />}{p.short}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
          <div className="card card-pad mt">
            <Field label="הערה למנהל (אופציונלי)"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} disabled={locked} placeholder="לדוגמה: ביום שלישי אני יכול/ה רק עד 13:00" style={{ minHeight: 64 }} /></Field>
            {!locked && (
              <div className="flex between flex-wrap mt">
                <span className="subtle">סומנו {answered} מתוך {data.days.length * data.types.length} משמרות</span>
                <Button variant="primary" icon={Send} onClick={save} loading={saving}>{data.submitted_at ? 'עדכון הזמינות' : 'שליחת הזמינות'}</Button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ============================ manager board ============================
function Picker({ cell, board, assignments, toggle, onClose }) {
  const [q, setQ] = useState('');
  if (!cell) return null;
  const { date, type } = cell;
  const prefOf = (empId) => board.prefs.find((p) => p.employee_id === empId && p.date === date && p.shift_type_id === type.id)?.preference;
  const onLeave = (empId) => board.leave.some((l) => l.employee_id === empId && l.start_date <= date && l.end_date >= date);
  const otherShift = (empId) => assignments.find((a) => a.employee_id === empId && a.date === date && a.shift_type_id !== type.id);
  // a manual calendar shift that overlaps this shift's hours (same hours = will simply be linked on publish)
  const tStart = `${date}T${type.start_time}`;
  const tEnd = type.end_time <= type.start_time ? `${addDays(date, 1)}T${type.end_time}` : `${date}T${type.end_time}`;
  const manualClash = (empId) => board.busy.find((s) => s.employee_id === empId && s.start_at < tEnd && s.end_at > tStart && !(s.start_at === tStart && s.end_at === tEnd));
  const rank = (e) => (onLeave(e.id) ? 5 : { preferred: 0, available: 1, unavailable: 4 }[prefOf(e.id)] ?? (e.submitted_at ? 3 : 2));
  const list = board.employees.filter((e) => !q || e.name.includes(q)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'he'));
  const assigned = new Set(assignments.filter((a) => a.date === date && a.shift_type_id === type.id).map((a) => a.employee_id));

  return (
    <Modal open onClose={onClose} title={`שיבוץ · ${type.name} · יום ${dayName(date)} ${shortDate(date)}`}
      footer={<Button variant="primary" onClick={onClose}>סיום ({assigned.size} משובצים)</Button>}>
      <Input placeholder="חיפוש עובד..." value={q} onChange={(e) => setQ(e.target.value)} className="mb" />
      <div className="picker-list">
        {list.map((e) => {
          const pref = prefOf(e.id);
          const leave = onLeave(e.id);
          const other = otherShift(e.id);
          const clash = manualClash(e.id);
          const on = assigned.has(e.id);
          return (
            <button key={e.id} type="button" className={`picker-row ${on ? 'on' : ''}`} onClick={() => toggle(date, type.id, e.id)} aria-pressed={on}>
              <span className={`picker-check ${on ? 'on' : ''}`}>{on && <Check size={14} />}</span>
              <Avatar name={e.name} src={e.avatar} size={32} />
              <span className="picker-main">
                <span className="picker-name">{e.name}</span>
                <span className="picker-sub">
                  {leave ? <Badge tone="danger">בחופשה מאושרת</Badge>
                    : pref ? <Badge tone={PREF[pref].tone}>{PREF[pref].label}</Badge>
                      : <Badge>{e.submitted_at ? 'לא סימן/ה משמרת זו' : 'לא הגיש/ה זמינות'}</Badge>}
                  {other && <Badge tone="warning">משובץ/ת גם ב{board.types.find((t) => t.id === other.shift_type_id)?.name}</Badge>}
                  {clash && <Badge tone="warning">יש לו/ה כבר משמרת <span className="ltr">{time(clash.start_at)}–{time(clash.end_at)}</span></Badge>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/** "2/3 עובדים · אחמ״ש 1/1" – green when the shift is fully staffed. */
function StaffingMeter({ req, here, onEdit }) {
  const leads = here.filter((a) => a.is_lead).length;
  const total = here.length;
  const ok = req.required_workers > 0 && total >= req.required_workers && leads >= req.required_leads;
  const tone = !req.required_workers ? 'neutral' : ok ? 'success' : 'warning';
  return (
    <button type="button" className={`staffing-meter tone-${tone}`} onClick={onEdit} title="שינוי מספר העובדים הדרוש">
      {req.required_workers ? (
        <>
          <span>עובדים {total}/{req.required_workers}</span>
          {req.required_leads > 0 && <span>· אחמ״ש {leads}/{req.required_leads}</span>}
        </>
      ) : <span>לא הוגדר כמה עובדים דרושים</span>}
      <Pencil size={12} />
    </button>
  );
}

function RequirementForm({ edit, onClose, onSaved }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({ required_workers: edit.required_workers, required_leads: edit.required_leads });
  const save = async (reset) => {
    setSaving(true);
    try {
      const r = await api.put('/schedule/requirements', { date: edit.date, shift_type_id: edit.type.id, required_workers: Number(v.required_workers) || 0, required_leads: Number(v.required_leads) || 0, reset });
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={`כמה עובדים דרושים · ${edit.type.name} · ${shortDate(edit.date)}`}
      footer={<>{edit.override && <Button variant="ghost" onClick={() => save(true)} style={{ marginInlineEnd: 'auto' }}>חזרה לברירת המחדל</Button>}<Button onClick={onClose}>ביטול</Button><Button variant="primary" loading={saving} onClick={() => save(false)}>שמירה</Button></>}>
      <p className="muted mb">העובדים יכולים לבחור בעצמם משמרות פנויות (מי שבוחר ראשון תופס), ואתם רק מאשרים. ברירת המחדל לכל משמרת נקבעת ב"הגדרת משמרות".</p>
      <div className="form-grid">
        <Field label="סה״כ עובדים במשמרת" error={errors.required_workers}><Input type="number" min="0" max="50" value={v.required_workers} onChange={set('required_workers')} /></Field>
        <Field label="מתוכם אחמ״שים" error={errors.required_leads}><Input type="number" min="0" max="10" value={v.required_leads} onChange={set('required_leads')} /></Field>
      </div>
    </Modal>
  );
}

// ============================ employee: open shifts (first come) ============================
function OpenShifts({ week, setWeek }) {
  const hol = useHolidays(week, addDays(week, 6));
  const toast = useToast();
  const { data, loading, error, reload, setData } = useApi('/schedule/open', { week });
  const [busy, setBusy] = useState(null);
  const act = async (slot, asLead, cancel) => {
    const k = `${slot.date}|${slot.shift_type_id}|${asLead ? 'l' : 'w'}`;
    setBusy(k);
    try {
      const r = cancel
        ? await api.del(`/schedule/claim?date=${slot.date}&shift_type_id=${slot.shift_type_id}`)
        : await api.post('/schedule/claim', { date: slot.date, shift_type_id: slot.shift_type_id, as_lead: asLead });
      setData((dd) => ({ ...dd, slots: r.slots }));
      toast.success(r.message);
    } catch (e) { toast.error(e); reload({ silent: true }); } finally { setBusy(null); }
  };
  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  const anyOpen = data?.slots.some((s) => s.required_workers > 0);
  return (
    <>
      <div className="schedule-toolbar"><WeekNav week={week} setWeek={setWeek} /></div>
      {loading && !data ? <div className="card"><SkeletonRows rows={6} h={60} /></div> : data.locked ? (
        <div className="card"><EmptyState icon={Lock} title="השבוע הזה כבר סגור לבחירה" text={data.status === 'published' ? 'הסידור פורסם. אפשר לראות אותו בלשונית "הסידור".' : 'השבוע הזה כבר עבר.'} /></div>
      ) : !anyOpen ? (
        <div className="card"><EmptyState icon={Clock} title="אין משמרות פתוחות לבחירה" text="כשהמנהל יפתח משמרות לבחירה, הן יופיעו כאן. מי שבוחר ראשון – תופס." /></div>
      ) : (
        <>
          <div className="alert tone-info mb"><Clock size={18} /><span>בחרו משמרות פנויות – מי שבוחר ראשון תופס את המקום. הבחירה ממתינה לאישור המנהל, ועד אז אפשר לבטל.</span></div>
          <div className="schedule-days">
            {data.days.map((d) => (
              <section key={d} className="card day-card">
                <header className="day-card-head"><strong>יום {dayName(d)}</strong><span className="subtle ltr">{shortDate(d)}</span><HolidayTags list={hol.get(d)} /></header>
                {data.types.map((t) => {
                  const slot = data.slots.find((x) => x.date === d && x.shift_type_id === t.id);
                  if (!slot || !slot.required_workers) return null;
                  const freeRegular = slot.required_workers - slot.required_leads - slot.taken_regular;
                  const freeLead = slot.required_leads - slot.taken_leads;
                  const past = d < localToday();
                  return (
                    <div key={t.id} className="board-shift">
                      <div className="pub-shift-head"><span className="pub-shift-name">{t.name}</span><span className="ltr subtle">{typeTime(t)}</span></div>
                      <div className="open-slot-counts">
                        <Badge tone={freeRegular > 0 ? 'success' : 'neutral'}>{freeRegular > 0 ? `${freeRegular} מקומות פנויים` : 'מלא'}</Badge>
                        {slot.required_leads > 0 && <Badge tone={freeLead > 0 ? 'warning' : 'neutral'}><Crown size={12} />{freeLead > 0 ? 'דרוש אחמ״ש' : 'יש אחמ״ש'}</Badge>}
                      </div>
                      {slot.people.length > 0 && <div className="subtle open-slot-people">{slot.people.map((p) => `${p.name}${p.is_lead ? ' (אחמ״ש)' : ''}`).join(' · ')}</div>}
                      {slot.mine ? (
                        <div className="open-slot-mine">
                          <Badge tone={slot.mine.status === 'approved' ? 'success' : 'warning'} dot>{slot.mine.status === 'approved' ? 'אושר' : 'ממתין לאישור'}{slot.mine.is_lead ? ' · אחמ״ש' : ''}</Badge>
                          {slot.mine.status === 'claimed' && <Button size="sm" variant="ghost" loading={busy?.startsWith(`${d}|${t.id}`)} onClick={() => act(slot, false, true)}>ביטול</Button>}
                        </div>
                      ) : !past && (
                        <div className="open-slot-actions">
                          {freeRegular > 0 && <Button size="sm" variant="primary" icon={Plus} loading={busy === `${d}|${t.id}|w`} onClick={() => act(slot, false)}>אני לוקח/ת</Button>}
                          {data.can_lead && freeLead > 0 && <Button size="sm" icon={Crown} loading={busy === `${d}|${t.id}|l`} onClick={() => act(slot, true)}>לוקח/ת כאחמ״ש</Button>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Board({ week, setWeek }) {
  const hol = useHolidays(week, addDays(week, 6));
  const toast = useToast();
  const { data, loading, error, reload } = useApi('/schedule/board', { week });
  const [assignments, setAssignments] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [cell, setCell] = useState(null);
  const [saving, setSaving] = useState(null);
  const [showMissing, setShowMissing] = useState(false);
  const [warnings, setWarnings] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  useEffect(() => { if (data) { setAssignments(data.assignments.map((a) => ({ ...a, is_lead: !!a.is_lead }))); setDirty(false); } }, [data]);

  const empById = useMemo(() => new Map((data?.employees || []).map((e) => [e.id, e])), [data]);
  const prefOf = (empId, date, typeId) => data.prefs.find((p) => p.employee_id === empId && p.date === date && p.shift_type_id === typeId)?.preference;

  const toggle = (date, typeId, empId) => {
    setDirty(true);
    setAssignments((list) => (list.some((a) => a.date === date && a.shift_type_id === typeId && a.employee_id === empId)
      ? list.filter((a) => !(a.date === date && a.shift_type_id === typeId && a.employee_id === empId))
      : [...list, { date, shift_type_id: typeId, employee_id: empId, is_lead: false, status: 'approved' }]));
  };
  const setLead = (date, typeId, empId) => {
    setDirty(true);
    setAssignments((list) => list.map((a) => (a.date === date && a.shift_type_id === typeId
      ? { ...a, is_lead: a.employee_id === empId ? !a.is_lead : false } : a)));
  };

  const setStatus = (date, typeId, empId, status) => {
    setDirty(true);
    setAssignments((list) => (status === 'rejected'
      ? list.filter((a) => !(a.date === date && a.shift_type_id === typeId && a.employee_id === empId))
      : list.map((a) => (a.date === date && a.shift_type_id === typeId && a.employee_id === empId ? { ...a, status } : a))));
  };
  const approveAll = () => { setDirty(true); setAssignments((list) => list.map((a) => ({ ...a, status: 'approved' }))); };
  const reqOf = (date, typeId) => data.requirements?.find((r) => r.date === date && r.shift_type_id === typeId) || { required_workers: 0, required_leads: 0 };
  const [reqEdit, setReqEdit] = useState(null);

  const save = async (publish) => {
    setSaving(publish ? 'publish' : 'save');
    try {
      const r = await api[publish ? 'post' : 'put'](publish ? '/schedule/publish' : '/schedule/board', { week_start: data.week_start, assignments, loaded_at: data.loaded_at });
      toast.success(publish ? `${r.message} (${r.stats.created} חדשות, ${r.stats.updated} עודכנו, ${r.stats.cancelled} בוטלו)` : r.message);
      if (publish && r.warnings?.length) setWarnings(r.warnings);
      setDirty(false);
      reload({ silent: true });
    } catch (e) { toast.error(e); throw e; } finally { setSaving(null); }
  };

  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <div className="card"><SkeletonRows rows={7} h={70} /></div>;
  if (!data.types.length) return <div className="card"><EmptyState icon={Clock} title="עדיין לא הוגדרו משמרות" text="הגדירו קודם את המשמרות (למשל בוקר וערב) בלשונית 'הגדרת משמרות'." /></div>;

  const pendingCount = assignments.filter((a) => a.status === 'claimed').length;
  const submitted = data.employees.filter((e) => e.submitted_at);
  const missing = data.employees.filter((e) => !e.submitted_at);
  const notes = submitted.filter((e) => e.note);
  const published = data.state.status === 'published' && !dirty;
  const noLead = data.days.flatMap((d) => data.types.map((t) => [d, t]))
    .filter(([d, t]) => assignments.some((a) => a.date === d && a.shift_type_id === t.id) && !assignments.some((a) => a.date === d && a.shift_type_id === t.id && a.is_lead)).length;

  const publish = () => confirm({
    title: 'לאשר ולפרסם את הסידור?',
    message: `${assignments.length} שיבוצים יהפכו למשמרות, וכל עובד יקבל התראה.${noLead ? ` שימו לב: ב-${noLead} משמרות לא סומן אחמ"ש.` : ''} אפשר לשנות ולפרסם שוב בהמשך.`,
    confirmText: 'אישור ופרסום', danger: false,
    onConfirm: () => save(true),
  });

  return (
    <>
      <div className="schedule-toolbar">
        <WeekNav week={week} setWeek={setWeek} />
        {published ? <Badge tone="success" dot>פורסם</Badge> : dirty ? <Badge tone="warning" dot>יש שינויים שלא נשמרו</Badge> : <Badge dot>טיוטה</Badge>}
      </div>

      <div className="card card-pad mb board-summary">
        <div className="board-summary-stats">
          <span className="flex"><Users size={16} className="muted" />הגישו זמינות: <strong>{submitted.length}</strong> מתוך {data.employees.length}</span>
          <span className="flex"><CalendarCheck size={16} className="muted" />שיבוצים: <strong>{assignments.length}</strong></span>
          {pendingCount > 0 && <span className="flex"><Badge tone="warning" dot>{pendingCount} בחירות ממתינות לאישור</Badge><Button size="sm" variant="ghost" icon={Check} onClick={approveAll}>אישור כולן</Button></span>}
          {missing.length > 0 && <Button size="sm" variant="ghost" icon={UserX} onClick={() => setShowMissing((v) => !v)}>{showMissing ? 'הסתרה' : 'מי לא הגיש?'}</Button>}
        </div>
        {showMissing && <p className="subtle">{missing.map((e) => e.name).join(' · ')}</p>}
        {notes.length > 0 && (
          <details className="board-notes">
            <summary><StickyNote size={15} />הערות מהעובדים ({notes.length})</summary>
            <ul>{notes.map((e) => <li key={e.id}><strong>{e.name}:</strong> {e.note}</li>)}</ul>
          </details>
        )}
        <div className="board-actions">
          <Button icon={Save} onClick={() => save(false).catch(() => {})} loading={saving === 'save'} disabled={!dirty}>שמירת טיוטה</Button>
          <Button variant="primary" icon={CheckCircle2} onClick={publish} loading={saving === 'publish'} disabled={!assignments.length && !dirty}>אישור ופרסום</Button>
        </div>
      </div>

      <div className="schedule-days">
        {data.days.map((d) => (
          <section key={d} className="card day-card">
            <header className="day-card-head"><strong>יום {dayName(d)}</strong><span className="subtle ltr">{shortDate(d)}</span><HolidayTags list={hol.get(d)} /></header>
            {data.types.map((t) => {
              const here = assignments.filter((a) => a.date === d && a.shift_type_id === t.id);
              const counts = { preferred: 0, available: 0 };
              for (const p of data.prefs) if (p.date === d && p.shift_type_id === t.id && counts[p.preference] !== undefined) counts[p.preference] += 1;
              return (
                <div key={t.id} className="board-shift">
                  <div className="pub-shift-head">
                    <span className="pub-shift-name">{t.name}</span>
                    <span className="ltr subtle">{typeTime(t)}</span>
                  </div>
                  <StaffingMeter req={reqOf(d, t.id)} here={here} onEdit={() => setReqEdit({ date: d, type: t, ...reqOf(d, t.id) })} />
                  <div className="board-shift-meta subtle">{counts.preferred} מעדיפים · {counts.available} יכולים</div>
                  <ul className="board-assigned">
                    {here.map((a) => {
                      const e = empById.get(a.employee_id);
                      const pref = prefOf(a.employee_id, d, t.id);
                      return (
                        <li key={a.employee_id} className={`${a.is_lead ? 'is-lead' : ''} ${a.status === 'claimed' ? 'is-claimed' : ''}`}>
                          <Avatar name={e?.name || '?'} src={e?.avatar} size={26} />
                          <span className="board-assigned-name">{e?.name || 'עובד לא פעיל'}{a.status === 'claimed' && <span className="claim-tag">בחר/ה בעצמו/ה</span>}</span>
                          {a.status === 'claimed' && (
                            <>
                              <IconButton icon={Check} label="אישור הבחירה" small className="approve-btn" onClick={() => setStatus(d, t.id, a.employee_id, 'approved')} />
                              <IconButton icon={X} label="דחיית הבחירה" small onClick={() => setStatus(d, t.id, a.employee_id, 'rejected')} />
                            </>
                          )}
                          {pref === 'unavailable' && <span title="סימן/ה שלא יכול/ה"><AlertTriangle size={15} className="warn-icon" /></span>}
                          <button type="button" className={`lead-toggle ${a.is_lead ? 'on' : ''}`} onClick={() => setLead(d, t.id, a.employee_id)}
                            aria-pressed={a.is_lead} title={a.is_lead ? 'ביטול אחמ״ש' : 'סימון כאחמ״ש'}>
                            <Crown size={13} />אחמ״ש
                          </button>
                          {a.status !== 'claimed' && <IconButton icon={X} label="הסרה מהמשמרת" small onClick={() => toggle(d, t.id, a.employee_id)} />}
                        </li>
                      );
                    })}
                  </ul>
                  <button type="button" className="board-add" onClick={() => setCell({ date: d, type: t })}><Plus size={15} />שיבוץ עובדים</button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <Picker cell={cell} board={data} assignments={assignments} toggle={toggle} onClose={() => setCell(null)} />
      {reqEdit && <RequirementForm edit={reqEdit} onClose={() => setReqEdit(null)} onSaved={() => reload({ silent: true })} />}
      <Modal open={!!warnings} onClose={() => setWarnings(null)} title="הסידור פורסם, אבל יש חפיפות" footer={<Button variant="primary" onClick={() => setWarnings(null)}>הבנתי</Button>}>
        <p className="muted">לעובדים הבאים יש שתי משמרות חופפות. אפשר לתקן זאת בלוח המשמרות:</p>
        <ul className="conflict-list">{warnings?.map((w) => <li key={w}><AlertTriangle size={18} className="warn-icon" />{w}</li>)}</ul>
      </Modal>
      {confirmDialog}
    </>
  );
}

// ============================ shift types ============================
function TypeForm({ type, onClose, onSaved }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({
    name: type?.name || '', start_time: type?.start_time || '07:00', end_time: type?.end_time || '15:00',
    sort_order: type?.sort_order ?? 0, is_active: type ? !!type.is_active : true,
    required_workers: type?.required_workers ?? 0, required_leads: type?.required_leads ?? 0,
  });
  const save = async () => {
    setSaving(true);
    try {
      const body = { ...v, sort_order: Number(v.sort_order) || 0, required_workers: Number(v.required_workers) || 0, required_leads: Number(v.required_leads) || 0 };
      const r = type ? await api.put(`/schedule/shift-types/${type.id}`, body) : await api.post('/schedule/shift-types', body);
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={type ? 'עריכת משמרת' : 'משמרת חדשה'} footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>שמירה</Button></>}>
      <div className="form-grid">
        <Field label="שם המשמרת *" className="full" error={errors.name}><Input value={v.name} onChange={set('name')} placeholder="לדוגמה: בוקר" invalid={errors.name} /></Field>
        <Field label="שעת התחלה *" error={errors.start_time}><Input type="time" value={v.start_time} onChange={set('start_time')} /></Field>
        <Field label="שעת סיום *" error={errors.end_time} hint={v.end_time <= v.start_time ? 'מסתיימת למחרת' : undefined}><Input type="time" value={v.end_time} onChange={set('end_time')} /></Field>
        <Field label="עובדים דרושים (ברירת מחדל)" error={errors.required_workers} hint="0 = לא פתוח לבחירה עצמית"><Input type="number" min="0" max="50" value={v.required_workers} onChange={set('required_workers')} /></Field>
        <Field label="מתוכם אחמ״שים" error={errors.required_leads}><Input type="number" min="0" max="10" value={v.required_leads} onChange={set('required_leads')} /></Field>
        <Field label="סדר תצוגה" hint="מספר קטן מוצג ראשון"><Input type="number" min="0" max="99" value={v.sort_order} onChange={set('sort_order')} /></Field>
        <div className="field"><label>&nbsp;</label><label className="checkbox"><input type="checkbox" checked={v.is_active} onChange={set('is_active')} />פעילה</label></div>
      </div>
    </Modal>
  );
}

function ShiftTypes() {
  const { data, loading, reload } = useApi('/schedule/shift-types', { all: 1 });
  const [form, setForm] = useState(null);
  return (
    <Card title="המשמרות בעסק" icon={Clock} pad={false} actions={<Button size="sm" variant="primary" icon={Plus} onClick={() => setForm({})}>משמרת חדשה</Button>}>
      {loading && !data ? <SkeletonRows rows={3} /> : !data.types.length ? (
        <EmptyState icon={Clock} title="אין משמרות" text="הגדירו את המשמרות בעסק, למשל בוקר 07:00–15:00 וערב 15:00–23:00." action={<Button variant="primary" icon={Plus} onClick={() => setForm({})}>משמרת חדשה</Button>} />
      ) : (
        <div className="list">
          {data.types.map((t) => (
            <div key={t.id} className="list-item">
              <span className="activity-icon tone-primary"><Clock size={16} /></span>
              <div className="grow">
                <div className="flex"><strong>{t.name}</strong>{!t.is_active && <Badge>לא פעילה</Badge>}</div>
                <div className="subtle"><span className="ltr">{typeTime(t)}{t.end_time <= t.start_time ? ' (+1)' : ''}</span>{t.required_workers > 0 && ` · ${t.required_workers} עובדים${t.required_leads ? `, ${t.required_leads} אחמ״ש` : ''}`}</div>
              </div>
              <IconButton icon={Pencil} label="עריכה" small onClick={() => setForm(t)} />
            </div>
          ))}
        </div>
      )}
      <p className="subtle" style={{ padding: '12px 16px' }}>שינוי שעות של משמרת יחול על סידורים שיפורסמו מעכשיו. משמרת שלא בשימוש אפשר להפוך ל"לא פעילה".</p>
      {form && <TypeForm type={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => reload({ silent: true })} />}
    </Card>
  );
}

// ============================ swap board ============================
const SWAP_STATUS = {
  open: { label: 'מחכה למחליף/ה', tone: 'info' },
  taken: { label: 'ממתין לאישור מנהל', tone: 'warning' },
  approved: { label: 'אושר', tone: 'success' },
  rejected: { label: 'נדחה', tone: 'danger' },
  cancelled: { label: 'בוטל', tone: 'neutral' },
};
const swapWhen = (w) => <>יום {dayName(w.start_at)} <span className="ltr">{shortDate(w.start_at)} · {time(w.start_at)}–{time(w.end_at)}</span></>;

function SwapRow({ w, children, who }) {
  return (
    <div className="list-item swap-row">
      <Avatar name={who.name} src={who.avatar} size={34} />
      <div className="grow">
        <div style={{ fontWeight: 600 }}>{swapWhen(w)}{w.is_lead ? <> <LeadBadge /></> : null}</div>
        <div className="subtle">{who.label}{w.type_name ? ` · ${w.type_name}` : ''}{w.location_name ? ` · ${w.location_name}` : ''}</div>
        {w.note && <div className="subtle swap-note"><StickyNote size={12} /> {w.note}</div>}
      </div>
      <div className="swap-actions">{children}</div>
    </div>
  );
}

function Swaps() {
  const toast = useToast();
  const { user } = useAuth();
  const { data, loading, error, reload } = useApi('/swaps');
  const [busy, setBusy] = useState(null);
  const [offer, setOffer] = useState(null);
  const act = async (key, fn) => {
    setBusy(key);
    try { const r = await fn(); toast.success(r.message); reload({ silent: true }); } catch (e) { toast.error(e); reload({ silent: true }); } finally { setBusy(null); }
  };
  if (error) return <div className="card"><ErrorState error={error} onRetry={reload} /></div>;
  if (loading && !data) return <div className="card"><SkeletonRows rows={5} h={60} /></div>;
  const me = user.employee_id;
  return (
    <div className="grid">
      <div className="alert tone-info"><Users size={18} /><span>לא יכולים להגיע? הציעו את המשמרת בלוח. עובד/ת אחר/ת לוקח/ת אותה, והמנהל מאשר. עד האישור – המשמרת עדיין שלכם.</span></div>
      {data.can_approve && (
        <Card title={`ממתינות לאישור (${data.pending.length})`} pad={false}>
          {!data.pending.length ? <p className="subtle" style={{ padding: 16, margin: 0 }}>אין החלפות שממתינות לאישור</p> : (
            <div className="list">
              {data.pending.map((w) => (
                <SwapRow key={w.id} w={w} who={{ name: w.taken_by_name, avatar: w.taken_by_avatar, label: `${w.offered_by_name} ← ${w.taken_by_name}` }}>
                  <Button size="sm" variant="success" icon={Check} loading={busy === `a${w.id}`} onClick={() => act(`a${w.id}`, () => api.post(`/swaps/${w.id}/decide`, { approve: true }))}>אישור</Button>
                  <Button size="sm" variant="ghost" icon={X} loading={busy === `r${w.id}`} onClick={() => act(`r${w.id}`, () => api.post(`/swaps/${w.id}/decide`, { approve: false }))}>דחייה</Button>
                </SwapRow>
              ))}
            </div>
          )}
        </Card>
      )}
      {me && (
        <Card title="משמרות שמחפשות מחליף" pad={false}>
          {!data.open.length ? <EmptyState icon={CalendarCheck} title="אין כרגע משמרות להחלפה" text="כשעובד/ת יציע/תציע משמרת, היא תופיע כאן ותקבלו התראה." /> : (
            <div className="list">
              {data.open.map((w) => (
                <SwapRow key={w.id} w={w} who={{ name: w.offered_by_name, avatar: w.offered_by_avatar, label: w.offered_by_name }}>
                  <Button size="sm" variant="primary" loading={busy === `t${w.id}`} onClick={() => act(`t${w.id}`, () => api.post(`/swaps/${w.id}/take`))}>אני לוקח/ת</Button>
                </SwapRow>
              ))}
            </div>
          )}
        </Card>
      )}
      {me && (
        <Card title="ההחלפות שלי" pad={false} actions={<Button size="sm" icon={Plus} onClick={() => setOffer({ shift_id: '', note: '' })} disabled={!data.offerable.length}>הצעת משמרת</Button>}>
          {!data.mine.length ? <p className="subtle" style={{ padding: 16, margin: 0 }}>{data.offerable.length ? 'עוד לא הצעת משמרות להחלפה' : 'אין לך משמרות עתידיות שאפשר להציע'}</p> : (
            <div className="list">
              {data.mine.map((w) => {
                const mineOffer = w.offered_by === me;
                const st = SWAP_STATUS[w.status];
                return (
                  <SwapRow key={w.id} w={w} who={mineOffer ? { name: w.taken_by_name || w.offered_by_name, avatar: w.taken_by_avatar, label: w.taken_by_name ? `הצעתי · ${w.taken_by_name} לוקח/ת` : 'הצעתי' } : { name: w.offered_by_name, avatar: w.offered_by_avatar, label: `לקחתי מ${w.offered_by_name}` }}>
                    <Badge tone={st.tone} dot>{st.label}</Badge>
                    {['open', 'taken'].includes(w.status) && (
                      <Button size="sm" variant="ghost" loading={busy === `c${w.id}`} onClick={() => act(`c${w.id}`, () => api.post(`/swaps/${w.id}/cancel`))}>{mineOffer ? 'ביטול' : 'ויתור'}</Button>
                    )}
                  </SwapRow>
                );
              })}
            </div>
          )}
        </Card>
      )}
      {offer && (
        <Modal open onClose={() => setOffer(null)} title="הצעת משמרת להחלפה"
          footer={<><Button onClick={() => setOffer(null)}>ביטול</Button><Button variant="primary" disabled={!offer.shift_id} loading={busy === 'offer'}
            onClick={() => act('offer', async () => { const r = await api.post('/swaps', { shift_id: Number(offer.shift_id), note: offer.note }); setOffer(null); return r; })}>פרסום בלוח</Button></>}>
          <div className="grid">
            <Field label="איזו משמרת?">
              <Select value={offer.shift_id} onChange={(e) => setOffer((o) => ({ ...o, shift_id: e.target.value }))}>
                <option value="">בחירת משמרת…</option>
                {data.offerable.map((s) => <option key={s.id} value={s.id}>{`יום ${dayName(s.start_at)} ${shortDate(s.start_at)} · ${time(s.start_at)}–${time(s.end_at)}${s.type_name ? ` · ${s.type_name}` : ''}`}</option>)}
              </Select>
            </Field>
            <Field label="הערה (לא חובה)"><Textarea value={offer.note} maxLength={300} onChange={(e) => setOffer((o) => ({ ...o, note: e.target.value }))} placeholder="למשל: יש לי מבחן" style={{ minHeight: 60 }} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Schedule() {
  const { can, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const manage = can('schedule.manage');
  const tabs = [
    { value: 'published', label: 'הסידור', icon: CalendarCheck },
    ...(user.employee_id ? [{ value: 'open', label: 'משמרות פתוחות', icon: Plus }, { value: 'submit', label: 'הגשת זמינות', icon: Send }] : []),
    ...(user.employee_id || can('shifts.manage') || manage ? [{ value: 'swaps', label: 'לוח החלפות', icon: Repeat }] : []),
    ...(manage ? [{ value: 'board', label: 'שיבוץ', icon: LayoutGrid }, { value: 'types', label: 'הגדרת משמרות', icon: Clock }] : []),
  ];
  const tab = tabs.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'published';
  const thisWeek = startOfWeek(localToday());
  const defaultWeek = tab === 'published' ? thisWeek : addDays(thisWeek, 7);
  const week = params.get('week') ? startOfWeek(params.get('week')) : defaultWeek;
  const update = (patch) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) if (v == null) n.delete(k); else n.set(k, v);
    return n;
  }, { replace: true });
  const setWeek = (w) => update({ week: w });

  return (
    <>
      <PageHeader title="סידור עבודה" subtitle={manage ? 'העובדים מגישים זמינות, אתם משבצים ומסמנים אחמ״ש, ובסוף מאשרים ומפרסמים' : 'הגשת זמינות לשבוע הבא וצפייה בסידור שפורסם'} />
      <Tabs tabs={tabs} value={tab} onChange={(t) => update({ tab: t, week: null })} />
      {tab === 'published' && <Published week={week} setWeek={setWeek} />}
      {tab === 'open' && <OpenShifts week={week} setWeek={setWeek} />}
      {tab === 'submit' && <Submit week={week} setWeek={setWeek} />}
      {tab === 'board' && <Board week={week} setWeek={setWeek} />}
      {tab === 'types' && <ShiftTypes />}
      {tab === 'swaps' && <Swaps />}
    </>
  );
}
