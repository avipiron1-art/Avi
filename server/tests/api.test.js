// Integration tests: run with `npm test`
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb, getDb } from '../db/index.js';
import { seed } from '../db/seed.js';
import { resetSettingsCache } from '../services/settings.js';
import { clearPermissionCache } from '../services/permissions.js';
import { computeAttendance } from '../lib/attendance.js';

process.env.NODE_ENV = 'test';

// ---- fake Google OAuth + Drive for the backup tests ----
import http from 'node:http';
const google = { uploads: [], files: [], tokenCalls: 0, deleted: [] };
const googleServer = http.createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    body = Buffer.concat(body);
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/device/code') return json(200, { device_code: 'dev1', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', interval: 0, expires_in: 60 });
    if (u.pathname === '/token') {
      const p = new URLSearchParams(body.toString());
      if (p.get('grant_type') === 'refresh_token') return json(200, { access_token: 'at1' });
      google.tokenCalls += 1;
      return google.tokenCalls < 2 ? json(428, { error: 'authorization_pending' }) : json(200, { refresh_token: 'rt1', access_token: 'at1' });
    }
    if (req.headers.authorization !== 'Bearer at1') return json(401, {});
    if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
      if (u.searchParams.get('q').includes('mimeType')) return json(200, { files: [] });
      return json(200, { files: [...google.files].reverse() });
    }
    if (u.pathname === '/drive/v3/files' && req.method === 'POST') return json(200, { id: 'folder1' });
    if (u.pathname === '/upload/drive/v3/files') { const id = `f${google.files.length + 1}`; google.files.push({ id }); google.uploads.push(body); return json(200, { id }); }
    if (u.pathname.startsWith('/drive/v3/files/') && req.method === 'DELETE') { google.deleted.push(u.pathname.split('/').pop()); res.writeHead(204); return res.end(); }
    json(404, {});
  });
}).listen(0);
const gbase = `http://localhost:${googleServer.address().port}`;
process.env.GOOGLE_OAUTH_BASE = gbase;
process.env.GOOGLE_DRIVE_BASE = gbase;
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
after(() => { server.close(); googleServer.close(); });

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

// ===================== preference-based scheduling =====================
function nextSunday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 - d.getUTCDay() + 14); // a Sunday ~3 weeks ahead (clear of demo data)
  return d.toISOString().slice(0, 10);
}

test('scheduling requires schedule.manage; personal grant enables it for one shift manager only', async () => {
  const michal = await login('michal', 'Manager1234');
  assert.equal((await michal.get('/schedule/board')).status, 403);
  const admin = await login('admin', 'Admin1234');
  const users = (await admin.get('/users')).body.users;
  const mUser = users.find((u) => u.username === 'michal');
  const perms = (await admin.get(`/users/${mUser.id}/permissions`)).body;
  assert.ok(!perms.effective.includes('schedule.manage'));
  const r = await admin.put(`/users/${mUser.id}/permissions`, { permissions: [...perms.effective, 'schedule.manage'] });
  assert.equal(r.status, 200);
  assert.equal((await michal.get('/schedule/board')).status, 200, 'grant applies immediately');
  const ori = await login('ori', 'Manager1234');
  assert.equal((await ori.get('/schedule/board')).status, 403, 'other shift managers unaffected');
  // personal revoke
  const r2 = await admin.put(`/users/${mUser.id}/permissions`, { permissions: [...perms.effective.filter((p) => p !== 'tasks.manage'), 'schedule.manage'] });
  assert.equal(r2.status, 200);
  assert.equal((await michal.post('/tasks', { title: 'x' })).status, 403, 'revoked permission is enforced');
  assert.equal((await ori.post('/tasks', { title: 'x' })).status, 201);
  // admin cannot be restricted
  const adminUser = users.find((u) => u.username === 'admin');
  assert.equal((await admin.put(`/users/${adminUser.id}/permissions`, { permissions: [] })).status, 403);
});

