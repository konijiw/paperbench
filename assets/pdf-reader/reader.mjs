import * as pdfjs from './pdfjs/build/pdf.min.mjs';
import { PDFViewer, PDFLinkService, PDFFindController, EventBus } from './pdfjs/web/pdf_viewer.mjs';
import { clientRectToQuad, quadToViewport, validAnnotation, highlightRects, rectsPath } from './geometry.mjs';
import { installPdfGestures } from './interactions.mjs';
import { PDFQuoteMatcher } from './quote-matcher.mjs';
import { installPdfCapture } from './capture.mjs';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const paper = params.get('paper'), session = params.get('session');
const sourceURL = '/content/pdf?paper=' + encodeURIComponent(paper || '');
const bus = new EventBus(), links = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2 });
const find = new PDFFindController({ eventBus: bus, linkService: links });
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf-reader/pdfjs/build/pdf.worker.mjs';
const viewer = new PDFViewer({ container: $('container'), viewer: $('viewer'), eventBus: bus,
  linkService: links, findController: find, textLayerMode: 1, removePageBorders: true,
  maxCanvasPixels: 16 * 1024 * 1024, enableDetailCanvas: true,
  imageResourcesPath: '/pdf-reader/pdfjs/web/images/' });
links.setViewer(viewer);
$('original').href = sourceURL;
let pdf, matcher, selection = null, records = [], mapped = new Map();
let fitWidth = true, paintFrame = 0, revision = 0, locateRevision = 0, noticeTimer;
function emit(kind, data = {}) {
  if (parent !== window) parent.postMessage({ type: 'paperbench-pdf-event', paper, session, kind, ...data }, location.origin);
}
function notice(text) {
  $('status').textContent = text; clearTimeout(noticeTimer);
  if (text) noticeTimer = setTimeout(() => { $('status').textContent = ''; }, 6000);
}
function schedulePaint() {
  cancelAnimationFrame(paintFrame); paintFrame = requestAnimationFrame(paint);
}
for (const name of ['pagerendered', 'scalechanging', 'rotationchanging']) bus.on(name, schedulePaint);
bus.on('pagesinit', () => { $('viewer').lang = 'en'; });
bus.on('textlayerrendered', async ({ pageNumber }) => {
  const page = viewer.getPageView(pageNumber - 1);
  const text = await page?.pdfPage?.getTextContent();
  if (text && page.div.querySelector('.textLayer')) page.div.querySelector('.textLayer').lang = text.lang || 'en';
  schedulePaint();
});
bus.on('pagechanging', ({ pageNumber }) => { $('page').value = pageNumber; schedulePaint(); });
bus.on('updatefindmatchescount', ({ matchesCount }) => {
  $('searchCount').textContent = `${matchesCount.current || 0} / ${matchesCount.total || 0}`;
});

