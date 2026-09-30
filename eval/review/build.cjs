#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { normalizeBundle } = require('./core.js');

function serializeForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
function build(input, out) {
  if (path.resolve(input) === path.resolve(out)) throw new Error('Input and output must differ');
  const bundle = normalizeBundle(JSON.parse(fs.readFileSync(input, 'utf8')));
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  html = html.replace('<link rel="stylesheet" href="style.css">', () => `<style>${fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8')}</style>`);
  html = html.replace('<script id="embedded-bundle" type="application/json">null</script>', () => `<script id="embedded-bundle" type="application/json">${serializeForHtml(bundle)}</script>`);
  for (const name of ['../labels/semantics.js', 'core.js', 'app.js']) {
    const code = fs.readFileSync(path.join(__dirname, name), 'utf8');
    if (/<\/script/i.test(code)) throw new Error(`Unexpected script close in ${name}`);
    html = html.replace(`<script src="${name}"></script>`, () => `<script>${code}</script>`);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  return { output: path.resolve(out), videos: bundle.records.length, bytes: Buffer.byteLength(html), modelSha256: bundle.modelSha256 };
}
function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--input', '--out'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node eval/review/build.cjs --input review-bundle.json --out review.html');
    options[args[i].slice(2)] = args[++i];
  }
  if (!options.input || !options.out) throw new Error('Both --input and --out are required');
  return options;
}
if (require.main === module) {
  try { const options = parse(process.argv.slice(2)); console.log(JSON.stringify(build(options.input, options.out), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build, serializeForHtml, parse };
