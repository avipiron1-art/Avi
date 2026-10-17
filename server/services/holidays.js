// Israeli holidays (Hebcal, computed locally – no internet needed).
import { HebrewCalendar, flags } from '@hebcal/core';
import { getSetting } from './settings.js';
import { weekday } from '../lib/time.js';

const stripNiqqud = (s) => s.replace(/[֑-ׇ]/g, '');
// Modern holidays worth showing (the full list contains many minor memorial days)
const MODERN = new Set(["Yom HaShoah", "Yom HaZikaron", "Yom HaAtzma'ut", 'Yom Yerushalayim']);
const cache = new Map();

function yearEvents(year) {
  if (!cache.has(year)) {
    const events = HebrewCalendar.calendar({ start: new Date(year, 0, 1), end: new Date(year, 11, 31), il: true });
    const out = [];
    for (const e of events) {
      const f = e.getFlags();
      let kind = null;
      if (f & flags.CHAG) kind = 'chag';
      else if (f & flags.EREV) kind = 'erev';
      else if (f & flags.CHOL_HAMOED) kind = 'chol';
      else if ((f & flags.MODERN_HOLIDAY) && MODERN.has(e.getDesc())) kind = 'modern';
      else if (f & flags.MAJOR_FAST) kind = 'fast';
      else if ((f & flags.MINOR_HOLIDAY) && !(f & flags.MINOR_FAST)) kind = 'minor';
      if (!kind) continue;
      const g = e.getDate().greg();
      const date = `${g.getFullYear()}-${String(g.getMonth() + 1).padStart(2, '0')}-${String(g.getDate()).padStart(2, '0')}`;
      // Paid rest days: biblical holidays + Independence Day
      const paid = kind === 'chag' || e.getDesc() === "Yom HaAtzma'ut";
      out.push({ date, name: stripNiqqud(e.render('he')), kind, paid });
    }
    cache.set(year, out);
  }
  return cache.get(year);
}

export function holidaysBetween(from, to) {
  const out = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
    for (const h of yearEvents(y)) if (h.date >= from && h.date <= to) out.push(h);
  }
  return out;
}

/** Rest day for pay purposes: the weekly rest day (Saturday by default) or a paid holiday. */
export function isRestDay(date) {
  if (weekday(date) === Number(getSetting('rest_day') ?? 6)) return true;
  return yearEvents(Number(date.slice(0, 4))).some((h) => h.date === date && h.paid);
}
