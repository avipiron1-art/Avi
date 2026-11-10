import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler, clearApiCache } from './api.js';

const AuthCtx = createContext(null);

// The signed-in user and the business lists are kept on the phone, so the app can open instantly
// with them while the server confirms the session in the background.
const SESSION_KEY = 'session-cache';
const readSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
const writeSession = (v) => { try { if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ } };
const forget = () => { writeSession(null); clearApiCache(); };

export function AuthProvider({ children }) {
  const [cached] = useState(readSession);
  const [user, setUser] = useState(cached?.user ?? undefined); // undefined = loading, null = signed out
  const [meta, setMeta] = useState(cached?.meta ?? null);

  const refresh = useCallback(async () => {
    try {
      const [{ user: u }, m] = await Promise.all([api.get('/auth/me'), api.get('/meta')]);
      setMeta(m);
      setUser(u);
    } catch (e) {
      // No connection: keep the saved session so the app still opens; signed out: forget it
      if (e?.status === 0 && readSession()?.user) return;
      forget();
      setUser(null);
      setMeta(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => { forget(); setUser(null); });
    refresh();
  }, [refresh]);

  useEffect(() => { if (user && meta) writeSession({ user, meta }); }, [user, meta]);

  /** Returns { mfa_required, mfa_token } when a code from the authenticator app is needed. */
  const login = async (identifier, password, remember) => {
    const r = await api.post('/auth/login', { identifier, password, remember });
    if (r.mfa_required) return r;
    clearApiCache(); // nothing from a previous user on this phone
    await refresh();
    return r;
  };
  const logout = async () => {
    try { sessionStorage.removeItem('started'); } catch { /* storage unavailable */ }
    try { await api.post('/auth/logout'); } finally { forget(); setUser(null); setMeta(null); }
  };
  const reloadMeta = async () => setMeta(await api.get('/meta'));
  const can = (...perms) => !!user && perms.some((p) => user.permissions.includes(p));

  const setPrefs = (prefs) => setUser((u) => (u ? { ...u, prefs } : u));
  return <AuthCtx.Provider value={{ user, meta, login, logout, refresh, reloadMeta, can, setPrefs }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
