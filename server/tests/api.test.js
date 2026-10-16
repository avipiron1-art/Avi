// Integration tests: run with `npm test`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb, getDb } from '../db/index.js';
import { seed } from '../db/seed.js';
import { resetSettingsCache } from '../services/settings.js';
import { clearPermissionCache } from '../services/permissions.js';
import { computeAttendance } from '../lib/attendance.js';

process.env.NODE_ENV = 'test';
let server;
let base;

before(async () => {
  setDb(openDb(':memory:'));
  resetSettingsCache();
  clearPermissionCache();
  seed(getDb());
  const { createApp } = await import('../index.js');
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}/api`;
});
after(() => server.close());

/** Minimal cookie-aware client */
async function login(identifier, password) {
  const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password }) });
  assert.equal(res.status, 200, `login ${identifier}`);
  const cookies = Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(';')[0].split('=')));
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method, path, body, { csrf = true } = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': cookies.csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
  return { get: (p) => call('GET', p), post: (p, b, o) => call('POST', p, b || {}, o), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

test('rejects wrong password with a generic message and locks after repeated failures', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'gal', password: 'nope' }) });
    assert.equal(r.status, 401);
  }
  const locked = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'gal', password: 'Employee1234' }) });
  assert.equal(locked.status, 401);
  assert.match((await locked.json()).error, /ננעל/);
});

test('unauthenticated requests are rejected', async () => {
  const r = await fetch(`${base}/employees`);
  assert.equal(r.status, 401);
});

test('passwords are stored hashed', () => {
  const row = getDb().prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
  assert.match(row.password_hash, /^\$2[aby]\$/);
});

test('employee cannot access manager data (server-side RBAC)', async () => {
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.get('/employees')).status, 403);
  assert.equal((await emp.get('/reports?from=2026-01-01&to=2026-01-31')).status, 403);
  assert.equal((await emp.get('/audit')).status, 403);
  assert.equal((await emp.get('/users')).status, 403);
  assert.equal((await emp.post('/shifts', { employee_ids: [1], date: '2030-01-01', start_time: '08:00', end_time: '12:00' })).status, 403);
  const other = getDb().prepare("SELECT id FROM employees WHERE email = 'noa@shiftly.demo'").get().id;
  assert.equal((await emp.get(`/employees/${other}`)).status, 403);
  const me = (await emp.get('/auth/me')).body.user;
  const own = await emp.get(`/employees/${me.employee_id}`);
  assert.equal(own.status, 200);
  assert.equal('hourly_wage' in own.body.employee, false, 'wage hidden from employee');
});

test('employee sees only own shifts, tasks and requests', async () => {
  const emp = await login('yossi', 'Employee1234');
  const me = (await emp.get('/auth/me')).body.user;
  const shifts = (await emp.get('/shifts?from=2026-01-01&to=2026-02-28')).body.shifts;
  const today = new Date().toISOString().slice(0, 10);
  const recent = (await emp.get(`/shifts?from=${today.slice(0, 8)}01&to=${today}`)).body.shifts;
  for (const s of [...shifts, ...recent]) assert.equal(s.employee_id, me.employee_id);
  for (const t of (await emp.get('/tasks')).body.tasks) assert.equal(t.assignee_id, me.employee_id);
  for (const r of (await emp.get('/requests')).body.requests) assert.equal(r.employee_id, me.employee_id);
});

test('shift manager can manage attendance and tasks but not shifts or employees', async () => {
  const mgr = await login('michal', 'Manager1234');
  assert.equal((await mgr.get('/attendance')).status, 200);
  assert.equal((await mgr.get('/employees')).status, 200);
  const list = (await mgr.get('/employees')).body.employees;
  assert.equal('hourly_wage' in list[0], false, 'shift manager does not see wages');
  assert.equal((await mgr.post('/shifts', { employee_ids: [3], date: '2030-01-01', start_time: '08:00', end_time: '12:00' })).status, 403);
  assert.equal((await mgr.post('/employees', {})).status, 403);
  const t = await mgr.post('/tasks', { title: 'בדיקה', priority: 'high' });
  assert.equal(t.status, 201);
});

test('CSRF token is required for state-changing requests', async () => {
  const admin = await login('admin', 'Admin1234');
  const r = await admin.post('/tasks', { title: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('server-side validation returns field errors', async () => {
  const admin = await login('admin', 'Admin1234');
  const r = await admin.post('/employees', { first_name: '', last_name: 'x', employee_code: '', start_date: 'bad', email: 'not-an-email' });
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.first_name);
  assert.ok(r.body.fields.start_date);
  assert.ok(r.body.fields.email);
});

test('SQL injection in search is treated as plain text', async () => {
  const admin = await login('admin', 'Admin1234');
  const r = await admin.get(`/employees?search=${encodeURIComponent("' OR 1=1 --")}&sort=${encodeURIComponent('name; DROP TABLE users')}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.employees.length, 0);
  assert.ok(getDb().prepare('SELECT COUNT(*) c FROM users').get().c > 0);
});

