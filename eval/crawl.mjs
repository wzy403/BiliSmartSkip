#!/usr/bin/env node
import { readFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseCorpus, CollectionError } from './acquisition.mjs';
import { createAuthenticatedRequester, runCollection } from './collect-subtitles.mjs';
import { qrLogin, loginTerms } from './qr-login.mjs';

export function parseArguments(args) {
  const options = { python: 'python3', qr: 'eval/output/login-qr.png', retryUnavailable: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--retry-unavailable') { options.retryUnavailable = true; continue; }
    if (flag === '--help') { options.help = true; continue; }
    const name = { '--input': 'input', '--out': 'output', '--qr': 'qr', '--python': 'python', '--qr-module-path': 'qrModulePath' }[flag];
    if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid-cli-arguments');
    options[name] = args[++i];
  }
  if (!options.help && (!options.input || !options.output)) throw new Error('input-and-output-required');
  if (options.input && path.resolve(options.input) === path.resolve(options.output)) throw new Error('input-and-output-must-differ');
  return options;
}

export async function renderQr(url, { qr, python, qrModulePath }) {
  await mkdir(path.dirname(path.resolve(qr)), { recursive: true });
  // Supply the short-lived challenge through stdin, never shell/argv/process logs.
  const result = spawnSync(python, ['-c',
    'import sys,qrcode\nfrom qrcode.image.pil import PilImage\nqrcode.make(sys.stdin.read(),image_factory=PilImage,box_size=8,border=4).save(sys.argv[1])',
    path.resolve(qr)], { input: url, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ...(qrModulePath ? { PYTHONPATH: qrModulePath } : {}) } });
  if (result.error || result.status !== 0) throw new Error('qr-render-failed-install-python-qrcode-and-pillow');
  await chmod(qr, 0o600);
  console.log(JSON.stringify({ event: 'qr-ready', path: path.resolve(qr) }));
}

export async function main(args) {
  const options = parseArguments(args);
  if (options.help) {
    console.log('node eval/crawl.mjs --input corpus.jsonl --out corpus-subtitles.jsonl [--qr login.png] [--python python3] [--qr-module-path DIRECTORY] [--retry-unavailable]');
    return;
  }
  const records = parseCorpus(await readFile(options.input, 'utf8'));
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let authenticatedRequest;
  // Authentication is lazy: a fully cached run needs no QR or new session.
  const request = async (url, requestOptions) => {
    if (!authenticatedRequest) {
      console.log(JSON.stringify({ event: 'phone-confirmation-required', ...loginTerms }));
      try {
        const cookieHeader = await qrLogin({ signal: controller.signal,
          renderQr: url => renderQr(url, options),
          onState: state => console.log(JSON.stringify({ event: 'login', state })) });
        authenticatedRequest = createAuthenticatedRequester({ cookieHeader });
      } catch (error) {
        controller.signal.throwIfAborted();
        const reason = /^(?:login-|qr-)/.test(error.message) ? error.message : 'login-failed';
        // Authentication failure pauses the whole batch; it must not generate one
        // QR per remaining video or silently turn access failures into empty data.
        throw new CollectionError(reason, { status: 'login-required', pause: true });
      }
    }
    return authenticatedRequest(url, requestOptions);
  };
  try {
    const result = await runCollection(records, { request, outputPath: options.output,
      signal: controller.signal, retryUnavailable: options.retryUnavailable,
      onProgress: progress => console.log(JSON.stringify({ event: 'progress', ...progress })) });
    console.log(JSON.stringify({ event: 'complete', output: path.resolve(options.output), ...result.summary }));
    if (result.summary.paused) process.exitCode = 2;
    return result;
  } finally {
    authenticatedRequest = undefined;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    // Do not echo fetch stacks, raw responses, cookie values, or signed URLs.
    const reason = /^(?:login-|qr-|invalid-cli|input-and-output)/.test(error.message) ? error.message : 'crawler-failed';
    console.error(JSON.stringify({ event: 'stopped', reason }));
    process.exitCode = 1;
  });
}
