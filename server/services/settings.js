import { getDb } from '../db/index.js';

export const DEFAULT_SETTINGS = {
  business_name: 'Shiftly – ניהול כוח אדם',
  timezone: 'Asia/Jerusalem',
  late_grace_minutes: '5',        // arrival after start + grace = late
  early_leave_grace_minutes: '5',
  overtime_daily_hours: '8',      // hours beyond this per shift count as overtime
  currency: '₪',
  task_due_soon_days: '2',
};

let cache = null;

export function loadSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  cache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  return cache;
}

export function getSetting(key) {
  if (!cache) loadSettings();
  return cache[key];
}

export const getNumberSetting = (key) => Number(getSetting(key)) || 0;

export function updateSettings(values) {
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [k, v] of Object.entries(values)) stmt.run(k, String(v));
  return loadSettings();
}

export function resetSettingsCache() {
  cache = null;
}
