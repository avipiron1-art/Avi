import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Load data from the API; re-runs when deps change. Returns { data, error, loading, reload, setData }. */
export function useApi(path, query, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const key = JSON.stringify([path, query]);
  const load = useCallback(async ({ silent } = {}) => {
    if (!path) return;
    const id = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(path, query);
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  useEffect(() => { load(); }, [load]);
  const setData = (fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn }));
  return { ...state, reload: load, setData };
}

export function useDebounced(value, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useMediaQuery(q) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

const holidayCache = new Map();
/** Jewish/Israeli holidays between two dates → Map(date → [{ name, kind, paid }]). Cached per range. */
export function useHolidays(from, to) {
  const key = from && to ? `${from}|${to}` : null;
  const [map, setMap] = useState(() => (key && holidayCache.get(key)) || new Map());
  useEffect(() => {
    if (!key) return undefined;
    if (holidayCache.has(key)) { setMap(holidayCache.get(key)); return undefined; }
    let alive = true;
    api.get('/calendar/holidays', { from, to }).then((r) => {
      const m = new Map();
      for (const h of r.holidays) m.set(h.date, [...(m.get(h.date) || []), h]);
      holidayCache.set(key, m);
      if (alive) setMap(m);
    }).catch(() => {});
    return () => { alive = false; };
  }, [key, from, to]);
  return map;
}
