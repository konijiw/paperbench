import * as pdfjs from 'pdfjs-lib';
import { PDFViewer, PDFLinkService, EventBus } from '/vendor/web/pdf_viewer.mjs';
import { clientRectToQuad, quadToViewport, validAnnotation, highlightRects, rectsPath } from './geometry.mjs';
import { installPdfGestures } from './interactions.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.mjs';
const $ = id => document.getElementById(id);
const bus = new EventBus();
const links = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2 });
const viewer = new PDFViewer({
  container: $('container'), viewer: $('viewer'), eventBus: bus, linkService: links,
  textLayerMode: 1, removePageBorders: true,
  maxCanvasPixels: 16 * 1024 * 1024, enableDetailCanvas: true,
  imageResourcesPath: '/vendor/web/images/',
});
links.setViewer(viewer);
let task, documentProxy, annotations = [], storageKey = '', activeId = '', pending = null;
let fitWidth = true, paintFrame = 0, resizeTimer = 0, generation = 0;
const errors = [];
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function failure(error) { errors.push(String(error)); status(String(error.message || error), true); }
window.addEventListener('error', e => errors.push(e.message));
window.addEventListener('unhandledrejection', e => failure(e.reason));

function schedulePaint() {
  cancelAnimationFrame(paintFrame);
  paintFrame = requestAnimationFrame(() => { paint(); diagnostics(); });
}
for (const event of ['pagerendered', 'textlayerrendered', 'scalechanging', 'rotationchanging', 'pagechanging'])
  bus.on(event, schedulePaint);
// Chromium can resolve generic sans-serif differently for an unknown-language
// DOM span under a Chinese document and the canvas used by PDF.js to measure it.
// Use an explicit fallback, and honor per-page PDF language where supplied.
bus.on('pagesinit', () => { $('viewer').lang = 'en'; });
bus.on('textlayerrendered', async ({ pageNumber }) => {
  const page = viewer.getPageView(pageNumber - 1), pdf = documentProxy;
  const text = await page?.pdfPage?.getTextContent();
  if (pdf !== documentProxy || !text) return;
  const layer = page.div.querySelector('.textLayer');
  if (layer) layer.lang = text.lang || 'en';
  schedulePaint();
});

