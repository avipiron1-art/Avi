import { Router } from 'express';
import ExcelJS from 'exceljs';
import { ah, badRequest } from '../lib/errors.js';
import { validate, z, zDate, zOptId } from '../lib/validate.js';
import { buildReport } from '../services/reports.js';
import { audit } from '../services/audit.js';
import { getSetting } from '../services/settings.js';
import { addDays } from '../lib/time.js';

const router = Router();

const filtersSchema = z.object({
  from: zDate, to: zDate, employee_id: zOptId, department_id: zOptId, position_id: zOptId,
  format: z.enum(['xlsx', 'csv']).optional(),
});

function parseFilters(query) {
  const f = validate(filtersSchema, query);
  if (f.to < f.from) throw badRequest('תאריך הסיום חייב להיות אחרי תאריך ההתחלה');
  if (addDays(f.from, 370) < f.to) throw badRequest('ניתן להפיק דוח לתקופה של עד שנה');
  return f;
}

router.get('/', ah((req, res) => {
  const f = parseFilters(req.query);
  res.json(buildReport(f, { includeCost: req.can('employees.wage') }));
}));

function columns(includeCost) {
  return [
    { key: 'employee_code', header: 'מזהה' },
    { key: 'employee_name', header: 'עובד' },
    { key: 'department_name', header: 'מחלקה' },
    { key: 'position_name', header: 'תפקיד' },
    { key: 'shifts', header: 'משמרות' },
    { key: 'planned_hours', header: 'שעות מתוכננות' },
    { key: 'hours', header: 'שעות בפועל' },
    { key: 'overtime_hours', header: 'שעות נוספות' },
    { key: 'late_count', header: 'איחורים' },
    { key: 'late_minutes', header: 'דקות איחור' },
    { key: 'absences', header: 'היעדרויות' },
    { key: 'early_leaves', header: 'יציאות מוקדמות' },
    ...(includeCost ? [{ key: 'hourly_wage', header: 'שכר שעתי' }, { key: 'estimated_cost', header: 'עלות משוערת' }] : []),
  ];
}

// Prevent CSV/Excel formula injection
const safeCell = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v ?? '');

router.get('/export', ah(async (req, res) => {
  const f = parseFilters(req.query);
  const includeCost = req.can('employees.wage');
  const report = buildReport(f, { includeCost });
  const cols = columns(includeCost);
  const filename = `report_${f.from}_${f.to}`;
  audit(req, { action: 'report.export', entityType: 'report', description: `${req.user.display_name} ייצא/ה דוח ${f.format === 'csv' ? 'CSV' : 'Excel'} לתקופה ${f.from} – ${f.to}`, newValue: f });

  if (f.format === 'csv') {
    const esc = (v) => { const s = String(safeCell(v)); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map((c) => esc(c.header)).join(',')];
    for (const e of report.employees) lines.push(cols.map((c) => esc(e[c.key])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(`﻿${lines.join('\r\n')}`); // BOM so Excel shows Hebrew correctly
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = getSetting('business_name');
  const ws = wb.addWorksheet('דוח שעות', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 4 }] });
  ws.addRow([`${getSetting('business_name')} – דוח שעות ונוכחות`]).font = { bold: true, size: 14 };
  ws.addRow([`תקופה: ${f.from} עד ${f.to}`]);
  ws.addRow([]);
  const header = ws.addRow(cols.map((c) => c.header));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } }; });
  for (const e of report.employees) ws.addRow(cols.map((c) => safeCell(e[c.key])));
  const t = report.totals;
  const totalRow = ws.addRow(cols.map((c) => ({
    employee_name: 'סה״כ', shifts: t.shifts, planned_hours: t.planned_hours, hours: t.hours, overtime_hours: t.overtime_hours,
    late_count: t.late_count, absences: t.absences, early_leaves: t.early_leaves, estimated_cost: t.estimated_cost,
  })[c.key] ?? ''));
  totalRow.font = { bold: true };
  ws.columns.forEach((col, i) => { col.width = Math.max(12, cols[i]?.header.length + 4 || 12); });
  ws.getColumn(2).width = 22;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

export default router;
