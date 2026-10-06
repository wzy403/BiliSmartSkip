'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ARCHIVE_ROOT, run } = require('./restore-archived-evidence.cjs');

function fixture(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-archive-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const contents = [Buffer.from('original public review media\n'), Buffer.from('{"subtitle":"test"}\n')];
  const files = contents.map((body, i) => ({
    path: ARCHIVE_ROOT + (i ? 'subtitles-retry.jsonl.checkpoints/BVexample.json' : 'media/BVexample.mp4'),
    category: i ? 'subtitle-acquisition' : 'raw-media', bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    gitBlob: execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repoRoot, input: body, encoding: 'utf8' }).trim()
  }));
  const manifest = { version: 1, sourceCommit: '1'.repeat(40), files };
  const output = [], options = { repoRoot, manifest, write: line => output.push(line) };
  return { repoRoot, manifest, contents, options, output };
}

test('listing is the default and does not restore files; verify streams Git objects without working files', async t => {
  const f = fixture(t);
  const listed = await run([], f.options);
  assert.equal(listed.length, 2);
  assert.equal(fs.existsSync(path.join(f.repoRoot, ARCHIVE_ROOT)), false);
  const verified = await run(['--verify'], f.options);
  assert.ok(verified.every(row => row.status === 'verified'));
  assert.equal(fs.existsSync(path.join(f.repoRoot, ARCHIVE_ROOT)), false);
});

test('restore one or all files from local Git, preserves identical files, and never stages them', async t => {
  const f = fixture(t), first = f.manifest.files[0];
  assert.equal((await run(['--restore', first.path], f.options))[0].status, 'restored');
  assert.deepEqual(fs.readFileSync(path.join(f.repoRoot, first.path)), f.contents[0]);
  const all = await run(['--restore', 'all'], f.options);
  assert.deepEqual(all.map(row => row.status), ['already-present', 'restored']);
  assert.deepEqual(fs.readFileSync(path.join(f.repoRoot, f.manifest.files[1].path)), f.contents[1]);
  assert.equal(execFileSync('git', ['ls-files'], { cwd: f.repoRoot, encoding: 'utf8' }), '');
});

test('different existing content is never overwritten', async t => {
  const f = fixture(t), entry = f.manifest.files[0], filename = path.join(f.repoRoot, entry.path);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, 'user changes');
  await assert.rejects(run(['--restore', entry.path], f.options), /integrity mismatch/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'user changes');
});

test('missing and corrupt Git blobs fail clearly without a destination or temporary file', async t => {
  for (const mode of ['missing', 'corrupt', 'empty']) {
    const f = fixture(t), entry = f.manifest.files[0];
    if (mode === 'missing') entry.gitBlob = 'f'.repeat(40);
    else {
      const object = path.join(f.repoRoot, '.git/objects', entry.gitBlob.slice(0, 2), entry.gitBlob.slice(2));
      fs.chmodSync(object, 0o600);
      fs.writeFileSync(object, mode === 'empty' ? '' : 'broken object');
    }
    await assert.rejects(run(['--restore', entry.path], f.options), /Cannot read archived Git blob/);
    const dir = path.dirname(path.join(f.repoRoot, entry.path));
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('wrong SHA or size fails verification and cleans incomplete restoration', async t => {
  for (const key of ['sha256', 'bytes']) {
    const f = fixture(t), entry = f.manifest.files[0];
    entry[key] = key === 'bytes' ? entry.bytes + 1 : '0'.repeat(64);
    await assert.rejects(run(['--verify'], f.options), /integrity mismatch/);
    await assert.rejects(run(['--restore', entry.path], f.options), /integrity mismatch/);
    assert.deepEqual(fs.readdirSync(path.dirname(path.join(f.repoRoot, entry.path))), []);
  }
});

test('unsafe paths, duplicates, unsupported categories, and malformed manifests are rejected before writes', async t => {
  const f = fixture(t), original = structuredClone(f.manifest);
  for (const value of ['../outside.mp4', '/tmp/outside.mp4', ARCHIVE_ROOT + '../outside.mp4',
    ARCHIVE_ROOT + 'media/./video.mp4', ARCHIVE_ROOT + 'media//video.mp4', ARCHIVE_ROOT + 'media\\video.mp4',
    ARCHIVE_ROOT + 'media/frames/image.png']) {
    f.options.manifest = structuredClone(original); f.options.manifest.files[0].path = value;
    await assert.rejects(run(['--restore', 'all'], f.options), /Invalid/);
  }
  for (const change of [m => { m.files.push(m.files[0]); }, m => { m.files[0].gitBlob = '--help'; },
    m => { m.files[0].category = 'other'; }, m => { m.files[0].bytes = 0; }, m => { m.files = []; }]) {
    f.options.manifest = structuredClone(original); change(f.options.manifest);
    await assert.rejects(run(['--restore', 'all'], f.options), /Invalid/);
  }
  assert.equal(fs.existsSync(path.join(f.repoRoot, ARCHIVE_ROOT)), false);
});

test('symlinked parents and destinations are rejected and their targets stay unchanged', async t => {
  for (const destinationLink of [false, true]) {
    const f = fixture(t), entry = f.manifest.files[0], filename = path.join(f.repoRoot, entry.path);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-archive-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const externalFile = path.join(outside, 'protected'); fs.writeFileSync(externalFile, 'unchanged');
    if (destinationLink) {
      fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.symlinkSync(externalFile, filename);
    } else {
      fs.mkdirSync(path.dirname(path.dirname(filename)), { recursive: true }); fs.symlinkSync(outside, path.dirname(filename));
    }
    await assert.rejects(run(['--restore', entry.path], f.options), /symbolic link/);
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'unchanged');
    assert.deepEqual(fs.readdirSync(outside), ['protected']);
  }
});

test('CLI options and unknown requested files fail without restoring anything', async t => {
  const f = fixture(t);
  await assert.rejects(run(['--restore'], f.options), /Usage:/);
  await assert.rejects(run(['--restore', ARCHIVE_ROOT + 'media/missing.mp4'], f.options), /not in the archive/);
  await assert.rejects(run(['--verify', '--restore', 'all'], f.options), /Usage:/);
  assert.equal(fs.existsSync(path.join(f.repoRoot, ARCHIVE_ROOT)), false);
});