async function openPDF(source) {
  gestures.stop();
  const request = ++generation;
  pending = null; documentProxy = null; annotations = []; storageKey = ''; activeId = '';
  viewer.setDocument(null); links.setDocument(null); renderCards();
  const oldTask = task; task = null;
  if (oldTask) await oldTask.destroy();
  if (request !== generation) return;
  status('正在加载 PDF…'); $('empty').hidden = false;
  $('empty').textContent = '正在加载 PDF…';
  task = pdfjs.getDocument({ ...source, cMapUrl: '/vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl: '/vendor/wasm/' });
  const pdf = await task.promise;
  if (request !== generation) return;
  documentProxy = pdf;
  storageKey = 'paperbench.pdf-lab.v1:' + pdf.fingerprints[0];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    annotations = Array.isArray(saved) ? saved.filter(a => validAnnotation(a, pdf.numPages)) : [];
  } catch { status('实验批注缓存损坏；本次从空批注列表开始。', true); }
  const initialized = new Promise(resolve => {
    const ready = () => { bus.off('pagesinit', ready); resolve(); };
    bus.on('pagesinit', ready);
  });
  viewer.setDocument(pdf); links.setDocument(pdf);
  await initialized;
  if (request !== generation) return;
  fitWidth = true; viewer.currentScaleValue = 'page-width'; $('zoom').value = 'page-width';
  $('empty').hidden = true; renderCards(); schedulePaint();
  status(`已打开 ${pdf.numPages} 页，恢复 ${annotations.length} 条实验批注。`);
}

function save() {
  if (!storageKey) return;
  try { localStorage.setItem(storageKey, JSON.stringify(annotations)); }
  catch { status('浏览器未能保存实验批注，请导出备份。', true); }
}

// Split by page and by actual text span. This avoids duplicated parent rects,
// giant multiline boxes, and accidental rectangles crossing page gutters.
function captureSelection() {
  pending = null;
  const selection = window.getSelection();
  if (!documentProxy || !selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!$('viewer').contains(range.startContainer) || !$('viewer').contains(range.endContainer)) return;
  const quote = selection.toString().trim();
  if (!quote) return;
  const fragments = [];
  for (let index = 0; index < documentProxy.numPages; index++) {
    const page = viewer.getPageView(index);
    const layer = page.div.querySelector('.textLayer');
    const surface = page.div.querySelector('.canvasWrapper');
    if (!layer || !surface || !range.intersectsNode(layer)) continue;
    const bounds = surface.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const quads = [], textRanges = [], seen = new Set();
    const spans = [...layer.querySelectorAll('span')];
    for (const [spanIndex, span] of spans.entries()) {
      if (span.querySelector('span') || !span.textContent || !range.intersectsNode(span)) continue;
      const part = document.createRange();
      part.selectNodeContents(span);
      if (span.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
      if (span.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      if (part.collapsed) continue;
      const before = document.createRange(); before.selectNodeContents(span);
      before.setEnd(part.startContainer, part.startOffset);
      const start = before.toString().length;
      textRanges.push({ span: spanIndex, text: span.textContent, start, end: start + part.toString().length });
      for (const rect of part.getClientRects()) {
        if (rect.width < .1 || rect.height < .1) continue;
        const key = [rect.left, rect.top, rect.width, rect.height].map(n => n.toFixed(3)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        quads.push(clientRectToQuad(rect, bounds, page.viewport));
      }
    }
    if (quads.length) fragments.push({ page: index + 1, quads, textRanges });
  }
  if (fragments.length) pending = { quote, fragments };
}
$('container').addEventListener('mouseup', event => { if (event.button === 0) captureSelection(); });
document.addEventListener('selectionchange', () => {
  if (window.getSelection()?.isCollapsed) pending = null;
});
$('mark').addEventListener('pointerdown', e => e.preventDefault());
$('mark').addEventListener('click', () => {
  captureSelection();
  if (!pending || !documentProxy) return status('请先在 PDF 文字上拖动选择。');
  const annotation = { ...pending, id: crypto.randomUUID(), comment: '', createdAt: new Date().toISOString() };
  annotations.push(annotation); activeId = annotation.id; pending = null;
  window.getSelection()?.removeAllRanges(); save(); renderCards(); schedulePaint();
  status('已保存实验批注。可测试缩放、旋转、拖宽及重新打开。');
});

function rangeInText(span, start, end) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node, offset = 0, started = false;
  while ((node = walker.nextNode())) {
    const length = node.nodeValue.length;
    if (!started && start <= offset + length) { range.setStart(node, Math.max(0, start - offset)); started = true; }
    if (started && end <= offset + length) { range.setEnd(node, Math.max(0, end - offset)); return range; }
    offset += length;
  }
  return null;
}

function displayPolygons(fragment, page, surface) {
  const layer = page.div.querySelector('.textLayer');
  const spans = layer ? [...layer.querySelectorAll('span')] : [];
  const anchors = fragment.textRanges;
  // Text rects are remeasured after layout: font hinting and line metrics are
  // not perfectly proportional at fractional zoom. Keep PDF quads as fallback.
  if (anchors?.length && anchors.every(a => spans[a.span]?.textContent === a.text)) {
    const bounds = surface.getBoundingClientRect(), polygons = [];
    for (const anchor of anchors) {
      const range = rangeInText(spans[anchor.span], anchor.start, anchor.end);
      if (!range) return fragment.quads.map(q => quadToViewport(q, page.viewport));
      for (const rect of range.getClientRects()) {
        if (rect.width < .1 || rect.height < .1) continue;
        const x = (rect.left - bounds.left) * page.viewport.width / bounds.width;
        const y = (rect.top - bounds.top) * page.viewport.height / bounds.height;
        const w = rect.width * page.viewport.width / bounds.width;
        const h = rect.height * page.viewport.height / bounds.height;
        polygons.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
      }
    }
    if (polygons.length) return polygons;
  }
  return fragment.quads.map(q => quadToViewport(q, page.viewport));
}

function paint() {
  if (!documentProxy) return;
  for (let index = 0; index < documentProxy.numPages; index++) {
    const page = viewer.getPageView(index);
    const surface = page.div.querySelector('.canvasWrapper');
    if (!surface) continue;
    surface.querySelector('.pb-overlay')?.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('pb-overlay');
    svg.setAttribute('viewBox', `0 0 ${page.viewport.width} ${page.viewport.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const group = document.createElementNS(svg.namespaceURI, 'g');
    group.classList.add('pb-highlight-group'); svg.append(group);
    const fill = document.createElementNS(svg.namespaceURI, 'path');
    fill.classList.add('pb-highlight-fill'); group.append(fill);
    const paths = [];
    for (const annotation of annotations) for (const fragment of annotation.fragments) {
      if (fragment.page !== index + 1) continue;
      const rects = highlightRects(displayPolygons(fragment, page, surface), page.viewport.rotation);
      const shape = document.createElementNS(svg.namespaceURI, 'path');
      shape.classList.add('pb-highlight-target');
      shape.dataset.annotationId = annotation.id;
      shape.dataset.lineBoxes = String(rects.length);
      const path = rectsPath(rects); paths.push(path); shape.setAttribute('d', path);
      if (annotation.id === activeId) shape.classList.add('active');
      svg.append(shape);
    }
    fill.setAttribute('d', paths.join(''));
    surface.append(svg);
  }
}

async function locate(id) {
  const annotation = annotations.find(a => a.id === id);
  if (!annotation || !documentProxy) return;
  activeId = id;
  const fragment = annotation.fragments[0];
  const quad = fragment.quads[0];
  links.goToDestination([fragment.page - 1, { name: 'XYZ' }, quad[0], quad[1], null]);
  renderCards(); paint();
  requestAnimationFrame(() => {
    const polygon = $('viewer').querySelector(`path[data-annotation-id="${CSS.escape(id)}"]`);
    polygon?.scrollIntoView({ block: 'center', inline: 'nearest' });
    diagnostics();
  });
}

function renderCards() {
  $('count').textContent = String(annotations.length);
  $('annotations').replaceChildren();
  for (const annotation of annotations) {
    const card = document.createElement('article'); card.className = 'annotation'; card.dataset.id = annotation.id;
    card.classList.toggle('active', annotation.id === activeId);
    const label = document.createElement('small');
    label.textContent = '第 ' + annotation.fragments.map(f => f.page).join('、') + ' 页';
    const quote = document.createElement('button'); quote.textContent = annotation.quote;
    quote.addEventListener('click', () => locate(annotation.id));
    const comment = document.createElement('textarea'); comment.placeholder = '实验批注内容'; comment.value = annotation.comment;
    comment.setAttribute('aria-label', '批注内容');
    comment.addEventListener('input', () => { annotation.comment = comment.value; save(); });
    const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = '删除此实验批注';
    remove.addEventListener('click', () => { annotations = annotations.filter(a => a.id !== annotation.id); save(); renderCards(); paint(); });
    card.append(label, quote, comment, remove); $('annotations').append(card);
  }
}

function diagnostics() {
  if (!documentProxy) return;
  const page = viewer.getPageView(viewer.currentPageNumber - 1), canvas = page?.canvas;
  const bounds = canvas?.getBoundingClientRect();
  const detail = page?.detailView, detailBounds = detail?.canvas?.getBoundingClientRect();
  const containerBounds = $('container').getBoundingClientRect();
  const pageBounds = page?.div.querySelector('.canvasWrapper')?.getBoundingClientRect();
  const detailCoversVisible = !!(detailBounds && pageBounds && detail.renderingState === 3 &&
    detailBounds.left <= Math.max(pageBounds.left, containerBounds.left) + 2 &&
    detailBounds.top <= Math.max(pageBounds.top, containerBounds.top) + 2 &&
    detailBounds.right >= Math.min(pageBounds.right, containerBounds.right) - 18 &&
    detailBounds.bottom >= Math.min(pageBounds.bottom, containerBounds.bottom) - 18);
  const result = { pdfjs: pdfjs.version, page: viewer.currentPageNumber, rotation: viewer.pagesRotation,
    scale: Number(viewer.currentScale.toFixed(4)), devicePixelRatio,
    canvasPixels: canvas ? [canvas.width, canvas.height] : null,
    displayPixels: bounds ? [Math.round(bounds.width), Math.round(bounds.height)] : null,
    rasterRatio: bounds?.width ? Number((canvas.width / bounds.width).toFixed(3)) : null,
    detailRasterRatio: detailBounds?.width ? Number((detail.canvas.width / detailBounds.width).toFixed(3)) : null,
    detailCoversVisible,
    annotations: annotations.length, coordinateSpace: 'PDF user space', errors };
  $('diagnostics').textContent = JSON.stringify(result, null, 2);
  return result;
}

function setScale(scale) {
  if (!documentProxy) return;
  pending = null; window.getSelection()?.removeAllRanges();
  fitWidth = scale === 'page-width';
  viewer.currentScaleValue = String(scale);
  if (fitWidth) {
    $('container').scrollLeft = 0;
    requestAnimationFrame(() => { if (fitWidth) $('container').scrollLeft = 0; });
  }
  schedulePaint();
}
const gestures = installPdfGestures({ container: $('container'), viewer,
  hasDocument: () => !!documentProxy,
  onZoom: () => { fitWidth = false; pending = null; window.getSelection()?.removeAllRanges(); } });
bus.on('scalechanging', () => {
  const scale = viewer.currentScale;
  let option = [...$('zoom').options].find(o => Math.abs(Number(o.value) - scale) < .001);
  if (fitWidth) { $('zoom').value = 'page-width'; return; }
  if (!option) {
    option = $('customZoom') || Object.assign(document.createElement('option'), { id: 'customZoom' });
    option.value = String(scale); option.textContent = `${Math.round(scale * 100)}%`;
    $('zoom').append(option);
  }
  $('zoom').value = option.value;
});
$('zoom').addEventListener('change', e => setScale(e.target.value));
$('plus').addEventListener('click', () => setScale(Math.min(4, viewer.currentScale * 1.2)));
$('minus').addEventListener('click', () => setScale(Math.max(.25, viewer.currentScale / 1.2)));
$('rotate').addEventListener('click', () => {
  if (!documentProxy) return;
  pending = null; window.getSelection()?.removeAllRanges();
  viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
  if (fitWidth) viewer.currentScaleValue = 'page-width';
  schedulePaint();
});
$('file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (file) try { await openPDF({ data: new Uint8Array(await file.arrayBuffer()) }); } catch (error) { failure(error); }
  e.target.value = '';
});
$('sample').addEventListener('click', () => openPDF({ url: '/sample.pdf' }).catch(failure));
$('export').addEventListener('click', () => {
  if (!documentProxy) return status('请先打开 PDF。');
  const blob = new Blob([JSON.stringify({ schema: 1, fingerprint: documentProxy.fingerprints[0], annotations }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'paperbench-pdf-lab-annotations.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (documentProxy && fitWidth) viewer.currentScaleValue = 'page-width';
    schedulePaint();
  }, 120);
}).observe($('reader'));
let drag = false;
function width(value) {
  const max = Math.max(280, $('layout').clientWidth - 228);
  const next = Math.min(max, Math.max(280, value));
  $('layout').style.gridTemplateColumns = `${next}px 8px minmax(220px,1fr)`;
  $('divider').setAttribute('aria-valuenow', String(Math.round(next)));
}
$('divider').addEventListener('pointerdown', e => {
  drag = true; pending = null; $('divider').setPointerCapture(e.pointerId); $('divider').classList.add('dragging'); e.preventDefault();
});
$('divider').addEventListener('pointermove', e => { if (drag) width(e.clientX - $('layout').getBoundingClientRect().left); });
$('divider').addEventListener('pointerup', () => { drag = false; $('divider').classList.remove('dragging'); });
$('divider').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault(); width($('reader').clientWidth + (e.key === 'ArrowLeft' ? -30 : 30));
});
// Read-only diagnostics for the standalone verification harness.
window.pdfLab = { get viewer() { return viewer; }, get pdf() { return documentProxy; },
  get annotations() { return structuredClone(annotations); }, diagnostics, errors };
