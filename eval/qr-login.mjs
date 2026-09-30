import { setTimeout as delay } from 'node:timers/promises';

const PASSPORT = 'https://passport.bilibili.com';
const ROOT = `${PASSPORT}/x/passport-login/web/qrcode/`;
const API = 'https://api.bilibili.com/x/player/wbi/v2';
export const loginTerms = {
  agreement: 'https://www.bilibili.com/protocal/licence.html',
  privacy: 'https://www.bilibili.com/blackboard/privacy-pc.html'
};

// This jar only accepts cookies received from the official passport API. It is
// deliberately in memory: no browser profile, cookie file, or refresh-token store.
export class LoginCookieJar {
  #cookies = new Map();
  absorb(headers) {
    for (const value of headers.getSetCookie?.() || []) {
      const [pair, ...attributes] = value.split(';');
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at).trim(), content = pair.slice(at + 1).trim();
      if (!/^[A-Za-z0-9_]+$/.test(name) || /[\r\n]/.test(content)) continue;
      const attrs = Object.fromEntries(attributes.map(part => {
        const index = part.indexOf('=');
        return [part.slice(0, index < 0 ? undefined : index).trim().toLowerCase(),
          index < 0 ? '' : part.slice(index + 1).trim()];
      }));
      const domain = (attrs.domain || 'passport.bilibili.com').replace(/^\./, '').toLowerCase();
      if (!['bilibili.com', 'passport.bilibili.com'].includes(domain)) continue;
      const path = attrs.path || '/';
      const key = `${domain}|${path}|${name}`;
      const expires = attrs['max-age'] !== undefined ? Date.now() + Number(attrs['max-age']) * 1000
        : attrs.expires ? Date.parse(attrs.expires) : Infinity;
      if (Number.isNaN(expires) || expires <= Date.now()) this.#cookies.delete(key);
      else this.#cookies.set(key, { name, content, domain, path, expires });
    }
  }
  header(url) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !['passport.bilibili.com', 'api.bilibili.com'].includes(target.hostname)) return '';
    return [...this.#cookies.values()].filter(cookie => cookie.expires > Date.now()
      && (cookie.domain === 'bilibili.com' || cookie.domain === target.hostname)
      && (target.pathname === cookie.path || target.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/')))
      .map(cookie => `${cookie.name}=${cookie.content}`).join('; ');
  }
}

// The handset owner performs scanning/confirmation. No automatic agreement or
// alternate endpoint is attempted on expiry, risk control, or access rejection.
export async function qrLogin({ fetchImpl = globalThis.fetch, renderQr, onState = () => {},
  signal, intervalMs = 2000, maxWaitMs = 180000 } = {}) {
  if (typeof renderQr !== 'function') throw new Error('qr-renderer-required');
  const jar = new LoginCookieJar();
  async function request(url) {
    signal?.throwIfAborted();
    const headers = { 'User-Agent': 'BiliSmartSkip-Eval/0.1', Referer: `${PASSPORT}/login` };
    const cookie = jar.header(url);
    if (cookie) headers.Cookie = cookie;
    let response;
    try {
      response = await fetchImpl(url, { headers, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    } catch {
      signal?.throwIfAborted();
      throw new Error('login-network-error');
    }
    if (!response.ok) throw new Error(`login-http-${response.status}`);
    jar.absorb(response.headers);
    let body;
    try { body = await response.json(); } catch { throw new Error('login-response-not-json'); }
    if (body?.code !== 0) throw new Error(`login-api-${Number.isInteger(body?.code) ? body.code : 'invalid'}`);
    return body.data;
  }
  const generated = await request(`${ROOT}generate?source=main_web`);
  if (typeof generated?.qrcode_key !== 'string' || !generated.qrcode_key) throw new Error('login-missing-key');
  let qrUrl;
  try { qrUrl = new URL(generated.url); } catch { throw new Error('login-invalid-qr-url'); }
  // Current official generate responses use account.bilibili.com/…/scan-web;
  // older responses use passport.bilibili.com. Encode the returned URL verbatim.
  if (qrUrl.protocol !== 'https:' || !['passport.bilibili.com', 'account.bilibili.com'].includes(qrUrl.hostname)
    || qrUrl.port || qrUrl.username || qrUrl.password) throw new Error('login-unexpected-qr-host');
  await renderQr(qrUrl.href);
  onState('waiting-for-scan');
  const pollUrl = new URL(`${ROOT}poll`);
  pollUrl.searchParams.set('source', 'main_web');
  pollUrl.searchParams.set('qrcode_key', generated.qrcode_key);
  const deadline = Date.now() + maxWaitMs;
  let previous = 'waiting-for-scan';
  while (Date.now() < deadline) {
    await delay(intervalMs, undefined, { signal });
    const result = await request(pollUrl.href);
    if (result?.code === 0) {
      const cookieHeader = jar.header(API);
      if (!/(?:^|; )SESSDATA=[^;]+/.test(cookieHeader)) throw new Error('login-complete-without-api-session');
      onState('authenticated');
      return cookieHeader;
    }
    if (result?.code === 86038) throw new Error('login-qr-expired');
    const state = result?.code === 86101 ? 'waiting-for-scan'
      : result?.code === 86090 ? 'waiting-for-phone-confirmation' : null;
    if (!state) throw new Error(`login-poll-${Number.isInteger(result?.code) ? result.code : 'invalid'}`);
    if (state !== previous) { onState(state); previous = state; }
  }
  throw new Error('login-qr-timeout');
}
