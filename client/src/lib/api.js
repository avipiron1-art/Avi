// Thin fetch wrapper: JSON, CSRF header, friendly Hebrew errors.
export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || 'אירעה שגיאה. נסו שוב.');
    this.status = status;
    this.data = data || {};
    this.fields = data?.fields || {};
  }
}

const csrfToken = () => document.cookie.split('; ').find((c) => c.startsWith('csrf='))?.slice(5) || '';

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body, query, raw = false } = {}) {
  let url = `/api${path}`;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''));
    if ([...qs].length) url += `?${qs}`;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken() } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { error: 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.' });
  }
  if (raw && res.ok) return res;
  const data = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    if (res.status === 429 && !data) throw new ApiError(429, { error: 'בוצעו יותר מדי בקשות. נסו שוב בעוד מספר דקות.' });
    throw new ApiError(res.status, data);
  }
  return data;
}

api.get = (p, query) => api(p, { query });
api.post = (p, body = {}) => api(p, { method: 'POST', body });
api.put = (p, body = {}) => api(p, { method: 'PUT', body });
api.patch = (p, body = {}) => api(p, { method: 'PATCH', body });
api.del = (p) => api(p, { method: 'DELETE' });

/** Download a file from the API (used for Excel / CSV export). */
export async function download(path, query, filename) {
  const res = await api(path, { query, raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
