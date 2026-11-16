#!/usr/bin/env node
'use strict';
// Run the regressions against a branch of the extension:
//
//   node run-tests.cjs [branch | tag | commit | directory] [--all]
//
// test-branch carries no extension code. The scr/ and manifest.json of the
// named branch are exported from Git into a temporary directory, tested and
// removed. Without a name, the branch that was checked out before switching to
// test-branch is tested. Only committed code is exported.
//
// --all also runs the evaluation tooling's own tests, which need the benchmark
// inputs restored into eval/data (done here; a few seconds the first time).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { resolveSource } = require('./tests/export-source.cjs');

const root = __dirname;
const USAGE = '用法：node run-tests.cjs [分支 | 标签 | 提交 | 目录] [--all]';
const testsIn = (directory, pattern) => fs.readdirSync(path.join(root, directory))
  .filter(name => pattern.test(name)).sort().map(name => path.join(directory, name));

// `git checkout test-branch` right after finishing work leaves that work at @{-1}.
function previousBranch() {
  try {
    const name = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{-1}'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return name && name !== '@{-1}' ? name : null;
  } catch {
    return null;
  }
}

function main(args) {
  const all = args.includes('--all');
  const [named, ...extra] = args.filter(arg => arg !== '--all');
  if (extra.length || named?.startsWith('-')) {
    console.error(USAGE);
    return 2;
  }
  const spec = named || previousBranch();
  if (!spec) {
    console.error(`没有指定要测的分支，也找不到切换过来之前所在的分支。\n${USAGE}`);
    return 2;
  }
  let source;
  try {
    source = resolveSource(spec);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    console.log(`测试对象：${source.label}${named ? '' : '（切换过来之前所在的分支；要测别的分支请写在命令后面）'}`);
    const files = testsIn('tests', /\.test\.cjs$/);
    if (all) {
      const restored = spawnSync(process.execPath, [path.join('eval', 'restore-content-inputs.cjs')],
        { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
      if (restored.status !== 0) return restored.status ?? 1;
      files.push(...testsIn('eval', /\.test\.(?:cjs|mjs)$/), ...testsIn(path.join('eval', 'labels'), /\.test\.cjs$/),
        ...testsIn(path.join('eval', 'review'), /\.test\.cjs$/));
    }
    const run = spawnSync(process.execPath, ['--test', ...files],
      { cwd: root, stdio: 'inherit', env: { ...process.env, BILISMARTSKIP_SOURCE_DIR: source.directory } });
    return run.status ?? 1;
  } finally {
    source.cleanup();
  }
}

process.exitCode = main(process.argv.slice(2));