test('employees submit preferences, manager assigns with a shift lead and publishes real shifts', async () => {
  const ws = nextSunday();
  const yossi = await login('yossi', 'Employee1234');
  const noa = await login('noa', 'Employee1234');
  const my = (await yossi.get(`/schedule/my?week=${ws}`)).body;
  assert.equal(my.week_start, ws);
  const [morning, evening] = my.types;
  assert.ok(morning && evening);
  const sub = await yossi.put('/schedule/my', { week_start: ws, note: 'לא בימי שישי', prefs: [
    { date: ws, shift_type_id: morning.id, preference: 'preferred' },
    { date: ws, shift_type_id: evening.id, preference: 'unavailable' },
  ] });
  assert.equal(sub.status, 200);
  const bad = await yossi.put('/schedule/my', { week_start: ws, prefs: [{ date: '2000-01-01', shift_type_id: morning.id, preference: 'available' }] });
  assert.equal(bad.status, 400);
  await noa.put('/schedule/my', { week_start: ws, prefs: [{ date: ws, shift_type_id: morning.id, preference: 'available' }] });

  const admin = await login('admin', 'Admin1234');
  const board = (await admin.get(`/schedule/board?week=${ws}`)).body;
  const yId = (await yossi.get('/auth/me')).body.user.employee_id;
  const nId = (await noa.get('/auth/me')).body.user.employee_id;
  assert.ok(board.prefs.some((p) => p.employee_id === yId && p.preference === 'preferred'));
  assert.ok(board.employees.find((e) => e.id === yId).submitted_at);

  const twoLeads = await admin.put('/schedule/board', { week_start: ws, assignments: [
    { date: ws, shift_type_id: morning.id, employee_id: yId, is_lead: true },
    { date: ws, shift_type_id: morning.id, employee_id: nId, is_lead: true },
  ] });
  assert.equal(twoLeads.status, 400);

  const assignments = [
    { date: ws, shift_type_id: morning.id, employee_id: yId, is_lead: true },
    { date: ws, shift_type_id: morning.id, employee_id: nId, is_lead: false },
  ];
  const pub = await admin.post('/schedule/publish', { week_start: ws, assignments });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.stats.created + pub.body.stats.updated, 2, "a matching manual shift is linked, not duplicated");
  assert.equal(pub.body.state.status, 'published');

  // employees can no longer change preferences for a published week
  assert.equal((await yossi.put('/schedule/my', { week_start: ws, prefs: [] })).status, 400);

  // everyone sees the published schedule with the shift lead
  const view = (await yossi.get(`/schedule/published?week=${ws}`)).body;
  const sunday = view.days[0].shifts.find((s) => s.name === morning.name);
  const ours = sunday.workers.filter((w) => [yId, nId].includes(w.employee_id));
  assert.equal(ours.length, 2);
  assert.equal(ours.find((w) => w.is_lead).employee_id, yId);
  assert.equal(ours.filter((w) => w.employee_id === yId).length, 1, 'no duplicate shift for the same person');
  assert.equal(sunday.start_at, `${ws}T${morning.start_time}`);

  // published shifts are real shifts (calendar + notifications)
  const mine = (await yossi.get(`/shifts?from=${ws}&to=${ws}`)).body.shifts;
  assert.ok(mine.some((s) => s.is_lead === 1 && s.shift_type_id === morning.id));
  assert.ok((await yossi.get('/notifications')).body.notifications.some((n) => n.title.includes('פורסם')));

  // re-publish without noa: her shift is cancelled, yossi's unchanged
  const again = await admin.post('/schedule/publish', { week_start: ws, assignments: [assignments[0]] });
  assert.equal(again.body.stats.cancelled, 1);
  assert.equal(again.body.stats.created, 0);
  assert.equal(again.body.stats.updated, 0);
  const view2 = (await noa.get(`/schedule/published?week=${ws}`)).body;
  const ours2 = view2.days[0].shifts.filter((x) => x.name === morning.name).flatMap((x) => x.workers).filter((w) => [yId, nId].includes(w.employee_id));
  assert.deepEqual(ours2.map((w) => w.employee_id), [yId]);
});

test('employees cannot reach the scheduling board or edit shift types', async () => {
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.get('/schedule/board')).status, 403);
  assert.equal((await emp.post('/schedule/publish', { week_start: nextSunday(), assignments: [] })).status, 403);
  assert.equal((await emp.post('/schedule/shift-types', { name: 'לילה', start_time: '23:00', end_time: '07:00' })).status, 403);
  const admin = await login('admin', 'Admin1234');
  const t = await admin.post('/schedule/shift-types', { name: 'לילה', start_time: '23:00', end_time: '07:00', sort_order: 3 });
  assert.equal(t.status, 201);
});

test('admin can change own name, username and email (password required for login changes)', async () => {
  const admin = await login('admin', 'Admin1234');
  const noPw = await admin.put('/auth/profile', { display_name: 'אבי כהן', username: 'avi', email: 'avi@example.com' });
  assert.equal(noPw.status, 400);
  const ok = await admin.put('/auth/profile', { display_name: 'אבי כהן', username: 'avi', email: 'avi@example.com', current_password: 'Admin1234' });
  assert.equal(ok.status, 200);
  const me = (await admin.get('/auth/me')).body.user;
  assert.equal(me.display_name, 'אבי כהן');
  assert.equal(me.role_name, 'מנהל ראשי');
  await login('avi', 'Admin1234');
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.put('/auth/profile', { display_name: 'x', username: 'yossi', email: 'yossi@shiftly.demo' })).status, 403);
  // restore for other tests
  await admin.put('/auth/profile', { display_name: 'דנה שלום', username: 'admin', email: 'admin@shiftly.demo', current_password: 'Admin1234' });
});

