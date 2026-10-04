// Content-source acquisition only; reuse the project's login and collection tools.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createAuthenticatedRequester, runCollection } from '../../collect-subtitles.mjs';
import { parseCorpus, CollectionError } from '../../acquisition.mjs';
import { qrLogin } from '../../qr-login.mjs';
import { renderQr } from '../../crawl.mjs';
const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(base, '../../..');
if (execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim() !== 'test-branch') throw Error('test-branch required');
const inputPath = path.join(base, 'acquisition/subtitles-authenticated.jsonl');
const outputPath = path.join(base, 'acquisition/subtitles-retry.jsonl');
const diagnosticPath = path.join(base, 'acquisition/retry-schema-events.jsonl');
const records = parseCorpus(await fs.readFile(inputPath, 'utf8'));
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
let authenticated;
const request = async (url, options) => {
  if (!authenticated) {
    console.log(JSON.stringify({ event: 'phone-confirmation-required', reason: 'Prior in-memory login process ended; retry missing subtitle schema at 4-second request interval.' }));
    const cookieHeader = await qrLogin({ signal: controller.signal,
      renderQr: url => renderQr(url, { qr: path.join(base, 'acquisition/retry-login-qr.png'), python: 'python3', qrModulePath: '/private/tmp/bilismartskip-qr-runtime' }),
      onState: state => console.log(JSON.stringify({ event: 'login', state })) });
    authenticated = createAuthenticatedRequester({ cookieHeader, intervalMs: 4000 });
  }
  const result = await authenticated(url, options);
  const endpoint = new URL(url);
  if (endpoint.origin === 'https://api.bilibili.com') {
    const entry = { observedAt: new Date().toISOString(), bvid: endpoint.searchParams.get('bvid'), cid: endpoint.searchParams.get('cid'),
      code: result?.code, dataKeys: Object.keys(result?.data || {}),
      needLoginSubtitle: result?.data?.need_login_subtitle,
      subtitleKeys: Object.keys(result?.data?.subtitle || {}),
      subtitleTrackCount: Array.isArray(result?.data?.subtitle?.subtitles) ? result.data.subtitle.subtitles.length : null };
    await fs.appendFile(diagnosticPath, JSON.stringify(entry) + '\n');
    // Do not repeatedly hit an interface that is returning a degraded schema.
    if (result?.code === 0 && result.data && !result.data.need_login_subtitle && !Array.isArray(result.data.subtitle?.subtitles)) {
      throw new CollectionError('missing-subtitle-schema-on-slower-retry', { status: 'unsupported', pause: true });
    }
  }
  return result;
};
try {
  const result = await runCollection(records, { request, outputPath, signal: controller.signal, retryUnavailable: true,
    onProgress: progress => console.log(JSON.stringify({ event: 'progress', ...progress })) });
  console.log(JSON.stringify({ event: 'complete', ...result.summary }));
  if (result.summary.paused) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ event: 'stopped', reason: /^(login-|qr-)/.test(error.message) ? error.message : error.name }));
  process.exitCode = 1;
} finally { authenticated = undefined; }
