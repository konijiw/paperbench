import * as pdfjs from './pdfjs/build/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/build/pdf.worker.mjs', import.meta.url).href;

self.onmessage = async ({ data }) => {
  const { id, url } = data;
  let task, port, engine;
  try {
    // Supply an explicit worker port and absolute URL: PDF.js's convenience
    // constructors otherwise consult window/document, absent in this worker.
    port = new Worker(pdfjs.GlobalWorkerOptions.workerSrc, { type: 'module' });
    engine = new pdfjs.PDFWorker({ port });
    task = pdfjs.getDocument({ url: new URL(url, self.location.href), worker: engine,
      useWorkerFetch: true, disableFontFace: true, disableAutoFetch: true, disableStream: true,
      cMapUrl: new URL('./pdfjs/cmaps/', import.meta.url).href, cMapPacked: true,
      standardFontDataUrl: new URL('./pdfjs/standard_fonts/', import.meta.url).href,
      wasmUrl: new URL('./pdfjs/wasm/', import.meta.url).href });
    const pdf = await task.promise;
    const page = await pdf.getPage(1), content = await page.getTextContent();
    const opening = content.items.filter(item => typeof item.str === 'string')
      .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
    const text = opening.slice(0, 800); page.cleanup();
    self.postMessage({ id, ok: true, result: { title: '', text, pages: 1,
      status: text.trim() ? 'ready' : 'empty' } });
  } catch (error) {
    if (error?.name === 'PasswordException') self.postMessage({ id, ok: true,
      result: { title: '', text: '', status: 'password', pages: 0 } });
    else self.postMessage({ id, ok: false, error: String(error?.message || error) });
  } finally {
    if (task) await task.destroy().catch(() => {});
    if (engine) engine.destroy();
    port?.terminate();
  }
};
