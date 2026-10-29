// Local-only smoke test. Manifest: [{ name, file, title }], with independently
// checked titles and PDF paths relative to the manifest. No PDFs are uploaded.
// Usage: node tests/pdfjs-title-sample.test.mjs manifest.json [PaperBench.exe]
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw Error('Supply a local PDF/title manifest.');
const manifest = path.resolve(process.argv[2]);
const cases = JSON.parse(await readFile(manifest, 'utf8')).map(({ name, file, title }) =>
  ({ name, file: path.resolve(path.dirname(manifest), file), title }));
if (!cases.length || cases.some(c => !c.title || !c.file)) throw Error('Each sample needs a PDF and reference title.');
const output = path.join(project, 'tests/runtime', 'pdfjs-title-' + Date.now());
await mkdir(output, { recursive: true });
const require = createRequire(path.join(process.env.PDF_LAB_MODULES, '_sample.cjs'));
const { chromium } = require('playwright');
const assets = path.join(project, 'assets/pdf-reader');
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html></html>'); return; }
    if (/^\/paper\/\d+$/.test(url.pathname)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.end(await readFile(cases[Number(url.pathname.split('/').pop())].file)); return;
    }
    const file = path.resolve(assets, url.pathname.slice(1));
    if (!file.startsWith(assets + path.sep)) throw Error('Invalid asset path');
    res.setHeader('Content-Type', file.endsWith('.mjs') ? 'application/javascript' : 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PDF_LAB_CHROME });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  for (let i = 0; i < cases.length; i++) {
    cases[i].pdfjs = await page.evaluate(async index => {
      const pdfjs = await import('/pdfjs/build/pdf.min.mjs');
      const { pdfTextContentToText } = await import('/text-content.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/build/pdf.worker.mjs';
      const task = pdfjs.getDocument({ url: '/paper/' + index, cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' });
      try {
        const pdf = await task.promise, pages = [];
        for (let n = 1; n <= Math.min(3, pdf.numPages); n++) {
          const p = await pdf.getPage(n);
          pages.push(pdfTextContentToText(await p.getTextContent())); p.cleanup();
        }
        return pages.join('\f');
      } finally { await task.destroy(); }
    }, i);
  }
  const results = path.join(output, 'results.json');
  await writeFile(results, JSON.stringify(cases, null, 2));
  const test = path.join(output, 'sample.exe');
  execFileSync(path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/r:System.Web.Extensions.dll', '/target:exe', '/out:' + test,
      path.join(project, 'tests/CitationPdfJsSampleTests.cs')], { windowsHide: true });
  process.stdout.write(execFileSync(test, [path.resolve(process.argv[3] || path.join(project, '../PaperBench.exe')), results],
    { windowsHide: true, encoding: 'utf8' }));
} finally { await browser?.close(); server.close(); }
