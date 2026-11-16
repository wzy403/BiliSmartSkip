const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { resolveSource } = require('./export-source.cjs');

// A throwaway repository shaped like this one: a tests-only commit, then a
// branch that carries the extension, then an uncommitted edit on top.
function repository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-export-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8' }).trim();
  const write = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), body);
  };
  git('init', '--quiet');
  write('tests/example.test.cjs', '// tests only\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'tests only');
  const testsOnly = git('rev-parse', 'HEAD');
  const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
  write('scr/content.js', '// committed\n');
  write('scr/icon.png', icon);
  write('manifest.json', '{"version":"1"}\n');
  write('README.md', 'not part of the export\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'extension'); git('branch', 'release');
  write('scr/content.js', '// uncommitted\n');
  return { directory, testsOnly, icon, commit: git('rev-parse', 'HEAD') };
}

test('a branch is exported as committed, with manifest.json beside scr, and removed afterwards', t => {
  const repo = repository(t);
  const source = resolveSource('release', { repository: repo.directory });
  assert.equal(source.commit, repo.commit);
  assert.equal(source.label, `release @ ${repo.commit.slice(0, 7)}`);
  assert.equal(path.basename(source.directory), 'scr');
  assert.equal(fs.readFileSync(path.join(source.directory, 'content.js'), 'utf8'), '// committed\n');
  assert.deepEqual(fs.readFileSync(path.join(source.directory, 'icon.png')), repo.icon, 'binary files survive');
  const root = path.dirname(source.directory);
  assert.deepEqual(fs.readdirSync(root).sort(), ['manifest.json', 'scr']);
  assert.notEqual(root, repo.directory);
  source.cleanup();
  assert.equal(fs.existsSync(root), false);
  // The repository itself is left alone.
  assert.equal(fs.readFileSync(path.join(repo.directory, 'scr', 'content.js'), 'utf8'), '// uncommitted\n');
});

test('a commit hash names the same source as the branch', t => {
  const repo = repository(t);
  const source = resolveSource(repo.commit.slice(0, 12), { repository: repo.directory });
  t.after(() => source.cleanup());
  assert.equal(source.commit, repo.commit);
});

test('a directory is used in place, uncommitted edits included: the scr directory or the checkout around it', t => {
  const repo = repository(t), scr = path.join(repo.directory, 'scr');
  for (const spec of [scr, repo.directory]) {
    const source = resolveSource(spec, { repository: repo.directory });
    assert.equal(source.directory, scr);
    assert.equal(source.commit, null);
    assert.equal(fs.readFileSync(path.join(source.directory, 'content.js'), 'utf8'), '// uncommitted\n');
    source.cleanup();
    assert.equal(fs.existsSync(scr), true, 'cleanup never removes a directory it was given');
  }
});

test('names that cannot be tested are rejected with the reason', t => {
  const repo = repository(t), options = { repository: repo.directory };
  assert.throws(() => resolveSource(undefined, options), /Name what to test/);
  assert.throws(() => resolveSource('no-such-branch', options), /neither a directory nor a branch/);
  assert.throws(() => resolveSource('--upload-pack=x', options), /neither a directory nor a branch/);
  assert.throws(() => resolveSource(repo.testsOnly, options), /has no scr\/content\.js/);
  assert.throws(() => resolveSource(path.join(repo.directory, 'tests'), options), /does not contain the extension source/);
});

test('without a named source the tests refuse to guess', () => {
  const env = { ...process.env };
  delete env.BILISMARTSKIP_SOURCE_DIR;
  const run = spawnSync(process.execPath, ['-e', "require('./source-directory.cjs')"], { cwd: __dirname, env, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /node run-tests\.cjs <branch>/);
});

test('run-tests.cjs explains itself instead of running against nothing', () => {
  const runner = path.join(__dirname, '..', 'run-tests.cjs');
  for (const args of [['--bogus'], ['one', 'two'], ['no-such-branch-or-directory']]) {
    const run = spawnSync(process.execPath, [runner, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /用法：node run-tests\.cjs/);
  }
});
