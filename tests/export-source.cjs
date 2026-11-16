'use strict';
// test-branch holds tests and evaluation tools only. This resolves what to test:
// an existing directory, or a branch, tag or commit of this repository whose
// scr/ and manifest.json are exported to a temporary directory. A name that is
// both a directory and a branch means the directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const EXPORTED = ['scr', 'manifest.json'];
const ENTRY = 'content.js';

// The scr directory itself, or a checkout that contains it.
function sourceDirectoryIn(directory) {
  return [directory, path.join(directory, 'scr')].find(candidate => fs.existsSync(path.join(candidate, ENTRY))) || null;
}

function resolveSource(spec, { repository = path.resolve(__dirname, '..') } = {}) {
  if (!spec) throw new Error('Name what to test: a branch, tag or commit of this repository, or a directory');
  if (fs.existsSync(spec) && fs.statSync(spec).isDirectory()) {
    const directory = sourceDirectoryIn(path.resolve(spec));
    if (!directory) throw new Error(`${spec} does not contain the extension source (scr/${ENTRY})`);
    return { directory, label: directory, commit: null, cleanup() {} };
  }
  const git = (args, options) => execFileSync('git', args,
    { cwd: repository, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], ...options });
  let commit;
  try {
    commit = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${spec}^{commit}`], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`"${spec}" is neither a directory nor a branch, tag or commit of this repository`);
  }
  const files = git(['ls-tree', '-r', '-z', '--name-only', commit, '--', ...EXPORTED], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  if (!files.includes(`scr/${ENTRY}`)) {
    throw new Error(`${spec} (${commit.slice(0, 7)}) has no scr/${ENTRY}; name a branch that carries the extension code`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bilismartskip-source-'));
  for (const file of files) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, git(['cat-file', 'blob', `${commit}:${file}`]));
  }
  return { directory: path.join(root, 'scr'), label: `${spec} @ ${commit.slice(0, 7)}`, commit,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

module.exports = { resolveSource };
