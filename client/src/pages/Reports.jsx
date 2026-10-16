import { useState } from 'react';
import { FileSpreadsheet, FileText, Printer, Clock, Timer, AlertTriangle, UserX, CalendarDays, Wallet, BarChart3, Users } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { download } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import {
  Button, Card, EmptyState, ErrorState, Field, Input, KpiCard, PageHeader, Segmented, Select, SkeletonPage, SortHeader,
} from '../components/ui.jsx';
import { HoursBar } from '../components/Charts.jsx';
import { addDays, addMonths, dayName, endOfMonth, fullDate, localToday, money, shortDate, startOfMonth, startOfWeek } from '../lib/format.js';

const PRESETS = {
  month: () => { const t = localToday(); return { from: startOfMonth(t), to: endOfMonth(t) }; },
  last_month: () => { const m = addMonths(localToday(), -1); return { from: m, to: endOfMonth(m) }; },
  week: () => { const s = startOfWeek(localToday()); return { from: s, to: addDays(s, 6) }; },
  quarter: () => ({ from: addMonths(localToday(), -2).slice(0, 8) + '01', to: endOfMonth(localToday()) }),
};

export default function Reports() {
  const { meta, can } = useAuth();
  const toast = useToast();
  const [preset, setPreset] = useState('month');
  const [range, setRange] = useState(PRESETS.month());
  const [filters, setFilters] = useState({ employee_id: '', department_id: '', position_id: '' });
  const [sort, setSort] = useState({ field: 'hours', dir: 'desc' });
  const [exporting, setExporting] = useState(null);
  const query = { ...range, ...filters };
  const { data, loading, error, reload } = useApi('/reports', query);
  const showCost = can('employees.wage');
  const cur = meta.settings.currency;

  const choose = (p) => { setPreset(p); if (PRESETS[p]) setRange(PRESETS[p]()); };
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const exp = async (format) => {
    setExporting(format);
    try { await download('/reports/export', { ...query, format }, `report_${range.from}_${range.to}.${format}`); toast.success('הקובץ הורד בהצלחה'); } catch (e) { toast.error(e); } finally { setExporting(null); }
  };

  const rows = [...(data?.employees || [])].sort((a, b) => {
    const av = a[sort.field]; const bv = b[sort.field];
    const r = typeof av === 'string' ? av.localeCompare(bv, 'he') : (av || 0) - (bv || 0);
    return sort.dir === 'asc' ? r : -r;
  });
  const onSort = (field) => setSort((s) => ({ field, dir: s.field === field && s.dir === 'desc' ? 'asc' : 'desc' }));
  const t = data?.totals;

  return (
    <>
      <PageHeader title="מרכז דוחות" subtitle="נתוני שעות, נוכחות ועלויות – מחושבים ממשמרות ורישומי נוכחות בפועל"
        actions={(
          <>
            <Button icon={FileSpreadsheet} onClick={() => exp('xlsx')} loading={exporting === 'xlsx'} disabled={!data}>Excel</Button>
            <Button icon={FileText} onClick={() => exp('csv')} loading={exporting === 'csv'} disabled={!data}>CSV</Button>
            <Button icon={Printer} onClick={() => window.print()} disabled={!data}>PDF</Button>
          </>
        )} />

      <div className="print-only" style={{ marginBottom: 16 }}>
        <h1>{meta.settings.business_name} – דוח שעות ונוכחות</h1>
        <p>תקופה: {fullDate(range.from)} – {fullDate(range.to)}</p>
      </div>

      <div className="card card-pad mb no-print">
        <div className="flex flex-wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <Field label="תקופה">
            <Segmented value={preset} onChange={choose} options={[{ value: 'week', label: 'השבוע' }, { value: 'month', label: 'החודש' }, { value: 'last_month', label: 'חודש קודם' }, { value: 'quarter', label: '3 חודשים' }, { value: 'custom', label: 'מותאם' }]} />
          </Field>
          <Field label="מתאריך"><Input type="date" value={range.from} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, from: e.target.value })); }} /></Field>
          <Field label="עד תאריך"><Input type="date" value={range.to} min={range.from} onChange={(e) => { setPreset('custom'); setRange((r) => ({ ...r, to: e.target.value })); }} /></Field>
          <Field label="עובד"><Select value={filters.employee_id} onChange={setF('employee_id')}><option value="">כל העובדים</option>{meta.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
          <Field label="מחלקה"><Select value={filters.department_id} onChange={setF('department_id')}><option value="">כל המחלקות</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
          <Field label="תפקיד"><Select value={filters.position_id} onChange={setF('position_id')}><option value="">כל התפקידים</option>{meta.positions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        </div>
      </div>

      {error ? <div className="card"><ErrorState error={error} onRetry={reload} /></div> : loading && !data ? <SkeletonPage /> : (
        <>
          <div className="kpis">
            <KpiCard label="שעות עבודה כוללות" value={t.hours.toLocaleString('he-IL')} icon={Clock} tone="primary" hint={`מתוך ${t.planned_hours.toLocaleString('he-IL')} מתוכננות`} />
            <KpiCard label="שעות נוספות" value={t.overtime_hours} icon={Timer} tone="info" />
            <KpiCard label="איחורים" value={t.late_count} icon={AlertTriangle} tone="warning" />
            <KpiCard label="היעדרויות" value={t.absences} icon={UserX} tone="danger" />
            <KpiCard label="כמות משמרות" value={t.shifts} icon={CalendarDays} tone="neutral" hint={`${t.employees} עובדים`} />
            {showCost && <KpiCard label="עלות שכר משוערת" value={money(t.estimated_cost, cur)} icon={Wallet} tone="success" hint="כולל 125% על שעות נוספות" />}
          </div>
          <div className="grid grid-2 mb">
            <Card title="שעות לפי יום" icon={BarChart3}><HoursBar data={data.daily} xKey="date" tickFormatter={shortDate} labelFormatter={(d) => `${dayName(d)} ${shortDate(d)}`} /></Card>
            <Card title="שעות לפי עובד" icon={Users}><HoursBar data={rows.slice(0, 12).map((r) => ({ name: r.employee_name, hours: r.hours }))} xKey="name" horizontal /></Card>
          </div>
          <Card title="פירוט לפי עובד" icon={Users} pad={false}>
            {!rows.length ? <EmptyState icon={BarChart3} title="אין נתונים לתקופה שנבחרה" text="נסו לבחור טווח תאריכים אחר או להסיר סינונים." /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <SortHeader label="עובד" field="employee_name" sort={sort} onSort={onSort} />
                      <th className="hide-sm">מחלקה</th>
                      <SortHeader label="משמרות" field="shifts" sort={sort} onSort={onSort} />
                      <SortHeader label="שעות" field="hours" sort={sort} onSort={onSort} />
                      <SortHeader label="נוספות" field="overtime_hours" sort={sort} onSort={onSort} />
                      <SortHeader label="איחורים" field="late_count" sort={sort} onSort={onSort} />
                      <SortHeader label="היעדרויות" field="absences" sort={sort} onSort={onSort} />
                      {showCost && <SortHeader label="עלות משוערת" field="estimated_cost" sort={sort} onSort={onSort} />}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.employee_id}>
                        <td><strong>{r.employee_name}</strong><div className="subtle">{r.position_name}</div></td>
                        <td className="hide-sm">{r.department_name || '—'}</td>
                        <td>{r.shifts}</td>
                        <td><strong>{r.hours}</strong></td>
                        <td>{r.overtime_hours || '—'}</td>
                        <td style={{ color: r.late_count ? 'var(--warning)' : undefined }}>{r.late_count || '—'}{r.late_minutes > 0 && <div className="subtle">{r.late_minutes} דק׳</div>}</td>
                        <td style={{ color: r.absences ? 'var(--danger)' : undefined }}>{r.absences || '—'}</td>
                        {showCost && <td>{money(r.estimated_cost, cur)}</td>}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 800 }}>
                      <td style={{ padding: '12px 16px' }}>סה״כ</td><td className="hide-sm" /><td>{t.shifts}</td><td>{t.hours}</td><td>{t.overtime_hours}</td><td>{t.late_count}</td><td>{t.absences}</td>
                      {showCost && <td>{money(t.estimated_cost, cur)}</td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}
