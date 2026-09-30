#!/usr/bin/env node
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
function createServer(file) {
  const resolved = path.resolve(file);
  if (!fs.statSync(resolved).isFile()) throw new Error('Expected a generated HTML file');
  return http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end('Read-only server'); return; }
    const route = (request.url || '').split('?')[0];
    if (route === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (!['/', '/review.html'].includes(route)) { response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found'); return; }
    fs.readFile(resolved, (error, html) => {
      if (error) { response.writeHead(500); response.end('Unable to read review HTML'); return; }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length });
      response.end(request.method === 'HEAD' ? undefined : html);
    });
  });
}
function parse(args) {
  const options = { port: 8765 };
  for (let i = 0; i < args.length; i++) {
    if (!['--file', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node eval/review/serve.cjs --file review.html [--port 8765]');
    options[args[i].slice(2)] = args[++i];
  }
  options.port = Number(options.port);
  if (!options.file || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('A file and valid port are required');
  return options;
}
if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2)), server = createServer(options.file);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(options.port, '127.0.0.1', () => console.log(`Local review: http://127.0.0.1:${options.port}/ (read-only; Ctrl+C to stop)`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createServer, parse };
