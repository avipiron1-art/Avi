import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Plus, Search, ListTodo, LayoutGrid, List, Pencil, Trash2, CalendarClock, Play, Check, User } from 'lucide-react';
import { useApi, useDebounced } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Avatar, Badge, Button, EmptyState, ErrorState, Field, IconButton, Input, Modal, PageHeader, Segmented, Select, SkeletonRows,
  StatusBadge, Textarea, useConfirm, useForm,
} from '../components/ui.jsx';
import { PRIORITY, TASK_STATUS, fullDate, localToday } from '../lib/format.js';

function TaskForm({ task, onClose, onSaved }) {
  const { meta } = useAuth();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const { values: v, set, errors, setErrors } = useForm({
    title: task?.title || '', description: task?.description || '', assignee_id: task?.assignee_id ?? '', due_date: task?.due_date || '',
    priority: task?.priority || 'normal', status: task?.status || 'new',
  });
  const save = async () => {
    setSaving(true);
    try {
      const r = task ? await api.put(`/tasks/${task.id}`, v) : await api.post('/tasks', v);
      toast.success(r.message); onSaved(); onClose();
    } catch (e) { setErrors(e.fields); toast.error(e); } finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title={task ? 'עריכת משימה' : 'משימה חדשה'} footer={<><Button onClick={onClose}>ביטול</Button><Button variant="primary" onClick={save} loading={saving}>{task ? 'שמירה' : 'יצירת משימה'}</Button></>}>
      <div className="form-grid">
        <Field label="כותרת *" className="full" error={errors.title}><Input value={v.title} onChange={set('title')} invalid={errors.title} maxLength={150} /></Field>
        <Field label="תיאור" className="full"><Textarea value={v.description} onChange={set('description')} maxLength={2000} /></Field>
        <Field label="עובד אחראי"><Select value={v.assignee_id} onChange={set('assignee_id')}><option value="">ללא</option>{meta.employees.filter((e) => e.status !== 'inactive' || e.id === v.assignee_id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
        <Field label="תאריך יעד" error={errors.due_date}><Input type="date" value={v.due_date} onChange={set('due_date')} /></Field>
        <Field label="עדיפות"><Select value={v.priority} onChange={set('priority')}>{Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select></Field>
        <Field label="סטטוס"><Select value={v.status} onChange={set('status')}>{Object.entries(TASK_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

function DueLabel({ date, status }) {
  if (!date) return <span className="subtle">ללא יעד</span>;
  const today = localToday();
  const overdue = date < today && ['new', 'in_progress'].includes(status);
  return <span className="flex" style={{ gap: 4, color: overdue ? 'var(--danger)' : 'var(--text-2)', fontSize: '.85rem', fontWeight: overdue ? 700 : 500 }}><CalendarClock size={14} />{overdue ? 'באיחור · ' : ''}{fullDate(date)}</span>;
}

export default function Tasks() {
  const { can, user, meta } = useAuth();
  const toast = useToast();
  const manage = can('tasks.manage');
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState(window.matchMedia('(max-width: 640px)').matches ? 'list' : 'board');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ status: '', priority: '', assignee_id: '' });
  const [form, setForm] = useState(null);
  const [dragged, setDragged] = useState(null);
  const [over, setOver] = useState(null);
  const [confirm, confirmDialog] = useConfirm();
  const q = useDebounced(search);
  const { data, loading, error, reload, setData } = useApi('/tasks', { search: q, ...filters });
  const tasks = data?.tasks || [];

  useEffect(() => {
    const id = Number(params.get('task'));
    if (!id || !data) return;
    const t = tasks.find((x) => x.id === id);
    if (t && manage) setForm(t);
    else if (t) setSearch(t.title);
    setParams({}, { replace: true });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStatus = async (t, status) => {
    if (t.status === status) return;
    const prev = tasks;
    setData((d) => ({ ...d, tasks: d.tasks.map((x) => (x.id === t.id ? { ...x, status } : x)) }));
    try { const r = await api.patch(`/tasks/${t.id}/status`, { status }); toast.success(r.message); } catch (e) { setData((d) => ({ ...d, tasks: prev })); toast.error(e); }
  };

  const remove = (t) => confirm({
    title: 'למחוק את המשימה?', message: `המשימה "${t.title}" תימחק לצמיתות.`, confirmText: 'מחיקה',
    onConfirm: async () => { try { const r = await api.del(`/tasks/${t.id}`); toast.success(r.message); reload({ silent: true }); } catch (e) { toast.error(e); throw e; } },
  });

  const isMine = (t) => t.assignee_id && t.assignee_id === user.employee_id;
  const canMove = (t) => manage || isMine(t);

  const card = (t) => (
    <div key={t.id} className={`card task-card ${dragged?.id === t.id ? 'dragging' : ''}`} draggable={canMove(t)}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', String(t.id)); setDragged(t); }} onDragEnd={() => { setDragged(null); setOver(null); }}
      style={{ cursor: canMove(t) ? 'grab' : 'default', opacity: t.status === 'cancelled' ? 0.6 : 1 }}>
      <div className="flex between" style={{ alignItems: 'flex-start' }}>
        <strong style={{ textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</strong>
        <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge>
      </div>
      {t.description && <p className="muted" style={{ fontSize: '.87rem' }}>{t.description}</p>}
      <div className="flex between flex-wrap">
        {t.assignee_name ? <span className="flex" style={{ gap: 6, fontSize: '.85rem' }}><Avatar name={t.assignee_name} src={t.assignee_avatar} size={22} />{t.assignee_name}</span> : <span className="subtle flex" style={{ gap: 4 }}><User size={14} />ללא אחראי</span>}
        <DueLabel date={t.due_date} status={t.status} />
      </div>
      <div className="flex between">
        <span className="subtle">נוצרה ע״י {t.created_by_name || '—'}</span>
        <div className="flex" style={{ gap: 2 }}>
          {canMove(t) && t.status === 'new' && <Button size="sm" variant="ghost" icon={Play} onClick={() => setStatus(t, 'in_progress')}>התחלה</Button>}
          {canMove(t) && ['new', 'in_progress'].includes(t.status) && <Button size="sm" variant="ghost" icon={Check} onClick={() => setStatus(t, 'done')}>הושלם</Button>}
          {manage && <IconButton icon={Pencil} label="עריכה" small onClick={() => setForm(t)} />}
          {manage && <IconButton icon={Trash2} label="מחיקה" small onClick={() => remove(t)} />}
        </div>
      </div>
    </div>
  );

  const hasFilters = q || filters.status || filters.priority || filters.assignee_id;

  return (
    <>
      <PageHeader title={manage ? 'משימות' : 'המשימות שלי'} subtitle={data ? `${tasks.filter((t) => ['new', 'in_progress'].includes(t.status)).length} משימות פתוחות` : undefined}
        actions={manage && <Button variant="primary" icon={Plus} onClick={() => setForm({})}>משימה חדשה</Button>} />
      <div className="toolbar">
        <div className="input-icon"><Search size={17} /><Input placeholder="חיפוש משימה" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="חיפוש משימה" /></div>
        {view === 'list' && <Select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))} aria-label="סטטוס"><option value="">כל הסטטוסים</option><option value="open">פתוחות</option>{Object.entries(TASK_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select>}
        <Select value={filters.priority} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))} aria-label="עדיפות"><option value="">כל העדיפויות</option>{Object.entries(PRIORITY).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</Select>
        {manage && <Select value={filters.assignee_id} onChange={(e) => setFilters((f) => ({ ...f, assignee_id: e.target.value }))} aria-label="עובד"><option value="">כל העובדים</option>{meta.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select>}
        <div style={{ marginInlineStart: 'auto' }}><Segmented value={view} onChange={setView} options={[{ value: 'board', label: 'לוח', icon: LayoutGrid }, { value: 'list', label: 'רשימה', icon: List }]} /></div>
      </div>

      {error ? <div className="card"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? <div className="card"><SkeletonRows /></div> : !tasks.length ? (
        <div className="card">
          {hasFilters ? <EmptyState icon={Search} title="לא נמצאו משימות" text="נסו לשנות את החיפוש או הסינון." />
            : <EmptyState icon={ListTodo} title={manage ? 'אין משימות עדיין' : 'אין לך משימות כרגע'} text={manage ? 'צרו משימה והקצו אותה לעובד – הוא יקבל התראה מיידית.' : 'משימות שיוקצו לך יופיעו כאן.'} action={manage && <Button variant="primary" icon={Plus} onClick={() => setForm({})}>משימה חדשה</Button>} />}
        </div>
      ) : view === 'board' ? (
        <div className="kanban">
          {Object.entries(TASK_STATUS).map(([status, s]) => {
            const col = tasks.filter((t) => t.status === status);
            return (
              <div key={status} className={`kanban-col ${over === status ? 'drop-target' : ''}`}
                onDragOver={(e) => { if (dragged && (manage || status !== 'cancelled')) { e.preventDefault(); setOver(status); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(null); }}
                onDrop={(e) => { e.preventDefault(); setOver(null); if (dragged) setStatus(dragged, status); setDragged(null); }}>
                <div className="kanban-head"><span className="flex"><StatusBadge map={TASK_STATUS} value={status} /></span><span className="subtle">{col.length}</span></div>
                {col.map(card)}
                {!col.length && <div className="subtle" style={{ textAlign: 'center', padding: 20 }}>אין משימות</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{tasks.map(card)}</div>
      )}
      {manage && <button type="button" className="fab" aria-label="משימה חדשה" onClick={() => setForm({})}><Plus size={24} /></button>}
      {form && <TaskForm task={form.id ? form : null} onClose={() => setForm(null)} onSaved={() => reload({ silent: true })} />}
      {confirmDialog}
    </>
  );
}
