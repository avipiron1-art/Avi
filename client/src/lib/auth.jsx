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

  const login = async (identifier, password, remember) => {
    await api.post('/auth/login', { identifier, password, remember });
    await refresh();
  };
  const logout = async () => {
    try { await api.post('/auth/logout'); } finally { setUser(null); setMeta(null); }
  };
  const reloadMeta = async () => setMeta(await api.get('/meta'));
  const can = (...perms) => !!user && perms.some((p) => user.permissions.includes(p));

  return <AuthCtx.Provider value={{ user, meta, login, logout, refresh, reloadMeta, can }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
