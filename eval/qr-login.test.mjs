import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginCookieJar, qrLogin } from './qr-login.mjs';

const response = (data, cookies = [], code = 0) => ({ ok: true, status: 200,
  headers: { getSetCookie: () => cookies }, json: async () => ({ code, data }) });
const generated = { url: 'https://passport.bilibili.com/test?opaque=qr-secret', qrcode_key: 'poll-secret' };

test('login cookies are scoped to official hosts/path and remain in memory', () => {
  const jar = new LoginCookieJar();
  jar.absorb({ getSetCookie: () => [
    'SESSDATA=secret; Domain=.bilibili.com; Path=/; Secure',
    'local=passport; Path=/', 'wrong=external; Domain=example.com; Path=/',
    'narrow=private; Domain=.bilibili.com; Path=/foo',
    'gone=old; Domain=.bilibili.com; Path=/; Max-Age=0'
  ] });
  assert.equal(jar.header('https://api.bilibili.com/x/player/wbi/v2'), 'SESSDATA=secret');
  assert.equal(jar.header('https://aisubtitle.hdslb.com/a'), '');
  assert.equal(jar.header('http://api.bilibili.com/x/player/wbi/v2'), '');
  assert.equal(JSON.stringify(jar), '{}');
});

test('official QR state machine returns only an actual API-scoped session', async () => {
  const states = [], urls = [], rendered = [];
  const replies = [response(generated), response({ code: 86101 }), response({ code: 86090 }),
    response({ code: 0, refresh_token: 'do-not-store' }, ['SESSDATA=session; Domain=.bilibili.com; Path=/'])];
  const cookie = await qrLogin({ intervalMs: 0, renderQr: async url => rendered.push(url), onState: state => states.push(state),
    fetchImpl: async (url, options) => { assert.equal(options.redirect, 'error'); urls.push(url); return replies.shift(); } });
  assert.equal(cookie, 'SESSDATA=session');
  assert.deepEqual(states, ['waiting-for-scan', 'waiting-for-phone-confirmation', 'authenticated']);
  assert.deepEqual(rendered, [generated.url]);
  assert.equal(new URL(urls[1]).searchParams.get('qrcode_key'), generated.qrcode_key);
  assert.doesNotMatch(states.join(), /secret|session|token/);
});

test('expiry, missing session and risk rejection stop without alternative endpoints', async () => {
  for (const [last, reason] of [[response({ code: 86038 }), /expired/], [response({ code: 0 }), /without-api-session/],
    [response(null, [], -352), /api--352/], [{ ok: false, status: 412 }, /http-412/]]) {
    let calls = 0;
    await assert.rejects(qrLogin({ intervalMs: 0, renderQr: async () => {},
      fetchImpl: async () => ++calls === 1 ? response(generated) : last }), reason);
    assert.equal(calls, 2);
  }
});

test('QR host mismatch and aborted login do not leak login data to another host', async () => {
  let rendered = false;
  await assert.rejects(qrLogin({ renderQr: async () => { rendered = true; }, fetchImpl: async () =>
    response({ ...generated, url: 'https://example.com/qr' }) }), /unexpected-qr-host/);
  assert.equal(rendered, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(qrLogin({ signal: controller.signal, renderQr: async () => {},
    fetchImpl: () => assert.fail('aborted login must not request') }), { name: 'AbortError' });
});

test('current official account scan-web QR is accepted without changing its challenge', async () => {
  const url = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?key=short-lived';
  let calls = 0, rendered;
  await assert.rejects(qrLogin({ intervalMs: 0, renderQr: async value => { rendered = value; },
    fetchImpl: async () => ++calls === 1 ? response({ ...generated, url }) : response({ code: 86038 }) }), /expired/);
  assert.equal(rendered, url);
});
