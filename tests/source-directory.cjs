const path = require('node:path');

// test-branch carries no extension code: the tests run against whatever
// BILISMARTSKIP_SOURCE_DIR names (the directory that holds content.js, with
// manifest.json beside it). run-tests.cjs exports a branch and sets it.
if (!process.env.BILISMARTSKIP_SOURCE_DIR) {
  throw new Error('Nothing to test: run `node run-tests.cjs <branch>` from the repository root, '
    + 'or set BILISMARTSKIP_SOURCE_DIR to the scr directory of the extension.');
}
module.exports = path.resolve(process.env.BILISMARTSKIP_SOURCE_DIR);
