import { useState } from 'react';
import { FileSpreadsheet, Printer, ChevronRight, ChevronLeft, Clock, CalendarDays, Timer, UserX, Receipt } from 'lucide-react';
import { useApi } from '../lib/hooks.js';
import { download } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useToast } from '../lib/toast.jsx';
import { Button, Card, EmptyState, ErrorState, Field, IconButton, KpiCard, PageHeader, Select, SkeletonPage } from '../components/ui.jsx';
import { dayName, localToday, shortDate, time } from '../lib/format.js';

const BUCKETS = ['regular', 'ot1', 'ot2', 'rest', 'rest_ot1', 'rest_ot2'];
const hrs = (m) => (m ? (m / 60).toLocaleString('he-IL', { maximumFractionDigits: 2 }) : '—');
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const shiftMonth = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return d.toISOString().slice(0, 7); };

/** Monthly hours slip: summary by pay rate + day-by-day detail. Employees see their own; managers can pick anyone. */
export default function MyHours() {
  const { user, can, meta } = useAuth();
  const toast = useToast();
  const manager = can('reports.view');
  const [month, setMonth] = useState(localToday().slice(0, 7));
  const [empId, setEmpId] = useState(user.employee_id ? '' : String(meta.employees[0]?.id || ''));
  const [busy, setBusy] = useState(false);
  const own = !empId;
  const path = own ? (user.employee_id ? '/attendance/me/slip' : null) : '/reports/slip';
  const query = own ? { month } : { month, employee_id: empId };
  const { data, loading, error, reload } = useApi(path, query);
  const thisMonth = localToday().slice(0, 7);

  const exportXlsx = async () => {
    setBusy(true);
    try { await download(path, { ...query, format: 'xlsx' }, `hours_${month}.xlsx`); toast.success('הקובץ הורד'); } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const e = data?.employee;
  return (
    <>
      <PageHeader title="תלוש שעות" subtitle="סיכום השעות החודשי לפי סוגי תעריף, ופירוט יום אחר יום"
        actions={<>
          <Button icon={FileSpreadsheet} onClick={exportXlsx} loading={busy} disabled={!e}>הורדה לאקסל</Button>
          <Button icon={Printer} onClick={() => window.print()} disabled={!e}>הדפסה / PDF</Button>
        </>} />
      <div className="card card-pad mb no-print">
        <div className="flex flex-wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <Field label="חודש">
            <div className="month-nav">
              <IconButton icon={ChevronRight} label="החודש הקודם" onClick={() => setMonth((m) => shiftMonth(m, -1))} />
              <strong>{monthLabel(month)}</strong>
              <IconButton icon={ChevronLeft} label="החודש הבא" onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= thisMonth} />
            </div>
          </Field>
          {manager && (
            <Field label="עובד">
              <Select value={empId} onChange={(ev) => setEmpId(ev.target.value)}>
                {user.employee_id && <option value="">אני</option>}
                {meta.employees.filter((x) => x.id !== user.employee_id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
      </div>

      <div className="print-only" style={{ marginBottom: 12 }}>
        <h1>{meta.settings.business_name} – תלוש שעות {monthLabel(month)}</h1>
        {e && <p>{e.employee_name}{e.national_id ? ` · ת.ז. ${e.national_id}` : ''} · {e.employee_code}</p>}
      </div>

      {!path ? <div className="card"><EmptyState icon={Receipt} title="אין כרטיס עובד משויך" text="בחר/י עובד מהרשימה." /></div>
        : error ? <div className="card"><ErrorState error={error} onRetry={reload} /></div>
          : loading && !data ? <SkeletonPage />
            : !e || !e.days.length ? <div className="card"><EmptyState icon={CalendarDays} title="אין משמרות בחודש הזה" text="כשיהיו משמרות ורישומי נוכחות, הם יופיעו כאן." /></div>
              : (
                <>
                  <div className="kpis">
                    <KpiCard label="סה״כ שעות" value={hrs(e.total_minutes)} icon={Clock} tone="primary" />
                    <KpiCard label="ימי עבודה" value={e.days_worked} icon={CalendarDays} tone="neutral" />
                    <KpiCard label="שעות נוספות" value={hrs(e.overtime_minutes)} icon={Timer} tone="info" />
                    <KpiCard label="היעדרויות" value={e.absences} icon={UserX} tone="danger" hint={e.late_count ? `${e.late_count} איחורים` : undefined} />
                  </div>
                  <Card title="לפי תעריף" className="mb">
                    <div className="slip-buckets">
                      {BUCKETS.filter((b) => e.buckets[b] > 0 || b === 'regular').map((b) => (
                        <div key={b} className="slip-bucket"><span className="subtle">{data.labels[b]}</span><strong>{hrs(e.buckets[b])}</strong></div>
                      ))}
                    </div>
                    <p className="subtle" style={{ margin: '12px 0 0' }}>החישוב לפי ההגדרות במערכת. במקרה של אי-התאמה, התלוש הרשמי מהנהלת החשבונות הוא הקובע.</p>
                  </Card>
                  <Card title="פירוט יומי" pad={false}>
                    <div className="table-wrap">
                      <table className="table slip-table">
                        <thead><tr><th>תאריך</th><th>מתוכנן</th><th>כניסה</th><th>יציאה</th><th>שעות</th><th>נוספות</th><th>הערות</th></tr></thead>
                        <tbody>
                          {e.days.flatMap((d) => d.shifts.map((s, i) => {
                            const ot = d.buckets.ot1 + d.buckets.ot2 + d.buckets.rest_ot1 + d.buckets.rest_ot2;
                            const tags = [d.holiday || (d.rest_day ? 'יום מנוחה' : ''), s.absent ? 'היעדרות' : '', s.late_minutes ? `איחור ${s.late_minutes} דק׳` : ''].filter(Boolean);
                            return (
                              <tr key={s.shift_id} className={d.rest_day ? 'is-rest' : ''}>
                                <td className="nowrap">{i === 0 ? <>{dayName(d.date)} <span className="ltr">{shortDate(d.date)}</span></> : ''}</td>
                                <td><span className="ltr">{s.planned}</span></td>
                                <td><span className="ltr">{time(s.clock_in_at)}</span></td>
                                <td><span className="ltr">{time(s.clock_out_at)}</span></td>
                                <td>{i === 0 ? hrs(d.worked_minutes) : ''}</td>
                                <td>{i === 0 && ot ? hrs(ot) : ''}</td>
                                <td className="subtle">{tags.join(' · ')}</td>
                              </tr>
                            );
                          }))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                </>
              )}
    </>
  );
}
