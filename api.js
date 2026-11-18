// HATO · cliente mínimo de Supabase (Auth + REST), sin dependencias.

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, network = false, auth = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.network = network;
    this.auth = auth;
  }
}

export function createApi({ url, key, storage, fetchImpl, now = () => Date.now(), timeoutMs = 15000 }) {
  const SK = 'hato_session';
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let refreshing = null;

  function getSession() {
    try { return JSON.parse(storage.getItem(SK)); } catch { return null; }
  }
  function setSession(s) {
    if (s) storage.setItem(SK, JSON.stringify(s));
    else storage.removeItem(SK);
  }

  async function raw(path, { method = 'GET', body, headers = {}, token } = {}) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await doFetch(url + path, {
        method,
        headers: { apikey: key, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
    } catch {
      throw new ApiError('Sin conexión', { network: true });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = (json && (json.error_code || (typeof json.code === 'string' ? json.code : null))) || null;
      const message = (json && (json.message || json.msg || json.error_description)) || `Error ${res.status}`;
      throw new ApiError(message, { status: res.status, code });
    }
    return json;
  }

  function guardar(j) {
    const s = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(now() / 1000) + (j.expires_in || 3600),
      user: { id: j.user.id, email: j.user.email },
      expired: false,
    };
    setSession(s);
    return s;
  }

  async function login(email, password) {
    const j = await raw('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    return guardar(j);
  }

  function refresh() {
    if (refreshing) return refreshing;
    const actual = getSession();
    if (!actual || !actual.refresh_token) return Promise.reject(new ApiError('Sesión vencida', { status: 401, auth: true }));
    refreshing = (async () => {
      try {
        const j = await raw('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: actual.refresh_token } });
        return guardar(j);
      } catch (e) {
        if (e.status === 400 || e.status === 401 || e.status === 403) {
          setSession({ ...actual, expired: true });
          throw new ApiError('Sesión vencida', { status: 401, auth: true });
        }
        throw e; // sin conexión u otro: se conserva la sesión
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function authed(path, opts = {}) {
    let s = getSession();
    if (!s || s.expired) throw new ApiError('Sesión vencida', { status: 401, auth: true });
    if (s.expires_at - now() / 1000 < 60) s = await refresh();
    try {
      return await raw(path, { ...opts, token: s.access_token });
    } catch (e) {
      if (e.status === 401 && !e.network) {
        s = await refresh();
        return raw(path, { ...opts, token: s.access_token });
      }
      throw e;
    }
  }

  function rest(method, path, body, headers) {
    return authed(`/rest/v1${path}`, { method, body, headers });
  }

  async function logout() {
    const s = getSession();
    if (s && !s.expired) { try { await raw('/auth/v1/logout', { method: 'POST', token: s.access_token }); } catch { /* sin conexión: igual se cierra localmente */ } }
    setSession(null);
  }

  return { getSession, setSession, login, refresh, rest, logout };
}
