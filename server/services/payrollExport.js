// Excel / CSV files for the accountant (whole business) and the personal hours slip (one employee).
import ExcelJS from 'exceljs';
import { BUCKETS } from './payroll.js';
import { getSetting } from './settings.js';

const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dayName = (d) => DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
const h = (min) => +(min / 60).toFixed(2);
const hm = (s) => (s ? s.slice(11, 16) : '');
// Prevent CSV/Excel formula injection
const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v ?? '');

function summaryColumns(data, includeWage) {
  return [
    { header: 'מס׳ עובד', value: (e) => e.employee_code, width: 11 },
    { header: 'שם', value: (e) => e.employee_name, width: 20 },
    { header: 'ת.ז.', value: (e) => e.national_id, width: 12 },
    { header: 'מחלקה', value: (e) => e.department_name, width: 14 },
    { header: 'ימי עבודה', value: (e) => e.days_worked, width: 10 },
    { header: 'סה״כ שעות', value: (e) => h(e.total_minutes), width: 11 },
    ...BUCKETS.map((b) => ({ header: data.labels[b], value: (e) => h(e.buckets[b]), width: 13 })),
    { header: 'היעדרויות', value: (e) => e.absences, width: 10 },
    { header: 'איחורים', value: (e) => e.late_count, width: 9 },
    ...(includeWage ? [
      { header: 'שכר שעתי', value: (e) => e.hourly_wage, width: 10 },
      { header: 'ברוטו משוער', value: (e) => e.gross, width: 12 },
    ] : []),
  ];
}

const dayColumns = (data, withEmployee) => [
  ...(withEmployee ? [{ header: 'עובד', width: 20 }, { header: 'ת.ז.', width: 12 }] : []),
  { header: 'תאריך', width: 12 }, { header: 'יום', width: 8 }, { header: 'חג / מנוחה', width: 16 },
  { header: 'משמרת מתוכננת', width: 14 }, { header: 'כניסה', width: 8 }, { header: 'יציאה', width: 8 },
  { header: 'שעות', width: 8 }, ...BUCKETS.map((b) => ({ header: data.labels[b], width: 13 })), { header: 'הערות', width: 24 },
];

function dayRows(e, withEmployee) {
  const out = [];
  for (const d of e.days) {
    d.shifts.forEach((s, i) => {
      const notes = [s.absent ? 'היעדרות' : '', s.late_minutes ? `איחור ${s.late_minutes} דק׳` : '', s.note].filter(Boolean).join(' · ');
      out.push([
        ...(withEmployee ? [e.employee_name, e.national_id] : []),
        d.date, dayName(d.date), d.holiday || (d.rest_day ? 'יום מנוחה' : ''),
        s.planned, hm(s.clock_in_at), hm(s.clock_out_at),
        i === 0 ? h(d.worked_minutes) : '', ...BUCKETS.map((b) => (i === 0 ? h(d.buckets[b]) || '' : '')), notes,
      ]);
    });
  }
  return out;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }; c.alignment = { wrapText: true, vertical: 'middle' }; });
}

function addTitle(ws, title, subtitle) {
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([subtitle]);
  ws.addRow(['חישוב השעות הנוספות לפי ההגדרות במערכת – לאימות סופי מול רואה החשבון']).font = { italic: true, color: { argb: 'FF6B7280' } };
  ws.addRow([]);
}

/** Workbook: summary sheet + per-day detail. `single` → personal slip layout. */
export async function payrollWorkbook(data, { includeWage, single = false, period }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = getSetting('business_name');
  const biz = getSetting('business_name');
  if (single) {
    const e = data.employees[0];
    const ws = wb.addWorksheet('תלוש שעות', { views: [{ rightToLeft: true }] });
    addTitle(ws, `${biz} – תלוש שעות ${period}`, `${e?.employee_name || ''}${e?.national_id ? ` · ת.ז. ${e.national_id}` : ''}${e?.employee_code ? ` · ${e.employee_code}` : ''}`);
    if (e) {
      ws.addRow(['ימי עבודה', e.days_worked]);
      ws.addRow(['סה״כ שעות', h(e.total_minutes)]);
      for (const b of BUCKETS) if (e.buckets[b]) ws.addRow([data.labels[b], h(e.buckets[b])]);
      ws.addRow(['היעדרויות', e.absences]);
      ws.addRow(['איחורים', e.late_count]);
      ws.addRow([]);
      const cols = dayColumns(data, false);
      styleHeader(ws.addRow(cols.map((c) => c.header)));
      for (const r of dayRows(e, false)) ws.addRow(r.map(safe));
      cols.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(c.width, i === 0 ? 16 : 0); });
    }
    return wb;
  }
  const cols = summaryColumns(data, includeWage);
  const ws = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 5 }] });
  addTitle(ws, `${biz} – דוח שעות חודשי לרואה חשבון`, `תקופה: ${data.from} עד ${data.to}`);
  styleHeader(ws.addRow(cols.map((c) => c.header)));
  for (const e of data.employees) ws.addRow(cols.map((c) => safe(c.value(e))));
  const total = ws.addRow(cols.map((c, i) => {
    if (i === 1) return 'סה״כ';
    if (['ימי עבודה', 'סה״כ שעות', 'היעדרויות', 'איחורים', 'ברוטו משוער'].includes(c.header) || BUCKETS.some((b) => data.labels[b] === c.header)) {
      return +data.employees.reduce((t, e) => t + (Number(c.value(e)) || 0), 0).toFixed(2);
    }
    return '';
  }));
  total.font = { bold: true };
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  const det = wb.addWorksheet('פירוט יומי', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  const dcols = dayColumns(data, true);
  styleHeader(det.addRow(dcols.map((c) => c.header)));
  for (const e of data.employees) for (const r of dayRows(e, true)) det.addRow(r.map(safe));
  dcols.forEach((c, i) => { det.getColumn(i + 1).width = c.width; });
  return wb;
}

/** CSV of the summary (one row per employee), with a BOM so Excel shows Hebrew. */
export function payrollCsv(data, { includeWage }) {
  const cols = summaryColumns(data, includeWage);
  const esc = (v) => { const s = String(safe(v)); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.map((c) => esc(c.header)).join(',')];
  for (const e of data.employees) lines.push(cols.map((c) => esc(c.value(e))).join(','));
  return `﻿${lines.join('\r\n')}`;
}

export function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`);
  return wb.xlsx.write(res).then(() => res.end());
}

/** JSON-safe slip for the UI: drop internal fields. */
export function slipJson(data) {
  return {
    from: data.from, to: data.to, labels: data.labels, rates: data.rates,
    employee: data.employees[0] ? (({ days, ...rest }) => ({ ...rest, days }))(data.employees[0]) : null,
  };
}
