#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const { bundles } = require('./labels/assistant-content-351-20261004/source-bundles.json');
const hash = body => createHash('sha256').update(body).digest('hex');
for (const bundle of bundles) {
  const compressed = fs.readFileSync(bundle.file);
  if (hash(compressed) !== bundle.compressedSha256) throw Error('Compressed input changed: ' + bundle.file);
  const body = gunzipSync(compressed);
  if (hash(body) !== bundle.sha256) throw Error('Source changed: ' + bundle.file);
  if (fs.existsSync(bundle.restoreTo)) {
    if (hash(fs.readFileSync(bundle.restoreTo)) !== bundle.sha256) throw Error('Existing source differs: ' + bundle.restoreTo);
  } else {
    fs.mkdirSync(path.dirname(bundle.restoreTo), { recursive: true });
    fs.writeFileSync(bundle.restoreTo, body, { flag: 'wx' });
  }
  console.log(bundle.restoreTo);
}
