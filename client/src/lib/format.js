// Formatting helpers & Hebrew labels. Business times arrive as 'YYYY-MM-DDTHH:MM' (local wall time);
// server timestamps (created_at) arrive as UTC 'YYYY-MM-DD HH:MM:SS'.
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const DAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

const pad = (n) => String(n).padStart(2, '0');

/** Parse a local date string as a UTC-based Date for safe day arithmetic. */
export const parseDate = (s) => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const addDays = (s, n) => { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return toDateStr(d); };
export const weekdayOf = (s) => parseDate(s).getUTCDay();
export const startOfWeek = (s) => addDays(s, -weekdayOf(s));
export const startOfMonth = (s) => `${s.slice(0, 8)}01`;
export const endOfMonth = (s) => { const [y, m] = s.split('-').map(Number); return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
export const addMonths = (s, n) => { const [y, m] = s.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return toDateStr(d); };
export function localToday() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

export const time = (s) => (s ? s.slice(11, 16) : '—');
export const dayName = (s) => DAYS[weekdayOf(s)];
export const shortDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}` : '—');
export const fullDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '—');
export const longDate = (s) => `יום ${dayName(s)}, ${Number(s.slice(8, 10))} ב${MONTHS[Number(s.slice(5, 7)) - 1]}`;
export const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const monthShort = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
export const shiftRange = (s) => `${time(s.start_at)}–${time(s.end_at)}`;

/** Server UTC timestamp → Date */
export const utc = (s) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`) : null);
export function dateTime(s) {
  const d = utc(s);
  if (!d) return '—';
  return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function timeAgo(s) {
  const d = utc(s);
  if (!d) return '';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'הרגע';
  if (sec < 3600) return `לפני ${Math.round(sec / 60)} דק׳`;
  if (sec < 86400) { const h = Math.round(sec / 3600); return h === 1 ? 'לפני שעה' : `לפני ${h} שעות`; }
  const days = Math.round(sec / 86400);
  if (days === 1) return 'אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  return d.toLocaleDateString('he-IL');
}

export const hours = (min) => `${(min / 60).toFixed(1)}`;
export function duration(min) {
  if (!min) return '0 דק׳';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} ש׳` : '', m ? `${m} דק׳` : ''].filter(Boolean).join(' ');
}
export const money = (n, cur = '₪') => `${cur}${Number(n || 0).toLocaleString('he-IL', { maximumFractionDigits: 0 })}`;
export const num = (n) => Number(n || 0).toLocaleString('he-IL');

// ---------- labels & tones ----------
export const EMPLOYEE_STATUS = {
  active: { label: 'פעיל', tone: 'success' },
  inactive: { label: 'לא פעיל', tone: 'neutral' },
  vacation: { label: 'בחופשה', tone: 'info' },
};
export const ATTENDANCE_STATUS = {
  not_started: { label: 'טרם התחיל', tone: 'neutral' },
  on_shift: { label: 'במשמרת', tone: 'success' },
  finished: { label: 'סיים', tone: 'info' },
  late: { label: 'איחר', tone: 'warning' },
  absent: { label: 'נעדר', tone: 'danger' },
};
export const TASK_STATUS = {
  new: { label: 'חדשה', tone: 'info' },
  in_progress: { label: 'בביצוע', tone: 'warning' },
  done: { label: 'הושלמה', tone: 'success' },
  cancelled: { label: 'בוטלה', tone: 'neutral' },
};
export const PRIORITY = {
  low: { label: 'נמוכה', tone: 'neutral' },
  normal: { label: 'רגילה', tone: 'info' },
  high: { label: 'גבוהה', tone: 'warning' },
  urgent: { label: 'דחופה', tone: 'danger' },
};
export const REQUEST_TYPE = {
  vacation: 'בקשת חופשה', day_off: 'בקשת יום חופש', shift_swap: 'החלפת משמרת', availability: 'עדכון זמינות', general: 'בקשה כללית',
};
export const REQUEST_STATUS = {
  pending: { label: 'ממתין', tone: 'warning' },
  approved: { label: 'אושר', tone: 'success' },
  rejected: { label: 'נדחה', tone: 'danger' },
};
export const SEVERITY = { low: { label: 'נמוכה', tone: 'neutral' }, medium: { label: 'בינונית', tone: 'warning' }, high: { label: 'גבוהה', tone: 'danger' } };
