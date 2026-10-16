import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

let db;

export function openDb(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = new Database(file);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  instance.exec(schema);
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
