const KEY = 'token';
export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

async function send(method, url, body, isForm) {
  const headers = {};
  if (getToken()) headers.Authorization = `Bearer ${getToken()}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch('/api' + url, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  if (res.status === 401 && getToken()) { setToken(null); window.dispatchEvent(new Event('auth:expired')); } // session ended
  return res;
}
async function req(method, url, body, isForm) {
  const res = await send(method, url, body, isForm);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
export const api = {
  get: (u) => req('GET', u), post: (u, b) => req('POST', u, b || {}), put: (u, b) => req('PUT', u, b), patch: (u, b) => req('PATCH', u, b), del: (u) => req('DELETE', u),
  upload: (u, file) => { const f = new FormData(); f.append('file', file); return req('POST', u, f, true); },
  /** Authenticated file download (plain <a href> links can't send the JWT). */
  download: async (u, filename) => {
    const res = await send('GET', u);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: filename });
    a.click(); URL.revokeObjectURL(a.href);
  },
};

// Everything the user sees is Indian Standard Time, whatever the browser's own zone is.
const IST = { timeZone: 'Asia/Kolkata' };
const valid = (d) => d && !isNaN(new Date(d));
export const fmtDate = (d) => (valid(d) ? new Date(d).toLocaleDateString('en-IN', { ...IST, year: 'numeric', month: 'short', day: 'numeric' }) : 'n/a');
export const fmtTime = (d) => (valid(d) ? `${new Date(d).toLocaleString('en-IN', { ...IST, day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} IST` : 'n/a');