test('databases created by the previous version are upgraded in place', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'old.db');
  const old = new Database(file);
  old.exec(fs.readFileSync(new URL('./fixtures/schema-v1.sql', import.meta.url), 'utf8')); // schema of the first release
  old.exec(`INSERT INTO employees (employee_code, first_name, last_name, start_date) VALUES ('E1','a','b','2026-01-01');
    INSERT INTO shifts (employee_id, start_at, end_at) VALUES (1, '2026-01-01T08:00', '2026-01-01T16:00');`);
  old.close();
  const db = openDb(file);
  const cols = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
  assert.ok(cols.includes('shift_type_id') && cols.includes('is_lead'));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM shifts').get().c, 1, 'existing data kept');
  assert.ok(db.prepare('SELECT COUNT(*) c FROM shift_types').get().c >= 2, 'default shift types created');
  db.close();
  const again = openDb(file); // idempotent
  again.close();
});

test('a delegated user manager cannot take over main-admin accounts', async () => {
  const admin = await login('admin', 'Admin1234');
  const users = (await admin.get('/users')).body.users;
  const ori = users.find((u) => u.username === 'ori');
  const adminUser = users.find((u) => u.username === 'admin');
  const perms = (await admin.get(`/users/${ori.id}/permissions`)).body.effective;
  await admin.put(`/users/${ori.id}/permissions`, { permissions: [...perms, 'users.manage'] });
  const o = await login('ori', 'Manager1234');
  assert.equal((await o.post(`/users/${adminUser.id}/password`, { password: 'Hacked1234' })).status, 403);
  assert.equal((await o.put(`/users/${ori.id}`, { ...ori, role: 'admin', is_active: true, employee_id: ori.employee_id })).status, 403);
  assert.equal((await o.del(`/users/${adminUser.id}`)).status, 403);
  assert.equal((await o.put(`/users/${ori.id}/permissions`, { permissions: Object.keys({}) })).status, 403);
  assert.equal((await o.get('/users')).status, 200, 'delegated permission still works for normal users');
  await admin.put(`/users/${ori.id}/permissions`, { permissions: perms });
});

test('Google Drive backup: connect with a device code, upload a gzip snapshot, keep N copies', async () => {
  const admin = await login('admin', 'Admin1234');
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.get('/backup/status')).status, 403);
  assert.equal((await emp.get('/backup/download')).status, 403);
  const bad = await admin.put('/backup/drive/config', { client_id: 'nope', client_secret: 'x' });
  assert.equal(bad.status, 400);
  assert.equal((await admin.put('/backup/drive/config', { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'secret-123456' })).status, 200);
  const settings = (await admin.get('/settings')).body.settings;
  assert.equal(settings.gdrive_client_secret, undefined, 'secrets never sent to the browser');
  const c = await admin.post('/backup/drive/connect');
  assert.equal(c.body.pending.user_code, 'ABCD-EFGH');
  let st;
  for (let i = 0; i < 50; i += 1) { st = (await admin.get('/backup/status')).body; if (st.connected && st.last_backup) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(st.connected, 'connected after the user approved the code');
  assert.ok(st.last_backup, 'first backup runs right after connecting');
  const zlib = await import('node:zlib');
  const gz = google.uploads[0];
  const start = gz.indexOf(Buffer.from([0x1f, 0x8b]));
  const db = zlib.gunzipSync(gz.subarray(start, gz.lastIndexOf(Buffer.from('\r\n--'))));
  assert.equal(db.subarray(0, 15).toString(), 'SQLite format 3', 'uploaded file is a real SQLite database');
  // retention
  await admin.put('/settings', { ...(await admin.get('/settings')).body.settings, backup_keep: 2 });
  await admin.post('/backup/run'); await admin.post('/backup/run');
  assert.ok(google.deleted.length >= 1, 'old copies beyond backup_keep are deleted');
  // manual download
  const dl = await admin.get('/backup/download');
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /shiftly-.*\.db\.gz/);
});