function rangeInText(span, start, end) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT), range = document.createRange();
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
  const spans = [...page.div.querySelectorAll('.textLayer span')], anchors = fragment.textRanges;
  if (anchors?.length && anchors.every(a => spans[a.span]?.textContent === a.text)) {
    const bounds = surface.getBoundingClientRect(), polygons = [];
    for (const anchor of anchors) {
      const range = rangeInText(spans[anchor.span], anchor.start, anchor.end);
      if (!range) break;
      for (const r of range.getClientRects()) {
        if (r.width < .1 || r.height < .1) continue;
        const x = (r.left - bounds.left) * page.viewport.width / bounds.width;
        const y = (r.top - bounds.top) * page.viewport.height / bounds.height;
        const w = r.width * page.viewport.width / bounds.width, h = r.height * page.viewport.height / bounds.height;
        polygons.push([[x,y],[x+w,y],[x+w,y+h],[x,y+h]]);
      }
    }
    if (polygons.length) return polygons;
  }
  return fragment.quads.map(q => quadToViewport(q, page.viewport));
}
function paint() {
  if (!pdf) return;
  for (let i = 0; i < pdf.numPages; i++) {
    const page = viewer.getPageView(i), surface = page.div.querySelector('.canvasWrapper');
    if (!surface) continue;
    surface.querySelector('.pb-overlay')?.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('pb-overlay'); svg.setAttribute('viewBox', `0 0 ${page.viewport.width} ${page.viewport.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const group = document.createElementNS(svg.namespaceURI, 'g'); group.classList.add('pb-highlight-group'); svg.append(group);
    const fill = document.createElementNS(svg.namespaceURI, 'path'); fill.classList.add('pb-highlight-fill'); group.append(fill);
    const paths = [];
    for (const [id, anchor] of mapped) for (const fragment of anchor.fragments) {
      if (fragment.page !== i + 1) continue;
      const path = rectsPath(highlightRects(displayPolygons(fragment, page, surface), page.viewport.rotation));
      paths.push(path);
      const target = document.createElementNS(svg.namespaceURI, 'path'); target.classList.add('pb-highlight-target');
      target.dataset.annotationId = id; target.setAttribute('d', path); svg.append(target);
    }
    fill.setAttribute('d', paths.join('')); surface.append(svg);
  }
}
function validAnchor(annotation) {
  const anchor = annotation.pdfAnchor;
  return anchor?.version === 1 && anchor.fingerprint === pdf.fingerprints[0] &&
    validAnnotation({ ...annotation, id: annotation.id || '__draft__', comment: annotation.comment || '', fragments: anchor.fragments }, pdf.numPages);
}
async function resolve(annotation) {
  if (validAnchor(annotation)) return { status: 'matched', anchor: annotation.pdfAnchor };
  return matcher.resolve(annotation);
}
async function setAnnotations(annotations) {
  const token = ++revision;
  records = Array.isArray(annotations) ? annotations : [];
  mapped = new Map();
  for (const a of records) if (validAnchor(a)) mapped.set(a.id, a.pdfAnchor);
  paint();
  for (const annotation of records) {
    if (mapped.has(annotation.id)) continue;
    const result = await resolve(annotation);
    if (token !== revision) return;
    if (result.status === 'matched') mapped.set(annotation.id, result.anchor);
  }
  if (token === revision) schedulePaint();
}
async function locate(annotation, requestId) {
  const token = ++locateRevision;
  const result = mapped.has(annotation.id) ? { status: 'matched', anchor: mapped.get(annotation.id) } : await resolve(annotation);
  if (token !== locateRevision) return;
  if (result.status !== 'matched') {
    const message = result.status === 'ambiguous' ? 'PDF 中存在多个相同引文，暂时无法可靠定位。' : '未能在 PDF 中匹配这段原文，解析文字可能与原文不同。';
    notice(message); emit('located', { requestId, status: result.status, message }); return;
  }
  mapped.set(annotation.id || '__draft__', result.anchor);
  const fragment = result.anchor.fragments[0], quad = fragment.quads[0];
  const pageNumber = fragment.page;
  await links.goToDestination([pageNumber - 1, { name: 'XYZ' }, quad[0], quad[1], null]);
  const page = viewer.getPageView(pageNumber - 1);
  if (!page.div.querySelector('.textLayer span')) await new Promise(resolve => {
    const done = event => { if (event.pageNumber === pageNumber) { clearTimeout(timer); bus.off('textlayerrendered', done); resolve(); } };
    const timer = setTimeout(() => { bus.off('textlayerrendered', done); resolve(); }, 6000);
    bus.on('textlayerrendered', done);
  });
  if (token !== locateRevision) return;
  paint();
  page.div.querySelector(`.pb-highlight-target[data-annotation-id="${CSS.escape(annotation.id || '__draft__')}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
  emit('located', { requestId, status: 'matched', page: pageNumber });
}

function clearSelection() {
  selection = null; $('selectionTools').hidden = true; window.getSelection()?.removeAllRanges(); emit('selection', { selection: null });
}
function captureSelection() {
  const selected = window.getSelection();
  if (!pdf || !selected?.rangeCount || selected.isCollapsed) return clearSelection();
  const range = selected.getRangeAt(0);
  if (!$('viewer').contains(range.startContainer) || !$('viewer').contains(range.endContainer)) return clearSelection();
  const quote = selected.toString().trim();
  if (!quote || quote.length > 30000) { clearSelection(); if (quote) notice('选区过长，请分段批注或翻译。'); return; }
  const fragments = [];
  let prefix = '', suffix = '';
  for (let i = 0; i < pdf.numPages; i++) {
    const page = viewer.getPageView(i), layer = page.div.querySelector('.textLayer'), surface = page.div.querySelector('.canvasWrapper');
    if (!layer || !surface || !range.intersectsNode(layer)) continue;
    const bounds = surface.getBoundingClientRect(), quads = [], textRanges = [], spans = [...layer.querySelectorAll('span')], seen = new Set();
    if (!bounds.width || !bounds.height) continue;
    for (const [spanIndex, span] of spans.entries()) {
      if (span.querySelector('span') || !span.textContent || !range.intersectsNode(span)) continue;
      const part = document.createRange(); part.selectNodeContents(span);
      if (span.contains(range.startContainer)) part.setStart(range.startContainer, range.startOffset);
      if (span.contains(range.endContainer)) part.setEnd(range.endContainer, range.endOffset);
      if (part.collapsed) continue;
      const before = document.createRange(); before.selectNodeContents(span); before.setEnd(part.startContainer, part.startOffset);
      const start = before.toString().length;
      textRanges.push({ span: spanIndex, text: span.textContent, start, end: start + part.toString().length });
      for (const rect of part.getClientRects()) {
        if (rect.width < .1 || rect.height < .1) continue;
        const key = [rect.left,rect.top,rect.width,rect.height].join(',');
        if (!seen.has(key)) { seen.add(key); quads.push(clientRectToQuad(rect, bounds, page.viewport)); }
      }
    }
    if (quads.length) fragments.push({ page: i + 1, quads, textRanges });
    if (layer.contains(range.startContainer)) {
      const before = document.createRange(); before.selectNodeContents(layer); before.setEnd(range.startContainer, range.startOffset); prefix = before.toString().slice(-80);
    }
    if (layer.contains(range.endContainer)) {
      const after = document.createRange(); after.selectNodeContents(layer); after.setStart(range.endContainer, range.endOffset); suffix = after.toString().slice(0,80);
    }
  }
  if (!fragments.length) return clearSelection();
  selection = { source: 'pdf', quote, prefix, suffix,
    pdfAnchor: { version: 1, fingerprint: pdf.fingerprints[0], fragments } };
  emit('selection', { selection });
  const rect = range.getBoundingClientRect(), tools = $('selectionTools'); tools.hidden = false;
  tools.style.left = `${Math.max(5, Math.min(innerWidth - tools.offsetWidth - 5, rect.left))}px`;
  tools.style.top = `${Math.max(5, Math.min(innerHeight - tools.offsetHeight - 5, rect.bottom + 6))}px`;
}
$('container').addEventListener('mouseup', e => { if (e.button === 0) captureSelection(); });
$('container').addEventListener('pointerdown', () => emit('activity'));
// Hit-test the painted path without putting an interactive layer over PDF text.
const hitContext = document.createElement('canvas').getContext('2d');
let annotationPointer;
$('container').addEventListener('pointerdown', e => {
  annotationPointer = e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false } : null;
});
$('container').addEventListener('pointermove', e => {
  if (annotationPointer?.id === e.pointerId && Math.hypot(e.clientX - annotationPointer.x, e.clientY - annotationPointer.y) > 4) annotationPointer.moved = true;
});
$('container').addEventListener('pointercancel', () => { annotationPointer = null; });
$('container').addEventListener('click', e => {
  const pointer = annotationPointer; annotationPointer = null;
  if (!pointer || pointer.moved || e.button !== 0 || e.detail !== 1 || !window.getSelection()?.isCollapsed ||
      e.target.closest('a,.annotationLayer,button,input,select,textarea')) return;
  const svg = e.target.closest('.page')?.querySelector('.pb-overlay');
  if (!svg || !hitContext) return;
  const bounds = svg.getBoundingClientRect(), box = svg.viewBox.baseVal;
  if (!bounds.width || !bounds.height) return;
  const x = (e.clientX - bounds.left) * box.width / bounds.width;
  const y = (e.clientY - bounds.top) * box.height / bounds.height;
  for (const target of [...svg.querySelectorAll('.pb-highlight-target')].reverse()) {
    const id = target.dataset.annotationId;
    if (records.some(a => a.id === id) && hitContext.isPointInPath(new Path2D(target.getAttribute('d')), x, y)) {
      emit('annotationClick', { id }); return;
    }
  }
});
$('container').addEventListener('scroll', () => { $('selectionTools').hidden = true; }, { passive: true });
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed && selection) clearSelection(); });
$('selectionTools').addEventListener('pointerdown', e => e.preventDefault());
$('selectionTools').addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action && selection) emit('action', { action, selection });
  $('selectionTools').hidden = true;
});
const gestures = installPdfGestures({ container: $('container'), viewer, hasDocument: () => !!pdf,
  onZoom: () => { fitWidth = false; clearSelection(); } });
