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
