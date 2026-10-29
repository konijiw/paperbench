// Standalone, loopback-only server. No production routes or write endpoints.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argument = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const vendor = argument('--pdfjs');
if (!vendor) throw new Error('Pass --pdfjs <pdfjs-dist directory> (tested with 5.6.205).');
const sample = argument('--pdf'), fixture = argument('--fixture');
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.pdf': 'application/pdf', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream' };
function within(base, relative) {
  const resolvedBase = path.resolve(base), target = path.resolve(resolvedBase, relative);
  const rel = path.relative(resolvedBase, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid path');
  return target;
}
export const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    let file;
    if (pathname === '/sample.pdf') file = sample;
    else if (pathname === '/fixture.pdf') file = fixture;
    else if (pathname.startsWith('/vendor/')) file = within(vendor, pathname.slice(8));
    else if (['/', '/index.html', '/lab.css', '/lab.mjs', '/geometry.mjs', '/interactions.mjs'].includes(pathname))
      file = within(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file) { res.writeHead(404); res.end('No sample configured; use Open PDF.'); return; }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' blob: data:; object-src 'none'; frame-ancestors 'none'" };
    let start = 0, end = info.size - 1, code = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!range || +range[1] >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
      start = +range[1]; end = range[2] ? Math.min(+range[2], end) : end;
      if (end < start) { res.writeHead(416); res.end(); return; }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') res.end();
    else { const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); stream.pipe(res); }
  } catch { if (!res.headersSent) res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(argument('--port') || 0), '127.0.0.1', () => {
  console.log(`PDF_LAB_URL=http://127.0.0.1:${server.address().port}`);
});