test('join link: new employee signs up, managers are notified with the details, link is single-use', async () => {
  const admin = await login('admin', 'Admin1234');
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.post('/invites', {})).status, 403);
  const inv = await admin.post('/invites', { label: 'מלצרים', max_uses: 1, expires_days: 3 });
  assert.equal(inv.status, 201);
  const token = inv.body.path.split('/').pop();
  const info = await fetch(`${base}/join/${token}`);
  assert.equal(info.status, 200);
  const body = { first_name: 'דנה', last_name: 'חדשה', phone: '050-1234567', email: 'new.dana@example.com', username: 'dana.new', password: 'Welcome123' };
  const weak = await fetch(`${base}/join/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, password: '123' }) });
  assert.equal(weak.status, 400);
  const ok = await fetch(`${base}/join/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(ok.status, 201);
  assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('sid=')), 'signed in right away');
  const fresh = await login('dana.new', 'Welcome123');
  const me = (await fresh.get('/auth/me')).body.user;
  assert.equal(me.role, 'employee');
  assert.ok(me.employee_id);
  const n = (await admin.get('/notifications')).body.notifications.find((x) => x.type === 'employee_joined');
  assert.match(n.title, /דנה חדשה/);
  assert.match(n.body, /dana\.new/);
  const again = await fetch(`${base}/join/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, username: 'other', email: 'o@example.com' }) });
  assert.equal(again.status, 400, 'single-use link cannot be reused');
  assert.equal((await fetch(`${base}/join/not-a-real-token-123`)).status, 404);
});

test('first-come shift claims: capacity, shift-lead slots, manager approval keeps late claims', async () => {
  const admin = await login('admin', 'Admin1234');
  const types = (await admin.get('/schedule/shift-types')).body.types;
  const t = types[0];
  await admin.put(`/schedule/shift-types/${t.id}`, { ...t, is_active: true, required_workers: 2, required_leads: 1 });
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 7 - d.getUTCDay() + 35); // a Sunday ~6 weeks ahead
  const date = d.toISOString().slice(0, 10);
  const users = { a: await login('shira', 'Employee1234'), b: await login('omer', 'Employee1234'), c: await login('daniel', 'Employee1234') };
  const ids = {};
  for (const [k, u] of Object.entries(users)) ids[k] = (await u.get('/auth/me')).body.user.employee_id;

  // shira is not a shift lead yet
  assert.equal((await users.a.post('/schedule/claim', { date, shift_type_id: t.id, as_lead: true })).status, 400);
  const emp = (await admin.get(`/employees/${ids.a}`)).body.employee;
  await admin.put(`/employees/${ids.a}`, { ...emp, can_lead: true, avatar: undefined });
  const managerLoaded = (await admin.get(`/schedule/board?week=${date}`)).body.loaded_at;
  assert.equal((await users.a.post('/schedule/claim', { date, shift_type_id: t.id, as_lead: true })).status, 201);
  assert.equal((await users.b.post('/schedule/claim', { date, shift_type_id: t.id })).status, 201);
  const full = await users.c.post('/schedule/claim', { date, shift_type_id: t.id });
  assert.equal(full.status, 400, 'only 1 regular slot (2 workers − 1 lead)');
  assert.equal((await users.b.post('/schedule/claim', { date, shift_type_id: t.id })).status, 400, 'no double claim');

  const open = (await users.c.get(`/schedule/open?week=${date}`)).body.slots.find((s) => s.date === date && s.shift_type_id === t.id);
  assert.equal(open.taken_leads, 1);
  assert.equal(open.taken_regular, 1);

  // manager saves a board loaded BEFORE the claims: claims are kept
  await admin.put('/schedule/board', { week_start: date, assignments: [], loaded_at: managerLoaded });
  const board = (await admin.get(`/schedule/board?week=${date}`)).body;
  const claims = board.assignments.filter((a) => a.date === date && a.status === 'claimed');
  assert.equal(claims.length, 2, 'late claims survive an older board save');

  // approve shira, reject omer
  const approved = claims.filter((c) => c.employee_id === ids.a).map((c) => ({ ...c, is_lead: !!c.is_lead, status: 'approved' }));
  await admin.put('/schedule/board', { week_start: date, assignments: approved, loaded_at: board.loaded_at });
  const na = (await users.a.get('/notifications')).body.notifications;
  assert.ok(na.some((n) => n.title.includes('אושרה')));
  const nb = (await users.b.get('/notifications')).body.notifications;
  assert.ok(nb.some((n) => n.title.includes('לא אושרה')));
  // a slot freed up -> daniel can claim now; cannot cancel an approved pick
  assert.equal((await users.c.post('/schedule/claim', { date, shift_type_id: t.id })).status, 201);
  assert.equal((await users.a.del(`/schedule/claim?date=${date}&shift_type_id=${t.id}`)).status, 400);
  assert.equal((await users.c.del(`/schedule/claim?date=${date}&shift_type_id=${t.id}`)).status, 200);
  // publishing only creates shifts for approved picks
  const pub = await admin.post('/schedule/publish', { week_start: date, assignments: approved });
  assert.equal(pub.status, 200);
  const shiftsA = (await users.a.get(`/shifts?from=${date}&to=${date}`)).body.shifts;
  assert.ok(shiftsA.some((s) => s.is_lead === 1));
  await admin.put(`/schedule/shift-types/${t.id}`, { ...t, is_active: true, required_workers: 0, required_leads: 0 });
});

test('shift swap board: offer, take, manager approves and the shift moves', async () => {
  const admin = await login('admin', 'Admin1234');
  const a = await login('shira', 'Employee1234');
  const b = await login('omer', 'Employee1234');
  const ida = (await a.get('/auth/me')).body.user.employee_id;
  const idb = (await b.get('/auth/me')).body.user.employee_id;
  const s = (await admin.post('/shifts', { employee_ids: [ida], date: '2031-07-07', start_time: '08:00', end_time: '14:00', force: true })).body.shifts[0];
  assert.equal((await b.post('/swaps', { shift_id: s.id })).status, 403, 'cannot offer someone else\'s shift');
  const offer = await a.post('/swaps', { shift_id: s.id, note: 'מבחן' });
  assert.equal(offer.status, 201);
  assert.equal((await a.post('/swaps', { shift_id: s.id })).status, 400, 'already offered');
  const board = (await b.get('/swaps')).body;
  const w = board.open.find((x) => x.shift_id === s.id);
  assert.ok(w, 'colleague sees the offer');
  assert.equal(board.can_approve, false);
  assert.equal((await a.post(`/swaps/${w.id}/take`)).status, 400, 'cannot take own shift');
  assert.equal((await b.post(`/swaps/${w.id}/decide`, { approve: true })).status, 403);
  assert.equal((await b.post(`/swaps/${w.id}/take`)).status, 200);
  assert.equal((await admin.post(`/swaps/${w.id}/take`)).status, 403, 'admin without employee record cannot take');
  const pending = (await admin.get('/swaps')).body.pending;
  assert.ok(pending.some((x) => x.id === w.id));
  assert.equal((await admin.post(`/swaps/${w.id}/decide`, { approve: true })).status, 200);
  const moved = getDb().prepare('SELECT employee_id FROM shifts WHERE id = ?').get(s.id);
  assert.equal(moved.employee_id, idb);
  assert.ok((await a.get('/notifications')).body.notifications.some((n) => n.title === 'ההחלפה אושרה'));
  assert.equal((await admin.post(`/swaps/${w.id}/decide`, { approve: true })).status, 400, 'cannot decide twice');
});

test('location clock-in: far away is refused, nearby is recorded with the distance; shift-end reminder', async () => {
  const { nowLocal, addMinutes } = await import('../lib/time.js');
  const { checkShiftEndReminders } = await import('../services/jobs.js');
  const admin = await login('admin', 'Admin1234');
  const db = getDb();
  const loc = await admin.post('/meta/locations', { name: 'סניף בדיקה', address: 'x', is_active: true, latitude: 32.0853, longitude: 34.7818, radius_m: 100, require_location: true });
  assert.equal(loc.status, 201);
  assert.equal((await admin.post('/meta/locations', { name: 'בלי נקודה', is_active: true, require_location: true })).status, 400, 'require needs coordinates');
  const hash = db.prepare("SELECT password_hash FROM users WHERE username = 'yossi'").get().password_hash;
  const empId = db.prepare("INSERT INTO employees (employee_code, first_name, last_name, status, location_id, start_date) VALUES ('GEO-1', 'גאו', 'בודק', 'active', ?, '2024-01-01')").run(loc.body.id).lastInsertRowid;
  db.prepare("INSERT INTO users (username, email, display_name, password_hash, role_id, employee_id) VALUES ('geo', 'geo@x.io', 'גאו בודק', ?, (SELECT id FROM roles WHERE key = 'employee'), ?)").run(hash, empId);
  const now = nowLocal();
  const shiftId = db.prepare("INSERT INTO shifts (employee_id, start_at, end_at, status) VALUES (?, ?, ?, 'scheduled')").run(empId, addMinutes(now, -5), addMinutes(now, 120)).lastInsertRowid;
  const geo = await login('geo', 'Employee1234');
  const none = await geo.post('/attendance/clock-in', {});
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'location_required');
  const far = await geo.post('/attendance/clock-in', { lat: 32.1, lng: 34.8, accuracy: 10 });
  assert.equal(far.status, 400);
  assert.equal(far.body.code, 'location_far');
  const near = await geo.post('/attendance/clock-in', { lat: 32.0855, lng: 34.7820, accuracy: 15 });
  assert.equal(near.status, 200, JSON.stringify(near.body));
  const att = db.prepare('SELECT clock_in_distance_m FROM attendance WHERE shift_id = ?').get(shiftId);
  assert.ok(att.clock_in_distance_m >= 0 && att.clock_in_distance_m < 100);
  // the shift ended 30 minutes ago and the employee is still clocked in → one urgent reminder
  db.prepare('UPDATE shifts SET start_at = ?, end_at = ? WHERE id = ?').run(addMinutes(now, -150), addMinutes(now, -30), shiftId);
  assert.ok(checkShiftEndReminders() >= 1);
  assert.equal(checkShiftEndReminders(), 0, 'only once');
  assert.ok((await geo.get('/notifications')).body.notifications.some((n) => n.type === 'shift_end'));
  assert.equal((await geo.post('/attendance/clock-out', { lat: 32.0854, lng: 34.7819 })).status, 200);
});

test('pay hours follow the overtime rules: daily tiers, rest day and holiday premiums', async () => {
  const { splitDay } = await import('../services/payroll.js');
  const opts = { dailyMinutes: 8 * 60, tier1Minutes: 2 * 60 };
  // Sunday 2031-03-02: 11 hours → 8 regular, 2 at 125%, 1 at 150%
  const sun = splitDay([['2031-03-02T07:00', '2031-03-02T18:00']], opts);
  assert.deepEqual(sun, { regular: 480, ot1: 120, ot2: 60, rest: 0, rest_ot1: 0, rest_ot2: 0 });
  // Saturday 2031-03-08: 9 hours → 8 at 150%, 1 at 175%
  const sat = splitDay([['2031-03-08T08:00', '2031-03-08T17:00']], opts);
  assert.equal(sat.rest, 480);
  assert.equal(sat.rest_ot1, 60);
  // Friday night into Saturday: 22:00–06:00 → 2 regular hours, 6 rest-day hours
  const night = splitDay([['2031-03-07T22:00', '2031-03-08T06:00']], opts);
  assert.equal(night.regular, 120);
  assert.equal(night.rest, 360);
  // Yom Kippur 2031 (Sept 27) is a paid holiday
  const yk = splitDay([['2031-09-27T08:00', '2031-09-27T12:00']], opts);
  assert.equal(yk.rest, 240);

  const admin = await login('admin', 'Admin1234');
  const month = new Date().toISOString().slice(0, 7);
  const pay = await admin.get(`/reports/payroll?month=${month}`);
  assert.equal(pay.status, 200);
  assert.ok(pay.body.employees.length > 0);
  assert.ok('ot1' in pay.body.employees[0].buckets);
  const xlsx = await admin.get(`/reports/payroll?month=${month}&format=xlsx`);
  assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
  const csv = await admin.get(`/reports/payroll?month=${month}&format=csv`);
  assert.match(csv.body, /ת\.ז\./);
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.get(`/reports/payroll?month=${month}`)).status, 403);
  const slip = await emp.get(`/attendance/me/slip?month=${month}`);
  assert.equal(slip.status, 200);
  assert.ok(slip.body.employee === null || slip.body.employee.employee_name);
  assert.equal(slip.body.employee?.hourly_wage, undefined, 'no wage on the personal slip');
  assert.equal((await emp.get(`/attendance/me/slip?month=2031-13`)).status, 400);
  const file = await emp.get(`/attendance/me/slip?month=${month}&format=xlsx`);
  assert.match(file.headers.get('content-type'), /spreadsheetml/);
});

test('announcements: urgency, must-confirm popup queue, confirmation tracking, permissions', async () => {
  const admin = await login('admin', 'Admin1234');
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.post('/announcements', { title: 'x' })).status, 403);
  const r = await admin.post('/announcements', { title: 'נוהל ניקיון חדש', body: 'מהיום…', urgency: 'critical', requires_ack: true });
  assert.equal(r.status, 201);
  assert.ok(r.body.recipients > 3);
  await admin.post('/announcements', { title: 'מסיבת צוות', urgency: 'low' });
  const pending = (await emp.get('/announcements/pending')).body.announcements;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, 'נוהל ניקיון חדש');
  assert.equal((await emp.get('/announcements/unread-count')).body.unread, 2);
  const list = (await emp.get('/announcements')).body;
  assert.equal(list.announcements[0].urgency, 'critical', 'most urgent first');
  assert.equal(list.announcements[0].stats, undefined, 'employees do not see stats');
  assert.ok((await emp.get('/notifications')).body.notifications.some((n) => n.type === 'announcement'));
  assert.equal((await emp.post(`/announcements/${r.body.id}/ack`)).status, 200);
  assert.equal((await emp.get('/announcements/pending')).body.announcements.length, 0, 'no more popup after confirming');
  const st = (await admin.get(`/announcements/${r.body.id}/status`)).body.people;
  assert.ok(st.find((p) => p.name.includes('יוסי'))?.acked_at);
  const mine = (await admin.get('/announcements')).body.announcements.find((a) => a.id === r.body.id);
  assert.equal(mine.stats.acked, 1);
  assert.equal((await emp.get(`/announcements/${r.body.id}/status`)).status, 403);
  // targeted to another department → invisible
  const otherDept = getDb().prepare('SELECT id FROM departments WHERE id != (SELECT department_id FROM employees WHERE id = (SELECT employee_id FROM users WHERE username = ?)) LIMIT 1').get('yossi').id;
  const t = await admin.post('/announcements', { title: 'רק למטבח', department_id: otherDept, requires_ack: true });
  assert.ok(!(await emp.get('/announcements')).body.announcements.some((a) => a.id === t.body.id));
  assert.equal((await emp.post(`/announcements/${t.body.id}/ack`)).status, 404);
  assert.equal((await admin.del(`/announcements/${t.body.id}`)).status, 200);
});

test('two-step login with an authenticator code, recovery code, admin reset', async () => {
  const { totpAt, currentStep } = await import('../services/mfa.js');
  const db = getDb();
  const hash = db.prepare("SELECT password_hash FROM users WHERE username = 'yossi'").get().password_hash;
  db.prepare("INSERT INTO users (username, email, display_name, password_hash, role_id) VALUES ('mfa.user', 'mfa@x.io', 'משתמש אימות', ?, (SELECT id FROM roles WHERE key = 'employee'))").run(hash);
  const u = await login('mfa.user', 'Employee1234');
  assert.equal((await u.post('/auth/2fa/setup', { password: 'wrong' })).status, 400);
  const setup = await u.post('/auth/2fa/setup', { password: 'Employee1234' });
  assert.equal(setup.status, 200);
  assert.match(setup.body.qr, /^data:image\/png;base64,/);
  assert.match(setup.body.otpauth_url, /^otpauth:\/\/totp\//);
  const secret = setup.body.secret;
  assert.equal((await u.post('/auth/2fa/enable', { code: '000000' })).status, 400);
  // use the previous 30-second step so the login below can use the current one (codes can't be reused)
  const en = await u.post('/auth/2fa/enable', { code: totpAt(secret, currentStep() - 1) });
  assert.equal(en.status, 200);
  assert.equal(en.body.recovery_codes.length, 8);

  const step1 = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'mfa.user', password: 'Employee1234' }) });
  const b1 = await step1.json();
  assert.equal(b1.mfa_required, true);
  assert.ok(!step1.headers.getSetCookie().some((c) => c.startsWith('sid=')), 'no session before the code');
  const mfa = (code) => fetch(`${base}/auth/login/mfa`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mfa_token: b1.mfa_token, code }) });
  assert.equal((await mfa('123456')).status, 400);
  const ok = await mfa(totpAt(secret, currentStep()));
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.getSetCookie().some((c) => c.startsWith('sid=')));
  assert.equal((await mfa(totpAt(secret, currentStep()))).status, 401, 'token is single-use');

  // recovery code works once
  const again = await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'mfa.user', password: 'Employee1234' }) })).json();
  const rc = en.body.recovery_codes[0];
  const r1 = await fetch(`${base}/auth/login/mfa`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mfa_token: again.mfa_token, code: rc }) });
  assert.equal(r1.status, 200);
  assert.equal(JSON.parse(db.prepare("SELECT recovery_codes FROM users WHERE username = 'mfa.user'").get().recovery_codes).length, 7);

  // admin resets it (lost phone) → password alone works again
  const admin = await login('admin', 'Admin1234');
  const id = db.prepare("SELECT id FROM users WHERE username = 'mfa.user'").get().id;
  assert.equal((await admin.post(`/users/${id}/reset-mfa`)).status, 200);
  await login('mfa.user', 'Employee1234');
  const sec = await (await login('mfa.user', 'Employee1234')).get('/auth/security');
  assert.equal(sec.body.totp_enabled, false);
  assert.equal((await fetch(`${base}/auth/passkeys/login/options`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 200);
});

test('branch manager sees only their branch; an on-duty shift lead gets attendance rights for their own shift', async () => {
  const { nowLocal, addMinutes } = await import('../lib/time.js');
  const db = getDb();
  const admin = await login('admin', 'Admin1234');
  const locs = db.prepare('SELECT id FROM locations ORDER BY id LIMIT 2').all().map((l) => l.id);
  assert.equal(locs.length, 2);
  const smId = db.prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'shift_manager' LIMIT 1").get().id;
  const sm = (await admin.get('/users')).body.users.find((u) => u.id === smId);
  assert.equal((await admin.put(`/users/${smId}`, { ...sm, location_id: locs[0], is_active: true })).status, 200);
  const smUser = await login(sm.username, 'Manager1234');
  const emps = (await smUser.get('/employees')).body.employees;
  assert.ok(emps.length > 0);
  assert.ok(emps.every((e) => e.location_id === locs[0]), 'only own branch employees');
  const today = nowLocal().slice(0, 10);
  const board = (await smUser.get(`/attendance?date=${today}`)).body.rows;
  assert.ok(board.every((r) => (r.location_id ?? emps.find((e) => e.id === r.employee_id)?.location_id) === locs[0]));
  await admin.put(`/users/${smId}`, { ...sm, location_id: null, is_active: true });

  // shift lead on duty
  const lead = await login('omer', 'Employee1234');
  const leadEmp = (await lead.get('/auth/me')).body.user.employee_id;
  assert.equal((await lead.get(`/attendance?date=${today}`)).status, 403, 'not a lead right now');
  const now = nowLocal();
  db.prepare("INSERT INTO shifts (employee_id, start_at, end_at, status, is_lead) VALUES (?, ?, ?, 'scheduled', 1)").run(leadEmp, addMinutes(now, -60), addMinutes(now, 120));
  const me = (await lead.get('/auth/me')).body.user;
  assert.ok(me.lead_scope, 'lead scope exposed');
  assert.ok(me.permissions.includes('attendance.manage'));
  const rows = (await lead.get(`/attendance?date=${today}`)).body.rows;
  assert.ok(rows.every((r) => r.start_at < me.lead_scope.to && r.end_at > me.lead_scope.from), 'only the overlapping shift');
  const outside = db.prepare("SELECT id FROM shifts WHERE status = 'scheduled' AND (end_at <= ? OR start_at >= ?) LIMIT 1").get(me.lead_scope.from, me.lead_scope.to);
  assert.equal((await lead.put(`/attendance/${outside.id}`, { marked_absent: true })).status, 403);
  assert.equal((await lead.get('/employees')).status, 403, 'no other manager rights');
});

test('email: settings are admin-only and secret, reset/invite/notifications send mail, digests group updates', async () => {
  const { sentInTests, flushAllMail } = await import('../services/mailer.js');
  const admin = await login('admin', 'Admin1234');
  const emp = await login('yossi', 'Employee1234');
  assert.equal((await emp.get('/mail/status')).status, 403);
  assert.equal((await admin.put('/mail/config', { provider: 'gmail', user: 'not-an-email', pass: 'x' })).status, 400);
  const ok = await admin.put('/mail/config', { provider: 'gmail', user: 'biz@gmail.com', pass: 'abcd efgh ijkl mnop', from_name: 'המסעדה' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.enabled, true);
  assert.equal(ok.body.host, 'smtp.gmail.com');
  assert.equal(JSON.stringify(ok.body).includes('abcdefgh'), false, 'password never returned');
  assert.equal(JSON.stringify((await admin.get('/settings')).body).includes('abcdefgh'), false);
  // saving again without the password keeps it
  assert.equal((await admin.put('/mail/config', { provider: 'gmail', user: 'biz@gmail.com', from_name: 'X' })).status, 200);
  assert.equal((await fetch(`${base}/auth/options`).then((r) => r.json())).mail, true);

  sentInTests.length = 0;
  assert.equal((await admin.post('/mail/test')).status, 200);
  assert.equal(sentInTests.length, 1);

  // password reset email has the link in the button
  sentInTests.length = 0;
  await fetch(`${base}/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: 'yossi' }) });
  assert.equal(sentInTests.length, 1);
  assert.match(sentInTests[0].html, /reset-password\?token=/);
  assert.match(sentInTests[0].html, /dir="rtl"/);

  // invite by email
  sentInTests.length = 0;
  const inv = await admin.post('/invites', { send_to: ['new1@example.com', 'new2@example.com'] });
  assert.equal(inv.status, 201);
  assert.equal(sentInTests.filter((m) => /join\//.test(m.text)).length, 2);

  // important notifications are grouped into one email per person (demo addresses are skipped, so use a real-looking one)
  const db = getDb();
  db.prepare("UPDATE users SET email = 'yossi.real@example.com' WHERE username = 'yossi'").run();
  sentInTests.length = 0;
  const yid = (await emp.get('/auth/me')).body.user.employee_id;
  await admin.post('/shifts', { employee_ids: [yid], date: '2032-01-05', start_time: '08:00', end_time: '12:00', force: true });
  await admin.post('/shifts', { employee_ids: [yid], date: '2032-01-06', start_time: '08:00', end_time: '12:00', force: true });
  await flushAllMail();
  const toY = sentInTests.filter((m) => m.to === 'yossi.real@example.com');
  assert.equal(toY.length, 1, 'one grouped email');
  assert.match(toY[0].subject, /2 עדכונים/);
  // opt out
  assert.equal((await emp.put('/auth/email-notifications', { enabled: false })).status, 200);
  sentInTests.length = 0;
  await admin.post('/shifts', { employee_ids: [yid], date: '2032-01-07', start_time: '08:00', end_time: '12:00', force: true });
  await flushAllMail();
  assert.equal(sentInTests.filter((m) => m.to === 'yossi.real@example.com').length, 0);
  assert.equal((await emp.get('/auth/me')).body.user.email_notifications, false);
  await emp.put('/auth/email-notifications', { enabled: true });
  db.prepare("UPDATE users SET email = 'yossi@shiftly.demo' WHERE username = 'yossi'").run();
  assert.equal((await admin.del('/mail/config')).body.enabled, false);
});
