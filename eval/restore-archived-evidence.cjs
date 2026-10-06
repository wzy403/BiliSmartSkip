#!/usr/bin/env node
'use strict';
// Optional acquisition intermediates and provenance for purged review media.
// Never required by replay. Version 1 manifests describe the historical archive.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const ARCHIVE_ROOT = 'eval/labels/assistant-content-extra300/acquisition/';
const DEFAULT_MANIFEST = 'eval/archives/extra300-acquisition-20261006-v2.json';

function validateManifest(manifest) {
  if (!manifest || ![1, 2].includes(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '')
    || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Invalid or empty archive manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    const name = entry?.path;
    if (typeof name !== 'string' || !name.startsWith(ARCHIVE_ROOT) || /[\\\0]/.test(name)
      || name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(name)) {
      throw Error(`Invalid, duplicate, or unsafe archive path: ${name}`);
    }
    const relative = name.slice(ARCHIVE_ROOT.length);
    const allowed = entry.category === 'raw-media'
      ? /^media\/[A-Za-z0-9._-]+\.(?:mp4|m4a|webm|mkv|mov|avi|mp3|aac|wav|flac|ogg|opus)$/i.test(relative)
      : entry.category === 'subtitle-acquisition'
        && /^subtitles-[A-Za-z0-9-]+\.jsonl(?:\.checkpoints\/[A-Za-z0-9._-]+\.json)?$/.test(relative);
    if (!allowed || (manifest.version === 2 && !['git', 'purged'].includes(entry.storage))
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !/^[a-f0-9]{40}$/.test(entry.gitBlob || '')) {
      throw Error(`Invalid archive metadata: ${name}`);
    }
    seen.add(name);
  }
  return manifest;
}

// Resolve from the real repository root, and reject symlinks in every component.
function safePath(repoRoot, relative, { makeParents = false } = {}) {
  const root = fs.realpathSync(repoRoot);
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (makeParents && i < parts.length - 1) {
        fs.mkdirSync(current);
        stat = fs.lstatSync(current);
      }
    }
    if (stat?.isSymbolicLink()) throw Error(`Refusing symbolic link: ${current}`);
    if (stat && (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw Error(`Unexpected file type in archive destination: ${current}`);
    }
  }
  return current;
}

async function fileDigest(filename) {
  const hash = createHash('sha256');
  let bytes = 0;
  const input = fs.createReadStream(filename, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  for await (const chunk of input) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

function checkDigest(actual, entry) {
  if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
    throw Error(`Archive integrity mismatch: ${entry.path} (expected ${entry.bytes} bytes / ${entry.sha256}, got ${actual.bytes} bytes / ${actual.sha256})`);
  }
}

async function readBlob(repoRoot, entry, output) {
  const hash = createHash('sha256');
  let bytes = 0, errorText = '';
  // Prevent a partial clone from fetching a missing object over the network.
  const child = spawn('git', ['cat-file', 'blob', entry.gitBlob], {
    cwd: repoRoot, env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(0, 4096); });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve() : reject(Error(
      `Cannot read archived Git blob ${entry.gitBlob} for ${entry.path}: ${errorText.trim() || `exit ${code}, signal ${signal}`}. Restore the repository's missing Git objects; this tool does not download them.`)));
  });
  const measure = new Transform({ transform(chunk, encoding, done) {
    hash.update(chunk); bytes += chunk.length; done(null, chunk);
  } });
  const sink = output || new Writable({ write(chunk, encoding, done) { done(); } });
  const streaming = pipeline(child.stdout, measure, sink).catch(error => { child.kill(); throw error; });
  // Wait for the writer to close even if Git fails first, before cleanup starts.
  const settled = await Promise.allSettled([completion, streaming]);
  for (const result of settled) if (result.status === 'rejected') throw result.reason;
  checkDigest({ bytes, sha256: hash.digest('hex') }, entry);
}

async function restoreEntry(repoRoot, entry) {
  let target = safePath(repoRoot, entry.path);
  if (fs.existsSync(target)) {
    checkDigest(await fileDigest(target), entry);
    return { path: entry.path, status: 'already-present' };
  }
  target = safePath(repoRoot, entry.path, { makeParents: true });
  const temporary = path.join(path.dirname(target), `.restore-${randomUUID()}.tmp`);
  try {
    const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    await readBlob(repoRoot, entry, output);
    // Recheck components after streaming; link refuses to overwrite a new file.
    safePath(repoRoot, entry.path);
    try { fs.linkSync(temporary, target); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      safePath(repoRoot, entry.path);
      checkDigest(await fileDigest(target), entry);
      return { path: entry.path, status: 'already-present' };
    }
    return { path: entry.path, status: 'restored' };
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function run(args = [], { repoRoot = path.resolve(__dirname, '..'), manifest,
  manifestFile = DEFAULT_MANIFEST, write = text => console.log(text) } = {}) {
  const command = args.length === 0 || (args.length === 1 && args[0] === '--list') ? 'list'
    : args.length === 1 && args[0] === '--verify' ? 'verify'
      : args.length === 2 && args[0] === '--restore' ? 'restore' : null;
  if (!command) throw Error('Usage: node eval/restore-archived-evidence.cjs [--list | --verify | --restore <full-relative-path|all>]');
  const archive = validateManifest(manifest ?? JSON.parse(fs.readFileSync(path.resolve(repoRoot, manifestFile), 'utf8')));
  const entries = command === 'restore' && args[1] !== 'all' ? archive.files.filter(entry => entry.path === args[1]) : archive.files;
  if (!entries.length) throw Error(`Path is not in the archive manifest: ${args[1]}`);
  if (command === 'restore' && args[1] !== 'all' && archive.version === 2 && entries[0].storage === 'purged') {
    throw Error(`Permanently removed from Git history; cannot restore: ${entries[0].path}. The archive retains provenance only.`);
  }
  const results = [];
  for (const entry of entries) {
    const storage = archive.version === 1 ? 'git' : entry.storage;
    let result;
    if (command === 'list') result = { path: entry.path, bytes: entry.bytes, category: entry.category, storage };
    else if (storage === 'purged') result = { path: entry.path, status: 'skipped-purged' };
    else if (command === 'verify') {
      await readBlob(repoRoot, entry);
      result = { path: entry.path, status: 'verified' };
    } else result = await restoreEntry(repoRoot, entry);
    results.push(result);
    write(command === 'list' ? `${entry.bytes}\t${entry.category}\t${storage}\t${entry.path}` : `${result.status}\t${entry.path}`);
  }
  return results;
}

if (require.main === module) run(process.argv.slice(2)).catch(error => {
  console.error(error.message); process.exitCode = 1;
});
module.exports = { ARCHIVE_ROOT, DEFAULT_MANIFEST, validateManifest, run };
