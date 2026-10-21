import { getLang } from './i18n.js';

const KEY = 'h360.session';

/**
 * Session handling.
 *  - The short-lived access token lives only in memory.
 *  - The refresh token (rotating, revocable on the server) is kept in localStorage so a page reload keeps you logged in.
 *    This is why the app ships a strict Content-Security-Policy and never writes server data as HTML.
 */
let accessToken = null;
let session = readSession(); // { refreshToken, user }
const listeners = new Set();

function readSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && typeof s.refreshToken === 'string' ? s : null;
  } catch {
    return null;
  }
}
function writeSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  } catch { /* storage blocked: session lasts until reload */ }
  listeners.forEach((f) => f());
}

export const onAuthChange = (f) => (listeners.add(f), () => listeners.delete(f));
export const getUser = () => session?.user ?? null;
export const isLoggedIn = () => session !== null;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Call with the body of a successful /auth/otp/verify or /auth/google response. */
export function startSession(resp) {
  accessToken = resp.accessToken;
  writeSession({ refreshToken: resp.refreshToken, user: resp.user });
}

let refreshing = null;
/** Only one refresh at a time: the server rotates refresh tokens, so two parallel refreshes would look like token theft. */
function refresh() {
  if (!session) return Promise.resolve(false);
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (res.status === 401 || res.status === 400) {
          accessToken = null;
          writeSession(null);
          return false;
        }
        if (!res.ok) return false;
        const data = await res.json();
        accessToken = data.accessToken;
        if (session) writeSession({ ...session, refreshToken: data.refreshToken });
        return true;
      } catch {
        return false; // offline: keep the session, try again later
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

export async function api(method, path, { body, auth = true, query } = {}) {
  if (auth && !session) throw new ApiError(401, 'unauthorized');
  const url = new URL(path, location.origin);
  url.searchParams.set('lang', getLang());
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));

  const send = () =>
    fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  if (auth && !accessToken) await refresh();
  if (auth && !session) throw new ApiError(401, 'unauthorized');

  let res;
  try {
    res = await send();
    if (res.status === 401 && auth && session && (await refresh())) res = await send();
  } catch {
    throw new ApiError(0, 'network');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'generic', data?.message, data?.details ?? data?.reasons);
  return data;
}

/**
 * Fetches a protected image (photos and ID documents need the login token, so <img src> cannot load them directly)
 * and returns a temporary blob: URL for it. Call URL.revokeObjectURL(url) when finished.
 */
export async function apiBlobUrl(path) {
  if (!session) throw new ApiError(401, 'unauthorized');
  if (!accessToken) await refresh();
  const get = () => fetch(path, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
  let res;
  try {
    res = await get();
    if (res.status === 401 && session && (await refresh())) res = await get();
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) throw new ApiError(res.status, 'not_found');
  return URL.createObjectURL(await res.blob());
}

/** On page load: turn a stored refresh token into an access token and fetch the current profile. */
export async function restoreSession() {
  if (!session) return;
  if (!(await refresh()) || !session) return;
  try {
    const me = await api('GET', '/auth/me');
    writeSession({ ...session, user: { id: me.id, email: me.email, role: me.role, fullName: me.fullName, locale: me.locale } });
  } catch { /* the stored user is good enough until the next call */ }
}

export async function logout() {
  const token = session?.refreshToken;
  accessToken = null;
  writeSession(null);
  if (token) {
    try {
      await fetch('/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) });
    } catch { /* already logged out locally */ }
  }
}
