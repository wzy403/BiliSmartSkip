const path = require('node:path');

// Point regressions at an algorithm worktree without copying production code
// onto test-branch. Historical replay pins this path inside eval/runner.cjs.
module.exports = process.env.BILISMARTSKIP_SOURCE_DIR
  ? path.resolve(process.env.BILISMARTSKIP_SOURCE_DIR)
  : path.join(__dirname, '..', 'scr');