test('shift conflicts are detected and can be overridden explicitly', async () => {
  const admin = await login('admin', 'Admin1234');
  const body = { employee_ids: [3], date: '2031-03-02', start_time: '09:00', end_time: '17:00' };
  assert.equal((await admin.post('/shifts', body)).status, 201);
  const clash = await admin.post('/shifts', { ...body, start_time: '12:00', end_time: '20:00' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.conflicts[0].type, 'overlap');
  const forced = await admin.post('/shifts', { ...body, start_time: '12:00', end_time: '20:00', force: true });
  assert.equal(forced.status, 201);
});

test('bulk shift creation, edit with audit trail and notification', async () => {
  const admin = await login('admin', 'Admin1234');
  const r = await admin.post('/shifts', { employee_ids: [4, 5, 6], date: '2031-04-06', start_time: '16:00', end_time: '23:00' });
  assert.equal(r.status, 201);
  assert.equal(r.body.shifts.length, 3);
  const s = r.body.shifts[0];
  const u = await admin.put(`/shifts/${s.id}`, { employee_id: s.employee_id, date: '2031-04-06', start_time: '17:00', end_time: '23:00' });
  assert.equal(u.status, 200);
  const log = getDb().prepare("SELECT * FROM audit_logs WHERE action = 'shift.update' AND entity_id = ? ORDER BY id DESC").get(s.id);
  assert.match(log.description, /16:00.*17:00/);
  assert.equal(JSON.parse(log.old_value).start_at, '2031-04-06T16:00');
  const n = getDb().prepare("SELECT n.* FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.employee_id = ? AND n.type = 'shift_changed'").all(s.employee_id);
  assert.ok(n.length >= 1);
});

test('overnight shifts end on the next day', async () => {
  const admin = await login('admin', 'Admin1234');
  const r = await admin.post('/shifts', { employee_ids: [14], date: '2031-05-01', start_time: '22:00', end_time: '06:00' });
  assert.equal(r.status, 201);
  assert.equal(r.body.shifts[0].end_at, '2031-05-02T06:00');
});

test('copy week duplicates shifts and skips conflicts', async () => {
  const admin = await login('admin', 'Admin1234');
  await admin.post('/shifts', { employee_ids: [7], date: '2031-06-01', start_time: '08:00', end_time: '12:00' });
  const r = await admin.post('/shifts/copy-week', { source_week_start: '2031-06-01', target_week_start: '2031-06-08' });
  assert.equal(r.status, 200);
  assert.ok(r.body.created >= 1);
  const again = await admin.post('/shifts/copy-week', { source_week_start: '2031-06-01', target_week_start: '2031-06-08' });
  assert.equal(again.body.created, 0);
  assert.ok(again.body.skipped.length >= 1);
});

test('audit log is immutable at the database level', () => {
  const db = getDb();
  assert.throws(() => db.prepare("UPDATE audit_logs SET description = 'hacked'").run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM audit_logs').run(), /immutable/);
});

test('request approval flow notifies the employee', async () => {
  const emp = await login('noa', 'Employee1234');
  const created = await emp.post('/requests', { type: 'day_off', start_date: '2031-07-01', details: 'בדיקה' });
  assert.equal(created.status, 201);
  const admin = await login('admin', 'Admin1234');
  const r = await admin.patch(`/requests/${created.body.request.id}/review`, { status: 'approved', response: 'בהצלחה' });
  assert.equal(r.status, 200);
  const notes = (await emp.get('/notifications')).body.notifications;
  assert.ok(notes.some((n) => n.type === 'request_approved'));
  // approved leave now produces a scheduling warning
  const nid = (await emp.get('/auth/me')).body.user.employee_id;
  const clash = await admin.post('/shifts', { employee_ids: [nid], date: '2031-07-01', start_time: '08:00', end_time: '12:00' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.conflicts[0].type, 'leave');
});

test('employee cannot change status of a task assigned to someone else', async () => {
  const other = getDb().prepare("SELECT id FROM tasks WHERE assignee_id != (SELECT employee_id FROM users WHERE username='yossi') LIMIT 1").get();
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.patch(`/tasks/${other.id}/status`, { status: 'done' })).status, 403);
});

test('attendance calculations: late, early leave, overtime, absent', () => {
  const base = { start_at: '2030-01-01T08:00', end_at: '2030-01-01T16:00' };
  const late = computeAttendance({ ...base, clock_in_at: '2030-01-01T08:20', clock_out_at: '2030-01-01T16:00' }, '2030-01-02T00:00');
  assert.equal(late.late_minutes, 20);
  assert.equal(late.attendance_status, 'finished');
  assert.equal(late.worked_minutes, 460);
  const ot = computeAttendance({ ...base, clock_in_at: '2030-01-01T08:00', clock_out_at: '2030-01-01T17:30' }, '2030-01-02T00:00');
  assert.equal(ot.overtime_minutes, 90);
  const early = computeAttendance({ ...base, clock_in_at: '2030-01-01T08:00', clock_out_at: '2030-01-01T15:00' }, '2030-01-02T00:00');
  assert.equal(early.early_leave_minutes, 60);
  assert.equal(computeAttendance(base, '2030-01-02T00:00').attendance_status, 'absent');
  assert.equal(computeAttendance(base, '2030-01-01T08:30').attendance_status, 'late');
  assert.equal(computeAttendance(base, '2030-01-01T07:00').attendance_status, 'not_started');
  assert.equal(computeAttendance({ ...base, clock_in_at: '2030-01-01T07:58' }, '2030-01-01T10:00').attendance_status, 'on_shift');
});

test('reports are computed from real data and export to Excel/CSV', async () => {
  const admin = await login('admin', 'Admin1234');
  const today = new Date().toISOString().slice(0, 10);
  const from = today.slice(0, 8) + '01';
  const r = await admin.get(`/reports?from=${from}&to=${today}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.totals.hours > 0);
  assert.ok(r.body.totals.estimated_cost > 0);
  const csv = await admin.get(`/reports/export?from=${from}&to=${today}&format=csv`);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.body, /עובד/);
  const xlsx = await admin.get(`/reports/export?from=${from}&to=${today}&format=xlsx`);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
});

test('global search respects permissions', async () => {
  const admin = await login('admin', 'Admin1234');
  const a = await admin.get(`/search?q=${encodeURIComponent('נועה')}`);
  assert.ok(a.body.results.some((x) => x.type === 'employee'));
  const emp = await login('yossi', 'Employee1234');
  const e = await emp.get(`/search?q=${encodeURIComponent('נועה')}`);
  assert.equal(e.body.results.filter((x) => x.type === 'employee').length, 0);
});

test('password reset flow (demo mode returns link)', async () => {
  const f = await fetch(`${base}/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'adam' }) });
  const { demo_reset_path: path } = await f.json();
  const token = new URL(`http://x${path}`).searchParams.get('token');
  const weak = await fetch(`${base}/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'short' }) });
  assert.equal(weak.status, 400);
  const ok = await fetch(`${base}/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'NewPass123' }) });
  assert.equal(ok.status, 200);
  await login('adam', 'NewPass123');
  const reuse = await fetch(`${base}/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'Another123' }) });
  assert.equal(reuse.status, 400);
});

test('empty install creates only roles, permissions and an admin with the chosen password', async () => {
  const bcrypt = (await import('bcryptjs')).default;
  const db = openDb(':memory:');
  seed(db, { demo: false, adminPassword: 'Chosen123' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM employees').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM roles').get().c, 3);
  const admin = db.prepare("SELECT u.password_hash, r.key FROM users u JOIN roles r ON r.id = u.role_id").all();
  assert.equal(admin.length, 1);
  assert.equal(admin[0].key, 'admin');
  assert.ok(bcrypt.compareSync('Chosen123', admin[0].password_hash));
  db.close();
});