function scale(value) {
  if (!pdf) return;
  gestures.stop(); clearSelection(); fitWidth = value === 'page-width'; viewer.currentScaleValue = String(value);
  if (fitWidth) { $('container').scrollLeft = 0; requestAnimationFrame(() => { if (fitWidth) $('container').scrollLeft = 0; }); }
}
bus.on('scalechanging', () => {
  if (fitWidth) { $('zoom').value = 'page-width'; return; }
  let option = [...$('zoom').options].find(o => Math.abs(Number(o.value) - viewer.currentScale) < .001);
  if (!option) { option = $('customZoom') || Object.assign(document.createElement('option'), { id: 'customZoom' });
    option.value = String(viewer.currentScale); option.textContent = `${Math.round(viewer.currentScale * 100)}%`; $('zoom').append(option); }
  $('zoom').value = option.value;
});
$('zoom').onchange = e => scale(e.target.value);
$('plus').onclick = () => scale(Math.min(4, viewer.currentScale * 1.2));
$('minus').onclick = () => scale(Math.max(.25, viewer.currentScale / 1.2));
$('rotate').onclick = () => { if (pdf) { clearSelection(); viewer.pagesRotation = (viewer.pagesRotation + 90) % 360; if (fitWidth) viewer.currentScaleValue = 'page-width'; } };
$('previous').onclick = () => { if (pdf) viewer.currentPageNumber = Math.max(1, viewer.currentPageNumber - 1); };
$('next').onclick = () => { if (pdf) viewer.currentPageNumber = Math.min(pdf.numPages, viewer.currentPageNumber + 1); };
$('page').onchange = e => { if (pdf) viewer.currentPageNumber = Math.max(1, Math.min(pdf.numPages, Number(e.target.value) || 1)); };
function search(again = false) { bus.dispatch('find', { source: window, type: again ? 'again' : '', query: $('search').value, phraseSearch: true, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: false, matchDiacritics: false }); }
$('searchToggle').onclick = () => { $('searchBar').hidden = false; $('search').focus(); };
$('searchClose').onclick = () => { $('searchBar').hidden = true; bus.dispatch('findbarclose', { source: window }); };
$('searchBar').onsubmit = e => { e.preventDefault(); search(true); };
$('search').oninput = () => search();
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('searchToggle').click(); } });
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
  if (pdf && fitWidth && $('container').clientWidth > 0) viewer.currentScaleValue = 'page-width'; schedulePaint();
}, 120); }).observe($('reader'));

