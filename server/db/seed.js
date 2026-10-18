// Demo data: 20 employees (incl. 2 shift managers), 1 admin, departments, ~2 months of shifts,
// attendance, requests, tasks, notifications and audit history.
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { getDb } from './index.js';
import { DEFAULT_ROLE_PERMISSIONS } from '../services/permissions.js';
import { DEFAULT_SETTINGS, loadSettings } from '../services/settings.js';
import { addDays, addMinutes, nowLocal, todayLocal, weekday } from '../lib/time.js';

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEMO_PASSWORDS = { admin: 'Admin1234', manager: 'Manager1234', employee: 'Employee1234' };

/**
 * Populate a fresh database.
 * demo=false creates only roles, permissions, settings and a single admin (for real use).
 */
export function seed(db = getDb(), { demo = true, adminPassword = DEMO_PASSWORDS.admin } = {}) {
  const rnd = mulberry32(20261016);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

  const run = db.transaction(() => {
    // ---------- settings / roles / permissions ----------
    const setS = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setS.run(k, v);
    loadSettings();

    const roles = [
      ['admin', 'מנהל ראשי', 'גישה מלאה לכל המערכת', 'all'],
      ['shift_manager', 'מנהל משמרת', 'ניהול נוכחות, משימות ואירועים בסניף שלו', 'branch'],
      ['employee', 'עובד', 'צפייה במשמרות, שעות, משימות והגשת בקשות', 'self'],
      ['shift_lead', 'אחמ"ש', 'הרשאות שפועלות רק במשמרות שבהן הוא משובץ כאחמ"ש', 'lead'],
    ];
    const insRole = db.prepare('INSERT INTO roles (key, name, description, scope) VALUES (?, ?, ?, ?)');
    const roleId = {};
    for (const r of roles) roleId[r[0]] = insRole.run(...r).lastInsertRowid;
    const insPerm = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) for (const p of perms) insPerm.run(roleId[role], p);

    if (!demo) {
      db.prepare('INSERT INTO users (username, email, display_name, password_hash, role_id) VALUES (?, ?, ?, ?, ?)')
        .run('admin', 'admin@shiftly.local', 'מנהל ראשי', bcrypt.hashSync(adminPassword, 12), roleId.admin);
      return;
    }

    // ---------- reference data ----------
    const insLoc = db.prepare('INSERT INTO locations (name, address) VALUES (?, ?)');
    const locs = [insLoc.run('סניף תל אביב', 'דרך מנחם בגין 120, תל אביב').lastInsertRowid,
      insLoc.run('סניף חיפה', 'שדרות הנשיא 45, חיפה').lastInsertRowid];

    const insDep = db.prepare('INSERT INTO departments (name, description, color) VALUES (?, ?, ?)');
    const dep = {
      kitchen: insDep.run('מטבח', 'צוות הכנה ובישול', '#f97316').lastInsertRowid,
      service: insDep.run('שירות', 'מלצרות ואירוח', '#0ea5e9').lastInsertRowid,
      sales: insDep.run('קופה ומכירות', 'קופות, מכירות ושירות לקוחות', '#22c55e').lastInsertRowid,
      logistics: insDep.run('לוגיסטיקה', 'מחסן, קבלת סחורה ומשלוחים', '#a855f7').lastInsertRowid,
      management: insDep.run('הנהלה', 'הנהלת משמרות ותפעול', '#6366f1').lastInsertRowid,
    };
    const insPos = db.prepare('INSERT INTO positions (name, department_id) VALUES (?, ?)');
    const pos = {
      chef: insPos.run('טבח/ית', dep.kitchen).lastInsertRowid,
      cook: insPos.run('עוזר/ת מטבח', dep.kitchen).lastInsertRowid,
      waiter: insPos.run('מלצר/ית', dep.service).lastInsertRowid,
      host: insPos.run('מארח/ת', dep.service).lastInsertRowid,
      cashier: insPos.run('קופאי/ת', dep.sales).lastInsertRowid,
      sales: insPos.run('נציג/ת מכירות', dep.sales).lastInsertRowid,
      warehouse: insPos.run('מחסנאי/ת', dep.logistics).lastInsertRowid,
      driver: insPos.run('שליח/ה', dep.logistics).lastInsertRowid,
      shiftLead: insPos.run('אחראי/ת משמרת', dep.management).lastInsertRowid,
    };

    // ---------- employees ----------
    const people = [
      ['מיכל', 'אברהם', 'shiftLead', 'management', 62, 'shift_manager', 'michal'],
      ['אורי', 'ברק', 'shiftLead', 'management', 60, 'shift_manager', 'ori'],
      ['יוסי', 'לוי', 'chef', 'kitchen', 58],
      ['נועה', 'פרץ', 'cook', 'kitchen', 42],
      ['איתי', 'מזרחי', 'cook', 'kitchen', 41],
      ['שירה', 'כהן', 'waiter', 'service', 40],
      ['עומר', 'דהן', 'waiter', 'service', 40],
      ['תמר', 'אוחיון', 'waiter', 'service', 40, null, null, 'vacation'],
      ['דניאל', 'שמעוני', 'host', 'service', 43],
      ['רוני', 'גבאי', 'cashier', 'sales', 41],
      ['הילה', 'ביטון', 'cashier', 'sales', 41],
      ['אביב', 'סויסה', 'sales', 'sales', 48],
      ['מאיה', 'רוזן', 'sales', 'sales', 47],
      ['אלון', 'חדד', 'warehouse', 'logistics', 45],
      ['ליאור', 'עזרא', 'warehouse', 'logistics', 44],
      ['גל', 'נחום', 'driver', 'logistics', 46],
      ['יעל', 'קפלן', 'chef', 'kitchen', 56],
      ['אדם', 'פרידמן', 'host', 'service', 42],
      ['שני', 'וקנין', 'cashier', 'sales', 40, null, null, 'inactive'],
      ['רועי', 'אלמוג', 'driver', 'logistics', 46],
    ];
    const translit = ['yossi', 'noa', 'itay', 'shira', 'omer', 'tamar', 'daniel', 'roni', 'hila', 'aviv', 'maya', 'alon', 'lior', 'gal', 'yael', 'adam', 'shani', 'roy'];
    const insEmp = db.prepare(
      `INSERT INTO employees (employee_code, first_name, last_name, phone, email, position_id, department_id, location_id, start_date, status, hourly_wage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insUser = db.prepare('INSERT INTO users (username, email, display_name, password_hash, role_id, employee_id) VALUES (?, ?, ?, ?, ?, ?)');
    const hash = {
      admin: bcrypt.hashSync(DEMO_PASSWORDS.admin, 12),
      manager: bcrypt.hashSync(DEMO_PASSWORDS.manager, 12),
      employee: bcrypt.hashSync(DEMO_PASSWORDS.employee, 12),
    };
    const adminId = insUser.run('admin', 'admin@shiftly.demo', 'דנה שלום', hash.admin, roleId.admin, null).lastInsertRowid;

    const emps = [];
    let ti = 0;
    people.forEach(([first, last, posKey, depKey, wage, role, uname, status = 'active'], i) => {
      const username = uname || translit[ti++];
      const email = `${username}@shiftly.demo`;
      const start = addDays(todayLocal(), -between(60, 1600));
      const id = insEmp.run(
        `EMP-${String(1001 + i)}`, first, last, `05${between(0, 8)}-${between(100, 999)}${between(1000, 9999)}`, email,
        pos[posKey], dep[depKey], i % 3 === 2 ? locs[1] : locs[0], start, status, wage,
      ).lastInsertRowid;
      const userId = insUser.run(username, email, `${first} ${last}`, role ? hash.manager : hash.employee, roleId[role || 'employee'], id).lastInsertRowid;
      emps.push({ id, userId, name: `${first} ${last}`, posKey, depKey, status, role: role || 'employee', loc: i % 3 === 2 ? locs[1] : locs[0] });
    });
    const managers = emps.filter((e) => e.role === 'shift_manager');

    // ---------- shifts & attendance ----------
    const now = nowLocal();
    const today = todayLocal();
    const startDay = addDays(today, -45);
    const endDay = addDays(today, 21);
    const patterns = {
      kitchen: [['07:00', '15:00'], ['14:00', '22:00']],
      service: [['10:00', '17:00'], ['17:00', '23:30']],
      sales: [['08:00', '16:00'], ['13:00', '21:00']],
      logistics: [['06:00', '14:00'], ['22:00', '06:00']],
      management: [['07:00', '16:00'], ['14:00', '23:00']],
    };
    const insShift = db.prepare('INSERT INTO shifts (employee_id, start_at, end_at, position_id, location_id, note, created_by, late_notified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insAtt = db.prepare('INSERT INTO attendance (shift_id, clock_in_at, clock_out_at, marked_absent, note, updated_by) VALUES (?, ?, ?, ?, ?, ?)');
    const notes = [null, null, null, null, 'פתיחת סניף', 'סגירת קופה', 'קבלת סחורה', 'אירוע פרטי בערב', null];

    for (const e of emps) {
      if (e.status === 'inactive') continue;
      const offDays = new Set([between(0, 6), between(0, 6)]);
      offDays.add(6); // most staff off on Saturday
      if (e.depKey === 'service' || e.depKey === 'kitchen') { offDays.delete(6); offDays.add(1); }
      for (let d = startDay; d <= endDay; d = addDays(d, 1)) {
        if (offDays.has(weekday(d))) continue;
        if (e.status === 'vacation' && d >= addDays(today, -3) && d <= addDays(today, 7)) continue;
        if (rnd() < 0.08) continue;
        const [st, en] = pick(patterns[e.depKey]);
        const startAt = `${d}T${st}`;
        const endAt = en <= st ? `${addDays(d, 1)}T${en}` : `${d}T${en}`;
        const shiftId = insShift.run(e.id, startAt, endAt, pos[e.posKey], e.loc, pick(notes), adminId, startAt < now ? 1 : 0).lastInsertRowid;
        if (startAt > now) continue;
        // Attendance for past / ongoing shifts
        const r = rnd();
        const ongoing = endAt > now;
        if (r < 0.04 && !ongoing) { if (rnd() < 0.5) insAtt.run(shiftId, null, null, 1, 'לא הגיע/ה ללא הודעה', managers[0].userId); continue; }
        const late = r < 0.14 ? between(8, 40) : between(-8, 3);
        const inAt = addMinutes(startAt, late);
        if (inAt > now) continue; // not arrived yet
        let outAt = null;
        if (!ongoing) {
          const rr = rnd();
          const delta = rr < 0.05 ? -between(20, 90) : rr < 0.25 ? between(20, 100) : between(-4, 10);
          outAt = addMinutes(endAt, delta);
          if (outAt > now) outAt = null;
        }
        insAtt.run(shiftId, inAt, outAt, 0, null, null);
      }
    }

    // Guarantee a lively "current shift" with a late employee for the demo
    const curStart = addMinutes(now, -150).slice(0, 14) + '00';
    const curEnd = addMinutes(curStart, 8 * 60);
    for (const [idx, lateMin] of [[2, -3], [5, 25], [9, 1], [13, null]]) {
      const e = emps[idx];
      const clash = db.prepare("SELECT 1 FROM shifts WHERE employee_id = ? AND status = 'scheduled' AND start_at < ? AND end_at > ?").get(e.id, curEnd, curStart);
      if (clash) continue;
      const id = insShift.run(e.id, curStart, curEnd, pos[e.posKey], e.loc, null, adminId, 1).lastInsertRowid;
      if (lateMin !== null) insAtt.run(id, addMinutes(curStart, lateMin), null, 0, null, null);
    }

    // ---------- requests ----------
    const insReq = db.prepare(
      `INSERT INTO requests (employee_id, type, start_date, end_date, details, status, manager_response, reviewed_by, reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const reqs = [
      [3, 'vacation', 10, 14, 'חופשה משפחתית בצפון', 'pending'],
      [6, 'day_off', 5, null, 'תור לרופא', 'pending'],
      [11, 'general', 3, null, 'אבקש לעבור לסניף חיפה מהחודש הבא', 'pending'],
      [14, 'availability', 7, null, 'מהשבוע הבא אוכל לעבוד רק במשמרות בוקר בגלל לימודים', 'pending'],
      [8, 'day_off', 9, null, 'חתונה של אחי', 'pending'],
      [4, 'vacation', -20, -17, 'נסיעה לחו"ל', 'approved', 'אושר, תהנה!'],
      [7, 'vacation', -3, 7, 'חופשה שנתית', 'approved', 'מאושר'],
      [10, 'day_off', -10, null, 'יום הולדת', 'approved', null],
      [12, 'day_off', -6, null, 'אירוע משפחתי', 'rejected', 'אין מספיק כוח אדם ביום זה, נסה תאריך אחר'],
      [15, 'general', -12, null, 'בקשה לקבלת ביגוד עבודה חדש', 'approved', 'הוזמן'],
      [16, 'availability', -15, null, 'זמין גם בימי שישי', 'approved', 'תודה על העדכון'],
      [5, 'day_off', -2, null, 'מבחן באוניברסיטה', 'rejected', 'נא להגיש לפחות שבוע מראש'],
    ];
    for (const [ei, type, s, en, details, status, resp = null] of reqs) {
      const created = `${addDays(today, Math.min(s, 0) - between(2, 6))} ${String(between(8, 20)).padStart(2, '0')}:${String(between(10, 59))}:00`;
      insReq.run(emps[ei].id, type, addDays(today, s), en == null ? null : addDays(today, en), details, status, resp,
        status === 'pending' ? null : adminId, status === 'pending' ? null : created, created);
    }
    // a pending shift-swap request referencing a real upcoming shift
    const swapShift = db.prepare("SELECT id, start_at FROM shifts WHERE employee_id = ? AND start_at > ? ORDER BY start_at LIMIT 1").get(emps[9].id, now);
    if (swapShift) {
      db.prepare("INSERT INTO requests (employee_id, type, start_date, shift_id, swap_with_id, details) VALUES (?, 'shift_swap', ?, ?, ?, ?)")
        .run(emps[9].id, swapShift.start_at.slice(0, 10), swapShift.id, emps[10].id, 'הילה הסכימה להחליף איתי את המשמרת');
    }

    // ---------- tasks ----------
    const insTask = db.prepare(
      `INSERT INTO tasks (title, description, assignee_id, created_by, due_date, priority, status, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tasks = [
      ['ספירת מלאי שבועית', 'ספירת מלאי מלאה במחסן הראשי ועדכון בגיליון', 13, 2, 'high', 'in_progress'],
      ['ניקיון מקרר תעשייתי', 'ניקוי יסודי ובדיקת טמפרטורות', 2, 1, 'normal', 'new'],
      ['הדרכת עובד חדש', 'הדרכה על הקופה ונהלי סגירה', 9, 4, 'normal', 'new'],
      ['הזמנת ירקות לסוף השבוע', 'לתאם עם הספק עד יום חמישי', 16, 0, 'urgent', 'new'],
      ['עדכון תפריט קיץ', 'להכין רשימת מנות חדשות לטעימות', 2, 10, 'low', 'in_progress'],
      ['תיקון מדפסת בקופה 2', 'לפתוח קריאת שירות', 10, -1, 'high', 'new'],
      ['סידור מחסן קירור', null, 14, 3, 'normal', 'new'],
      ['משלוח ללקוח עסקי', 'משלוח לחברת אורנים – 12 מגשים', 15, 1, 'urgent', 'in_progress'],
      ['בדיקת מטפי כיבוי', 'בדיקה תקופתית ותיעוד', 0, 6, 'normal', 'new'],
      ['ניקוי ויטרינה', null, 5, -2, 'low', 'done'],
      ['סגירת קופה חודשית', 'התאמת קופה ודוח Z', 9, -5, 'high', 'done'],
      ['הכנת שולחנות לאירוע', 'אירוע של 40 איש ביום שישי', 5, 2, 'high', 'new'],
      ['קבלת סחורה מספק', null, 13, -3, 'normal', 'done'],
      ['עדכון שלטי מבצעים', 'החלפת שילוט בכניסה', 11, 4, 'low', 'new'],
      ['הזמנת מדים חדשים', null, 1, 8, 'normal', 'cancelled'],
      ['ריענון נהלי בטיחות', 'מעבר עם הצוות על נהלי בטיחות במטבח', 16, 12, 'normal', 'new'],
    ];
    for (const [title, desc, ei, dueOff, prio, status] of tasks) {
      const creator = rnd() < 0.5 ? adminId : pick(managers).userId;
      insTask.run(title, desc, emps[ei].id, creator, addDays(today, dueOff), prio, status,
        status === 'done' ? `${addDays(today, dueOff)} 15:00:00` : null, `${addDays(today, -between(3, 12))} 09:00:00`);
    }

    // ---------- incidents ----------
    const insInc = db.prepare('INSERT INTO incidents (reported_by, title, description, severity, occurred_at) VALUES (?, ?, ?, ?, ?)');
    insInc.run(managers[0].userId, 'החלקה במטבח', 'עובד החליק ליד הכיור, ללא פגיעה. הוצב שלט אזהרה.', 'medium', `${addDays(today, -4)}T12:30`);
    insInc.run(managers[1].userId, 'תקלה במערכת הקופה', 'הקופה הושבתה ל-20 דקות', 'low', `${addDays(today, -2)}T18:10`);
    insInc.run(managers[0].userId, 'לקוח פגוע', 'לקוח התלונן על יחס, טופל מול המנהל', 'high', `${addDays(today, -1)}T20:45`);

    // ---------- availability ----------
    const insAv = db.prepare('INSERT INTO availability (employee_id, weekday, available, from_time, to_time, note) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of emps.slice(2, 9)) {
      for (let w = 0; w < 7; w += 1) {
        const avail = w !== 6 && rnd() > 0.15;
        insAv.run(e.id, w, avail ? 1 : 0, avail ? pick(['07:00', '08:00', '12:00']) : null, avail ? pick(['16:00', '22:00', '23:30']) : null, null);
      }
    }

    // ---------- staffing & shift leads (first-come picks demo) ----------
    db.prepare("UPDATE shift_types SET required_workers = 4, required_leads = 1 WHERE is_active = 1").run();
    for (const e of emps.filter((x) => x.role === 'shift_manager' || ['chef'].includes(x.posKey))) db.prepare('UPDATE employees SET can_lead = 1 WHERE id = ?').run(e.id);
    // a chef who leads shifts gets the shift-lead role (rights only during the shifts they lead)
    for (const e of emps.filter((x) => x.role === 'employee' && x.posKey === 'chef' && x.name.startsWith('יעל'))) db.prepare('UPDATE users SET role_id = ? WHERE id = ?').run(roleId.shift_lead, e.userId);

    // ---------- shift preferences for next week (scheduling board demo) ----------
    const types = db.prepare('SELECT id FROM shift_types WHERE is_active = 1 ORDER BY sort_order, id').all();
    const nextWeek = addDays(today, 7 - weekday(today));
    const insPref = db.prepare('INSERT INTO shift_preferences (employee_id, date, shift_type_id, preference) VALUES (?, ?, ?, ?)');
    const insSub = db.prepare('INSERT INTO schedule_submissions (employee_id, week_start, note) VALUES (?, ?, ?)');
    const subNotes = [null, null, 'מעדיף/ה בקרים השבוע', 'ביום שישי רק עד הצהריים', null, 'לימודים בימי שלישי'];
    for (const e of emps.filter((x) => x.status === 'active').slice(0, 14)) {
      insSub.run(e.id, nextWeek, pick(subNotes));
      for (let i = 0; i < 7; i += 1) {
        for (const t of types) {
          const r = rnd();
          insPref.run(e.id, addDays(nextWeek, i), t.id, r < 0.3 ? 'preferred' : r < 0.75 ? 'available' : 'unavailable');
        }
      }
    }

    // ---------- notifications ----------
    const insN = db.prepare('INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const ts = (daysAgo, h) => `${addDays(today, -daysAgo)} ${String(h).padStart(2, '0')}:15:00`;
    for (const e of emps) {
      insN.run(e.userId, 'shift_assigned', 'פורסם סידור עבודה לשבוע הבא', 'כנסו לצפות במשמרות שלכם', '/shifts', 0, ts(1, 9));
      insN.run(e.userId, 'shift_changed', 'משמרת שלך השתנתה', 'שעת ההתחלה עודכנה', '/shifts', 1, ts(4, 11));
    }
    insN.run(emps[4].userId, 'request_approved', 'הבקשה שלך אושרה', 'בקשת חופשה · אושר, תהנה!', '/requests', 0, ts(2, 10));
    insN.run(emps[12].userId, 'request_rejected', 'הבקשה שלך נדחתה', 'בקשת יום חופש', '/requests', 0, ts(1, 14));
    insN.run(emps[16].userId, 'task_assigned', 'משימה חדשה הוקצתה לך', 'הזמנת ירקות לסוף השבוע', '/tasks', 0, ts(0, 8));
    for (const uid of [adminId, ...managers.map((m) => m.userId)]) {
      insN.run(uid, 'employee_late', `${emps[5].name} איחר/ה למשמרת`, 'איחור של 25 דקות', '/attendance', 0, ts(0, 10));
      insN.run(uid, 'task_done', 'משימה הושלמה', 'סגירת קופה חודשית · רוני גבאי', '/tasks', 1, ts(5, 16));
    }
    insN.run(adminId, 'request_new', 'בקשת חופשה חדשה', `${emps[3].name}`, '/requests', 0, ts(1, 12));
    insN.run(adminId, 'request_new', 'בקשת יום חופש חדשה', `${emps[6].name}`, '/requests', 0, ts(0, 9));
    insN.run(adminId, 'incident', 'דווח אירוע בחומרה גבוהה', 'לקוח פגוע', '/attendance', 0, ts(1, 21));

    // ---------- audit history ----------
    const insA = db.prepare('INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, description, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const utc = (daysAgo, h) => `${addDays(today, -daysAgo)} ${String(h).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}:00`;
    insA.run(adminId, 'דנה שלום', 'shift.copy_week', 'shift', null, 'דנה שלום שכפל/ה את סידור השבוע לשבוע הבא', null, JSON.stringify({ created: 96 }), utc(3, 8));
    insA.run(adminId, 'דנה שלום', 'shift.update', 'shift', null, `דנה שלום שינה/תה את המשמרת של ${emps[3].name} מ-16:00 ל-17:00`, JSON.stringify({ start_at: '16:00' }), JSON.stringify({ start_at: '17:00' }), utc(2, 9));
    insA.run(emps[3].userId, emps[3].name, 'request.create', 'request', null, `${emps[3].name} הגיש/ה בקשת חופשה`, null, null, utc(1, 10));
    insA.run(managers[0].userId, managers[0].name, 'task.create', 'task', null, `${managers[0].name} יצר/ה משימה "ספירת מלאי שבועית" עבור ${emps[13].name}`, null, null, utc(1, 11));
    insA.run(emps[9].userId, emps[9].name, 'task.status', 'task', null, `${emps[9].name} שינה/תה את סטטוס המשימה "סגירת קופה חודשית" ל"הושלמה"`, JSON.stringify({ status: 'in_progress' }), JSON.stringify({ status: 'done' }), utc(1, 15));
    insA.run(adminId, 'דנה שלום', 'request.approved', 'request', null, `דנה שלום אישר/ה את בקשת חופשה של ${emps[7].name}`, JSON.stringify({ status: 'pending' }), JSON.stringify({ status: 'approved' }), utc(0, 6));
    insA.run(emps[2].userId, emps[2].name, 'attendance.clock_in', 'shift', null, `${emps[2].name} נכנס/ה למשמרת`, null, null, utc(0, 7));
  });
  run();
}

export function seedIfEmpty(db = getDb()) {
  const has = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
  if (has) return;
  // SEED_DEMO=false starts with an empty business; ADMIN_PASSWORD sets the admin's password
  const demo = process.env.SEED_DEMO !== 'false';
  const adminPassword = process.env.ADMIN_PASSWORD || DEMO_PASSWORDS.admin;
  seed(db, { demo, adminPassword });
  console.log(demo ? '🌱 Demo data created' : '🌱 Empty database created (user: admin)');
}

// `npm run seed` — wipe and recreate the demo database
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const fs = await import('node:fs');
  const { config } = await import('../config.js');
  for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
  seed(getDb());
  console.log('🌱 Database reset with demo data:', config.dbFile);
}
