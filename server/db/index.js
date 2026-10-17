import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

let db;

const hasColumn = (d, table, col) => d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

/** Idempotent schema upgrades for databases created by earlier versions. */
function migrate(d) {
  if (!hasColumn(d, 'shifts', 'shift_type_id')) {
    d.exec('ALTER TABLE shifts ADD COLUMN shift_type_id INTEGER REFERENCES shift_types(id) ON DELETE SET NULL');
  }
  if (!hasColumn(d, 'shifts', 'is_lead')) {
    d.exec('ALTER TABLE shifts ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0');
  }
  d.exec('CREATE INDEX IF NOT EXISTS idx_shifts_type ON shifts(shift_type_id, start_at)');

  // v3 columns
  const add = (table, col, ddl) => { if (!hasColumn(d, table, col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
  add('employees', 'can_lead', 'INTEGER NOT NULL DEFAULT 0');            // may serve as shift lead (אחמ"ש)
  add('employees', 'national_id', 'TEXT');                                // ת"ז – for the accountant report
  add('users', 'location_id', 'INTEGER REFERENCES locations(id) ON DELETE SET NULL'); // branch scope (NULL = all)
  add('users', 'totp_secret', 'TEXT');
  add('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  add('users', 'recovery_codes', 'TEXT');                                 // JSON array of sha256 hashes
  add('users', 'dashboard_prefs', 'TEXT');                                // JSON: hidden widgets
  add('users', 'totp_last_step', 'INTEGER');                               // replay protection for 2FA codes
  add('shift_types', 'required_workers', 'INTEGER NOT NULL DEFAULT 0');
  add('shift_types', 'required_leads', 'INTEGER NOT NULL DEFAULT 0');
  add('schedule_assignments', 'status', "TEXT NOT NULL DEFAULT 'approved'"); // 'claimed' = picked by employee, awaiting approval
  add('schedule_assignments', 'claimed_at', 'TEXT');
  add('locations', 'latitude', 'REAL');
  add('locations', 'longitude', 'REAL');
  add('locations', 'radius_m', 'INTEGER NOT NULL DEFAULT 150');
  add('locations', 'require_location', 'INTEGER NOT NULL DEFAULT 0');
  add('attendance', 'clock_in_distance_m', 'INTEGER');
  add('attendance', 'clock_out_distance_m', 'INTEGER');
  add('shifts', 'end_reminded', 'INTEGER NOT NULL DEFAULT 0');
  // New permission for existing installs: shift managers may post announcements
  if (!d.prepare("SELECT 1 FROM settings WHERE key = 'perm_v3'").get()) {
    const sm = d.prepare("SELECT id FROM roles WHERE key = 'shift_manager'").get();
    if (sm) d.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, 'announcements.manage')").run(sm.id);
    d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('perm_v3', '1')").run();
  }
  // Default shift templates so the scheduling screen works out of the box
  if (!d.prepare('SELECT 1 FROM shift_types LIMIT 1').get()) {
    const ins = d.prepare('INSERT INTO shift_types (name, start_time, end_time, sort_order) VALUES (?, ?, ?, ?)');
    ins.run('בוקר', '07:00', '15:00', 1);
    ins.run('ערב', '15:00', '23:00', 2);
  }
}

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = new Database(file);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  instance.exec(schema);
  migrate(instance);
  return instance;
}

export function getDb() {
  if (!db) db = openDb();
  return db;
}

export function setDb(instance) {
  db = instance;
}

/** Run fn inside a transaction and return its result. */
export function tx(fn) {
  return getDb().transaction(fn)();
}