const capture = installPdfCapture({ container: $('container'), viewer, getPdf: () => pdf, notice,
  onImage: (url, page) => emit('capture', { url, page }) });
for (const name of ['pagechanging', 'scalechanging', 'rotationchanging']) bus.on(name, () => capture.invalidate());

window.addEventListener('message', e => {
  const command = e.data;
  if (e.source !== parent || e.origin !== location.origin || command?.type !== 'paperbench-pdf-command' ||
      command.session !== session || command.paper !== paper || !pdf) return;
  if (command.kind === 'annotations') setAnnotations(command.annotations).catch(error => notice('PDF 批注匹配失败：' + error.message));
  if (command.kind === 'locate') locate(command.annotation, command.requestId).catch(error => emit('located', { requestId: command.requestId, status: 'error', message: error.message }));
  if (command.kind === 'capture') { gestures.stop(); clearSelection(); capture.begin(); }
  if (command.kind === 'clearSelection') clearSelection();
  if (command.kind === 'visibility' && !command.visible) { gestures.stop(); clearSelection(); capture.cancel(); }
});

async function open() {
  if (!paper || !session || parent === window) throw new Error('请从 PaperBench 打开论文。');
  pdf = await pdfjs.getDocument({ url: sourceURL, cMapUrl: '/pdf-reader/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdf-reader/pdfjs/standard_fonts/', wasmUrl: '/pdf-reader/pdfjs/wasm/' }).promise;
  matcher = new PDFQuoteMatcher(pdf);
  const initialized = new Promise(resolve => { const ready = () => { bus.off('pagesinit', ready); resolve(); }; bus.on('pagesinit', ready); });
  viewer.setDocument(pdf); links.setDocument(pdf); await initialized;
  viewer.currentScaleValue = 'page-width'; $('page').max = pdf.numPages; $('pages').textContent = '/ ' + pdf.numPages;
  $('loading').hidden = true; emit('ready');
}
open().catch(error => { $('loading').textContent = 'PDF 打开失败，可点击“原始文件”继续阅读。'; emit('error', { message: error.message }); });
