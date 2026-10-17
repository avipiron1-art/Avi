import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [meta, setMeta] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [{ user: u }, m] = await Promise.all([api.get('/auth/me'), api.get('/meta')]);
      setMeta(m);
      setUser(u);
    } catch {
      setUser(null);
      setMeta(null);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    refresh();
  }, [refresh]);

  /** Returns { mfa_required, mfa_token } when a code from the authenticator app is needed. */
  const login = async (identifier, password, remember) => {
    const r = await api.post('/auth/login', { identifier, password, remember });
    if (r.mfa_required) return r;
    await refresh();
    return r;
  };
  const logout = async () => {
    try { sessionStorage.removeItem('started'); } catch { /* storage unavailable */ }
    try { await api.post('/auth/logout'); } finally { setUser(null); setMeta(null); }
  };
  const reloadMeta = async () => setMeta(await api.get('/meta'));
  const can = (...perms) => !!user && perms.some((p) => user.permissions.includes(p));

  const setPrefs = (prefs) => setUser((u) => (u ? { ...u, prefs } : u));
  return <AuthCtx.Provider value={{ user, meta, login, logout, refresh, reloadMeta, can, setPrefs }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
