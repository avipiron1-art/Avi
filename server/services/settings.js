import { getDb } from '../db/index.js';

export const DEFAULT_SETTINGS = {
  business_name: 'Shiftly – ניהול כוח אדם',
  timezone: 'Asia/Jerusalem',
  late_grace_minutes: '5',        // arrival after start + grace = late
  early_leave_grace_minutes: '5',
  overtime_daily_hours: '8',      // hours beyond this per shift count as overtime
  currency: '₪',
  task_due_soon_days: '2',
  // branding
  brand_color: '#4f46e5',
  logo: '',
  // overtime (Israeli law defaults – verify with your accountant)
  ot_tier1_hours: '2',        // first overtime hours paid at rate_ot1
  rate_ot1: '1.25',
  rate_ot2: '1.5',
  rate_rest_day: '1.5',       // Shabbat / holiday base rate
  rest_day: '6',              // weekday of the weekly rest day (6 = Saturday)
  shift_end_reminder_minutes: '10',
  backup_keep: '30',
};

/** Settings that must never leave the server. */
export const SECRET_SETTINGS = ['vapid_private', 'gdrive_client_secret', 'gdrive_refresh_token', 'perm_v3'];

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
