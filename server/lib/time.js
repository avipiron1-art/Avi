// All business times are local wall-clock strings: 'YYYY-MM-DDTHH:MM'.
// Lexicographic comparison of these strings equals chronological comparison.
import { getSetting } from '../services/settings.js';

const pad = (n) => String(n).padStart(2, '0');

export function nowLocal(date = new Date()) {
  const tz = getSetting('timezone') || 'Asia/Jerusalem';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export const todayLocal = () => nowLocal().slice(0, 10);

/** Parse 'YYYY-MM-DDTHH:MM' as a naive UTC instant (used only for arithmetic). */
export function toMs(s) {
  const [d, t = '00:00'] = s.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  return Date.UTC(y, m - 1, day, hh, mm);
}

export function fromMs(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export const minutesBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / 60000);
export const addMinutes = (s, m) => fromMs(toMs(s) + m * 60000);
export const addDays = (dateStr, n) => fromMs(toMs(dateStr) + n * 86400000).slice(0, 10);
export const weekday = (dateStr) => new Date(toMs(dateStr)).getUTCDay();

export function startOfWeek(dateStr) {
  return addDays(dateStr, -weekday(dateStr)); // weeks start on Sunday
}

export function monthRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const from = `${y}-${pad(m)}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${y}-${pad(m)}-${pad(last)}` };
}

export const hhmm = (s) => (s ? s.slice(11, 16) : '');
export { pad };
