import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Plus, Search, Pencil, Trash2, UserX, UserCheck, Users, Download, MoreVertical, Link2 } from 'lucide-react';
import { useApi, useDebounced } from '../lib/hooks.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Button, Card, EmptyState, ErrorState, IconButton, Input, PageHeader, Person, Select, SkeletonRows, SortHeader, StatusBadge, useConfirm,
} from '../components/ui.jsx';
import EmployeeForm from '../components/EmployeeForm.jsx';
import InviteModal from '../components/InviteModal.jsx';
import { EMPLOYEE_STATUS, fullDate, money } from '../lib/format.js';

export default function Employees() {
  const { meta, can, user } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ department_id: '', position_id: '', status: '', location_id: '' });
  const [sort, setSort] = useState({ field: 'name', dir: 'asc' });
  const [form, setForm] = useState(null); // null | {} (new) | employee
  const [inviting, setInviting] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const q = useDebounced(search);
  const { data, loading, error, reload } = useApi('/employees', { search: q, ...filters, sort: sort.field, dir: sort.dir });
  const employees = data?.employees || [];
  const showWage = can('employees.wage');
  const canManage = can('employees.manage');

  const onSort = (field) => setSort((s) => ({ field, dir: s.field === field && s.dir === 'asc' ? 'desc' : 'asc' }));
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const hasFilters = q || filters.department_id || filters.position_id || filters.status || filters.location_id;
  const branchOptions = user?.scope && !user.scope.all ? user.scope.branches : meta.locations;

  const toggleStatus = (e) => {
    const next = e.status === 'inactive' ? 'active' : 'inactive';
    confirm({
      title: next === 'inactive' ? `להשבית את ${e.full_name}?` : `להפעיל מחדש את ${e.full_name}?`,
      message: next === 'inactive' ? 'העובד לא יוכל להתחבר למערכת עד שיופעל מחדש. ההיסטוריה שלו תישמר.' : 'העובד יוכל להתחבר ולהשתבץ למשמרות.',
      confirmText: next === 'inactive' ? 'השבתה' : 'הפעלה',
      danger: next === 'inactive',
      onConfirm: async () => {
        try { await api.patch(`/employees/${e.id}/status`, { status: next }); toast.success(next === 'inactive' ? 'העובד הושבת' : 'העובד הופעל מחדש'); reload({ silent: true }); } catch (err) { toast.error(err); throw err; }
      },
    });
  };

  const remove = (e) => confirm({
    title: `למחוק את ${e.full_name}?`,
    message: 'הפעולה תמחק את העובד, המשמרות, הנוכחות והבקשות שלו לצמיתות. מומלץ להשבית במקום למחוק. לא ניתן לבטל פעולה זו.',
    confirmText: 'מחיקה לצמיתות',
    onConfirm: async () => {
      try { await api.del(`/employees/${e.id}`); toast.success('העובד נמחק'); reload({ silent: true }); } catch (err) { toast.error(err); throw err; }
    },
  });

  const exportCsv = () => {
    const cols = [['employee_code', 'מזהה'], ['full_name', 'שם'], ['phone', 'טלפון'], ['email', 'אימייל'], ['position_name', 'תפקיד'], ['department_name', 'מחלקה'], ['start_date', 'תחילת עבודה'], ['status', 'סטטוס'], ...(showWage ? [['hourly_wage', 'שכר שעתי']] : [])];
    const esc = (x) => { let s = String(x ?? ''); if (/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [cols.map((c) => c[1]).join(','), ...employees.map((e) => cols.map(([k]) => esc(k === 'status' ? EMPLOYEE_STATUS[e.status].label : e[k])).join(','))];
    const url = URL.createObjectURL(new Blob([`﻿${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'employees.csv' });
    a.click();
    URL.revokeObjectURL(url);
  };

  const actions = (e) => canManage && (
    <div className="row-actions" onClick={(ev) => ev.stopPropagation()}>
      <IconButton icon={Pencil} label="עריכה" small onClick={() => setForm(e)} />
      <IconButton icon={e.status === 'inactive' ? UserCheck : UserX} label={e.status === 'inactive' ? 'הפעלה' : 'השבתה'} small onClick={() => toggleStatus(e)} />
      {can('employees.delete') && <IconButton icon={Trash2} label="מחיקה" small onClick={() => remove(e)} style={{ color: 'var(--danger)' }} />}
    </div>
  );

  return (
    <>
      <PageHeader title="עובדים" subtitle={data ? `${employees.length} עובדים${hasFilters ? ' (מסונן)' : ''}` : 'ניהול כוח האדם בעסק'}
        actions={(
          <>
            <Button icon={Download} onClick={exportCsv} disabled={!employees.length}><span className="btn-label">ייצוא</span></Button>
            {canManage && <Button icon={Link2} onClick={() => setInviting(true)}><span className="btn-label">הזמנה בקישור</span></Button>}
            {canManage && <Button variant="primary" icon={Plus} onClick={() => setForm({})}>הוספת עובד</Button>}
          </>
        )} />

      <div className="toolbar">
        <div className="input-icon"><Search size={17} /><Input placeholder="חיפוש לפי שם, מזהה, טלפון או אימייל" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="חיפוש עובד" /></div>
        {branchOptions.length > 1 && <Select value={filters.location_id} onChange={setF('location_id')} aria-label="סניף"><option value="">כל הסניפים</option>{branchOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}
        <Select value={filters.department_id} onChange={setF('department_id')} aria-label="מחלקה"><option value="">כל המחלקות</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
        <Select value={filters.position_id} onChange={setF('position_id')} aria-label="תפקיד"><option value="">כל התפקידים</option>{meta.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Select value={filters.status} onChange={setF('status')} aria-label="סטטוס"><option value="">כל הסטטוסים</option>{Object.entries(EMPLOYEE_STATUS).map(([k, s]) => <option key={k} value={k}>{s.label}</option>)}</Select>
        {hasFilters && <Button variant="ghost" onClick={() => { setSearch(''); setFilters({ department_id: '', position_id: '', status: '', location_id: '' }); }}>ניקוי</Button>}
      </div>

      <Card pad={false}>
        {error ? <ErrorState error={error} onRetry={reload} /> : loading && !data ? <SkeletonRows rows={8} /> : !employees.length ? (
          hasFilters
            ? <EmptyState icon={Search} title="לא נמצאו עובדים" text="נסו לשנות את החיפוש או את הסינון." />
            : <EmptyState icon={Users} title="עדיין אין עובדים" text="הוסיפו את העובד הראשון כדי להתחיל לבנות סידור עבודה." action={canManage && <Button variant="primary" icon={Plus} onClick={() => setForm({})}>הוספת עובד</Button>} />
        ) : (
          <>
            <div className="table-wrap desktop-table">
              <table className="table">
                <thead>
                  <tr>
                    <SortHeader label="עובד" field="name" sort={sort} onSort={onSort} />
                    <SortHeader label="מזהה" field="code" sort={sort} onSort={onSort} />
                    <th>טלפון</th>
                    <SortHeader label="תפקיד" field="position" sort={sort} onSort={onSort} />
                    <SortHeader label="מחלקה" field="department" sort={sort} onSort={onSort} />
                    <SortHeader label="תחילת עבודה" field="start_date" sort={sort} onSort={onSort} />
                    <SortHeader label="סטטוס" field="status" sort={sort} onSort={onSort} />
                    {showWage && <SortHeader label="שכר שעתי" field="wage" sort={sort} onSort={onSort} />}
                    {canManage && <th />}
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => navigate(`/employees/${e.id}`)}>
                      <td><Person name={e.full_name} avatar={e.avatar} sub={e.email} /></td>
                      <td className="ltr subtle">{e.employee_code}</td>
                      <td><span className="ltr">{e.phone || '—'}</span></td>
                      <td>{e.position_name || '—'}</td>
                      <td>{e.department_name ? <span className="flex" style={{ gap: 6 }}><i style={{ width: 8, height: 8, borderRadius: 4, background: e.department_color }} />{e.department_name}</span> : '—'}</td>
                      <td className="nowrap">{fullDate(e.start_date)}</td>
                      <td><StatusBadge map={EMPLOYEE_STATUS} value={e.status} /></td>
                      {showWage && <td>{e.hourly_wage != null ? money(e.hourly_wage, meta.settings.currency) : '—'}</td>}
                      {canManage && <td>{actions(e)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-list">
              {employees.map((e) => (
                <div key={e.id} className="list-item" role="button" tabIndex={0} onClick={() => navigate(`/employees/${e.id}`)}>
                  <div className="grow"><Person name={e.full_name} avatar={e.avatar} sub={[e.position_name, e.department_name].filter(Boolean).join(' · ')} size={42} /></div>
                  <StatusBadge map={EMPLOYEE_STATUS} value={e.status} />
                  {canManage && <IconButton icon={MoreVertical} label="עריכה" small onClick={(ev) => { ev.stopPropagation(); setForm(e); }} />}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
      {canManage && <button type="button" className="fab" aria-label="הוספת עובד" onClick={() => setForm({})}><Plus size={24} /></button>}
      {form && <EmployeeForm open onClose={() => setForm(null)} employee={form.id ? form : null} onSaved={() => reload({ silent: true })} onDeleted={() => reload({ silent: true })} />}
      {inviting && <InviteModal onClose={() => { setInviting(false); reload({ silent: true }); }} />}
      {confirmDialog}
    </>
  );
}
