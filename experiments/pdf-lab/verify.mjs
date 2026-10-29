// Real Chromium verification. Only writes to tests/runtime/pdf-lab/.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { highlightRects } from './geometry.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const modules = process.env.PDF_LAB_MODULES;
if (!modules) throw new Error('Set PDF_LAB_MODULES to a node_modules directory containing playwright, pdf-lib, and pdfjs-dist.');
const require = createRequire(path.join(modules, '_pdf_lab.cjs'));
const { chromium } = require('playwright');
const { PNG } = require('pngjs');
const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
const output = path.resolve(here, '../../tests/runtime/pdf-lab');
await mkdir(output, { recursive: true });
const box = (x, y, w, h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
assert.equal(highlightRects([box(0,10,100,16),box(102,8,9,20),box(111,4,5,9),box(117,10,90,16)]).length, 1,
  'Font changes and superscripts should share a line');
assert.equal(highlightRects([box(0,10,100,16),box(300,10,100,16)]).length, 2, 'Do not bridge columns');
assert.equal(highlightRects([box(0,10,100,16),box(0,31,100,16)]).length, 2, 'Do not bridge adjacent lines');
assert.equal(highlightRects([box(10,0,16,100),box(8,102,20,9),box(10,112,16,90)],90).length, 1, 'Rotated line merging');

// Known PDF coordinates form an independent oracle for the initial anchor.
const fixture = await PDFDocument.create();
const font = await fixture.embedFont(StandardFonts.Helvetica);
const italic = await fixture.embedFont(StandardFonts.TimesRomanItalic);
for (let index = 0; index < 4; index++) {
  const page = fixture.addPage([612, 792]);
  page.drawText(`Anchor reference page ${index + 1}`, { x: 60, y: 700, size: 18, font });
  page.drawText('Left column first line.', { x: 60, y: 640, size: 12, font });
  page.drawText('Left column second line.', { x: 60, y: 620, size: 12, font });
  page.drawText('Right column first line.', { x: 330, y: 640, size: 12, font });
  page.drawText('Right column second line.', { x: 330, y: 620, size: 12, font });
  page.drawText('Mixed font ', { x: 60, y: 560, size: 12, font });
  page.drawText('A', { x: 121, y: 560, size: 14, font: italic });
  page.drawText('0', { x: 130, y: 568, size: 8, font });
  page.drawText(' plus citation (Author, 2025).', { x: 137, y: 560, size: 12, font });
  page.drawLine({ start: { x: 60, y: 695 }, end: { x: 310, y: 695 }, color: rgb(.6, .6, .6), thickness: .5 });
  if (index === 1) page.setCropBox(24, 30, 550, 730);
  if (index === 2) page.setRotation(degrees(90));
  if (index === 3) { page.setCropBox(24, 30, 550, 730); page.setRotation(degrees(270)); }
}
const fixturePath = path.join(output, 'coordinate-fixture.pdf');
await writeFile(fixturePath, await fixture.save());
const command = [path.join(here, 'serve.mjs'), '--pdfjs', path.join(modules, 'pdfjs-dist'), '--fixture', fixturePath];
if (process.env.PDF_LAB_SAMPLE) command.push('--pdf', process.env.PDF_LAB_SAMPLE);
const server = spawn(process.execPath, command, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((resolve, reject) => {
  let log = '';
  server.stdout.on('data', bytes => { log += bytes; const match = /PDF_LAB_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log); if (match) resolve(match[1]); });
  server.on('error', reject); server.on('exit', code => reject(new Error('Server exited: ' + code)));
});
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PDF_LAB_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const results = [], pageErrors = [];
async function ready(page, pageNumber = 1) {
  await page.waitForFunction(number => {
    const lab = window.pdfLab, view = lab?.viewer.getPageView(number - 1);
    return lab?.pdf && view?.canvas?.width > 0 && view.renderingState === 3 &&
      (!view.detailView || view.detailView.renderingState === 3) &&
      !!view.div.querySelector('.textLayer span') && !view.div.querySelector('.textLayer')?.hasAttribute('hidden');
  }, pageNumber, { timeout: 60000 });
  await page.waitForTimeout(300);
}
async function openFixture(page) {
  await page.goto(url);
  await page.locator('#file').setInputFiles(fixturePath);
  await ready(page);
}
async function selectAnchor(page, pageNumber, mark = true) {
  await page.evaluate(number => {
    const span = [...document.querySelectorAll(`.page[data-page-number="${number}"] .textLayer span`)]
      .find(el => el.textContent === `Anchor reference page ${number}`);
    if (!span) throw new Error('Missing text span');
    const range = document.createRange(); range.selectNodeContents(span);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.getElementById('container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, pageNumber);
  if (mark) { await page.locator('#mark').click(); await page.waitForTimeout(100); }
}
// Compare restored overlays to a fresh DOM text selection in the current layout,
// without using the application's conversion helper to calculate expectations.
async function alignment(page, pageNumber) {
  return page.evaluate(number => {
    const host = document.querySelector(`.page[data-page-number="${number}"]`);
    const span = [...host.querySelectorAll('.textLayer span')].find(el => el.textContent === `Anchor reference page ${number}`);
    const range = document.createRange(); range.selectNodeContents(span);
    const native = [...range.getClientRects()].filter(r => r.width && r.height)[0];
    const actual = host.querySelector('path[data-annotation-id]')?.getBoundingClientRect();
    if (!actual || !native) throw new Error('Missing overlay or native rect');
    const error = Math.max(...['left', 'top', 'right', 'bottom'].map(key => Math.abs(native[key] - actual[key])));
    if (error > .5) console.log('ALIGNMENT', JSON.stringify({ number, rotation: window.pdfLab.viewer.pagesRotation,
      scale: window.pdfLab.viewer.currentScale, error, native: native.toJSON(), actual: actual.toJSON(),
      page: host.getBoundingClientRect().toJSON(), surface: host.querySelector('.canvasWrapper').getBoundingClientRect().toJSON() }));
    return error;
  }, pageNumber);
}

try {
  for (const dpr of [1, 1.25, 2]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: dpr });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.text().startsWith('ALIGNMENT')) console.log(message.text()); });
    await openFixture(page);
    await page.locator('#zoom').selectOption('1'); await ready(page);
    await selectAnchor(page, 1);
    const annotation = await page.evaluate(() => window.pdfLab.annotations[0]);
    assert.ok(Math.abs(annotation.fragments[0].quads[0][0] - 60) < 1, 'PDF x origin must agree with known fixture');
    assert.ok(annotation.fragments[0].quads[0][1] > 700 && annotation.fragments[0].quads[0][1] < 722, 'PDF y must agree with known text baseline');
    let maximumError = await alignment(page, 1);
    if (dpr === 1) {
      // A duplicate annotation should not make its overlap darker.
      const surface = page.locator('.page[data-page-number="1"] .canvasWrapper');
      const single = await surface.screenshot();
      await selectAnchor(page, 1);
      const duplicate = await surface.screenshot();
      const yellow = bytes => {
        const png=PNG.sync.read(bytes),counts=new Map();
        for(let i=0;i<png.data.length;i+=4){const [r,g,b]=png.data.subarray(i,i+3);
          if(r>240&&g>180&&g<254&&b<230){const key=[r,g,b].join(',');counts.set(key,(counts.get(key)||0)+1);}}
        return [...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];
      };
      assert.ok(yellow(single));
      assert.equal(yellow(single),yellow(duplicate), 'Overlapping annotations must composite without extra opacity');
      await page.locator('.annotation .delete').last().click();
    }
    const rasters = [];
    for (const scale of ['1', '1.5', '2', '3']) {
      await page.locator('#zoom').selectOption(scale); await ready(page);
      maximumError = Math.max(maximumError, await alignment(page, 1));
      const info = await page.evaluate(() => window.pdfLab.diagnostics());
      const effectiveRatio = info.detailCoversVisible ? info.detailRasterRatio : info.rasterRatio;
      assert.ok(effectiveRatio >= dpr * .97, `Raster undersampled: ${JSON.stringify(info)}`);
      rasters.push({ scale, ratio: effectiveRatio, baseRatio: info.rasterRatio,
        detailCoversVisible: info.detailCoversVisible, canvas: info.canvasPixels });
    }
    await page.locator('#zoom').selectOption('page-width'); await ready(page);
    const handle = await page.locator('#divider').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
    await page.mouse.down(); await page.mouse.move(700, handle.y + 80, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(500); await ready(page);
    maximumError = Math.max(maximumError, await alignment(page, 1));
    for (let rotation = 0; rotation < 4; rotation++) {
      await page.locator('#rotate').click(); await ready(page);
      maximumError = Math.max(maximumError, await alignment(page, 1));
    }
    await page.locator('.annotation textarea').fill('Persisted experimental comment');
    await page.reload(); await page.locator('#file').setInputFiles(fixturePath); await ready(page);
    assert.equal(await page.locator('.annotation textarea').inputValue(), 'Persisted experimental comment');
    maximumError = Math.max(maximumError, await alignment(page, 1));
    for (const number of [2, 3, 4]) {
      await page.evaluate(n => { window.pdfLab.viewer.currentPageNumber = n; }, number);
      await ready(page, number); await selectAnchor(page, number);
      const error = await alignment(page, number); maximumError = Math.max(maximumError, error);
      const anchor = await page.evaluate(() => window.pdfLab.annotations.at(-1).fragments[0].quads[0]);
      assert.ok(Math.min(...[anchor[0], anchor[2], anchor[4], anchor[6]]) > 59 &&
        Math.min(...[anchor[0], anchor[2], anchor[4], anchor[6]]) < 61, 'Crop/rotation must preserve original x=60');
      await page.locator('#rotate').click(); await ready(page, number);
      maximumError = Math.max(maximumError, await alignment(page, number));
    }
    await page.locator('.annotation').first().locator('button').first().click(); await ready(page);
    assert.equal(await page.evaluate(() => window.pdfLab.viewer.currentPageNumber), 1);
    await page.screenshot({ path: path.join(output, `fixture-dpr-${dpr}.png`) });
    assert.ok(maximumError < 1, `Overlay deviation ${maximumError} CSS px`);
    // Partial character selection: check against PDF font metrics, rather than
    // only comparing two browser rectangles generated by the same text layer.
    await page.evaluate(() => { window.pdfLab.viewer.pagesRotation = 0; window.pdfLab.viewer.currentPageNumber = 1; });
    await page.locator('#zoom').selectOption('1'); await ready(page);
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find(s => s.textContent === 'Anchor reference page 1');
      const range = document.createRange(); range.setStart(span.firstChild, 7); range.setEnd(span.firstChild, 16);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.getElementById('container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#mark').click();
    const partial = await page.evaluate(() => window.pdfLab.annotations.at(-1));
    assert.equal(partial.quote, 'reference');
    const expectedX = 60 + font.widthOfTextAtSize('Anchor ', 18);
    if (Math.abs(partial.fragments[0].quads[0][0] - expectedX) >= .5) console.log('TEXT_METRICS', await page.evaluate(async () => {
      const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find(s => s.textContent === 'Anchor reference page 1');
      const style = getComputedStyle(span), text = await window.pdfLab.viewer.getPageView(0).pdfPage.getTextContent();
      const measure = () => {const r=document.createRange();r.setStart(span.firstChild,0);r.setEnd(span.firstChild,7);return r.getBoundingClientRect().width;};
      const measurements = { original: measure(), lang: span.closest('[lang]')?.outerHTML.slice(0, 120) };
      span.lang = 'en'; measurements.english = measure(); span.lang = ''; measurements.unknown = measure();
      return { font: style.font, transform: style.transform, rect: span.getBoundingClientRect().toJSON(), measurements,
        styles: text.styles, items: text.items.slice(0, 2), fonts: [...document.fonts].map(f => ({ family:f.family,status:f.status })) };
    }));
    assert.ok(Math.abs(partial.fragments[0].quads[0][0] - expectedX) < .5,
      `Partial text must agree with independent font metrics: actual=${partial.fragments[0].quads[0][0]}, expected=${expectedX}`);
    // Two adjacent lines must remain two boxes; no paragraph-sized rectangle.
    await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
      const first = spans.find(s => s.textContent === 'Left column first line.');
      const second = spans.find(s => s.textContent === 'Left column second line.');
      const range = document.createRange(); range.setStart(first.firstChild, 0); range.setEnd(second.firstChild, second.textContent.length);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.getElementById('container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#mark').click();
    const multiline = await page.evaluate(() => window.pdfLab.annotations.at(-1));
    assert.equal(multiline.fragments.length, 1); assert.equal(multiline.fragments[0].quads.length, 2);
    assert.ok(multiline.fragments[0].quads.every(q => Math.abs(q[2] - q[0]) < 160));
    // Cross-page selection is split into separate page fragments.
    await page.evaluate(() => { window.pdfLab.viewer.currentPageNumber = 2; }); await ready(page, 2);
    await page.evaluate(() => {
      const find = n => [...document.querySelectorAll(`.page[data-page-number="${n}"] .textLayer span`)].find(s => s.textContent === `Anchor reference page ${n}`);
      const first = find(1), second = find(2), range = document.createRange();
      range.setStart(first.firstChild, 0); range.setEnd(second.firstChild, second.textContent.length);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.getElementById('container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator('#mark').click();
    const crosspage = await page.evaluate(() => window.pdfLab.annotations.at(-1));
    assert.deepEqual(crosspage.fragments.map(f => f.page), [1, 2]);
    // Blank-space clicks must never reuse the preceding selection.
    const beforeBlank = await page.locator('.annotation').count();
    await page.evaluate(() => { window.getSelection().removeAllRanges(); document.getElementById('container').dispatchEvent(new MouseEvent('mouseup')); });
    await page.locator('#mark').click();
    assert.equal(await page.locator('.annotation').count(), beforeBlank);
    await page.locator('#zoom').selectOption('3'); await ready(page, 2);
    await page.screenshot({ path: path.join(output, `detail-300-dpr-${dpr}.png`) });
    // Mixed-font/math fragments now form one borderless line shape.
    await page.evaluate(() => {
      window.pdfLab.viewer.currentPageNumber = 1;
      const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
      const start = spans.find(s => s.textContent.trim() === 'Mixed font');
      const end = spans.find(s => s.textContent.includes('plus citation (Author, 2025).'));
      const range = document.createRange(); range.setStart(start.firstChild,0); range.setEnd(end.firstChild,end.textContent.length);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.getElementById('container').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    });
    await page.locator('#mark').click(); await ready(page);
    const mixed = await page.evaluate(() => {
      const id = window.pdfLab.annotations.at(-1).id;
      const shape = document.querySelector(`path[data-annotation-id="${id}"]`);
      return { boxes: Number(shape.dataset.lineBoxes), stroke: getComputedStyle(shape).stroke };
    });
    assert.equal(mixed.boxes,1); assert.equal(mixed.stroke,'none');
    await page.locator('#zoom').selectOption('1.5'); await ready(page);
    // Ctrl+wheel zooms the PDF around the pointer, leaving the HTML UI alone.
    const pointer = await page.locator('#container').boundingBox();
    const px = pointer.x + 350, py = pointer.y + 240;
    await page.mouse.move(px,py);
    const beforeZoom = await page.evaluate(({x,y}) => {
      const view=window.pdfLab.viewer.getPageView(0), b=view.div.querySelector('.canvasWrapper').getBoundingClientRect();
      return {scale:window.pdfLab.viewer.currentScale, point:view.viewport.convertToPdfPoint((x-b.left)*view.viewport.width/b.width,(y-b.top)*view.viewport.height/b.height),header:document.querySelector('header').getBoundingClientRect().height};
    }, {x:px,y:py});
    await page.keyboard.down('Control'); await page.mouse.wheel(0,-80); await page.keyboard.up('Control');
    await ready(page);
    const afterZoom = await page.evaluate(({x,y,point}) => {
      const view=window.pdfLab.viewer.getPageView(0),b=view.div.querySelector('.canvasWrapper').getBoundingClientRect(),p=view.viewport.convertToViewportPoint(...point);
      return {scale:window.pdfLab.viewer.currentScale,error:Math.hypot(b.left+p[0]*b.width/view.viewport.width-x,b.top+p[1]*b.height/view.viewport.height-y),header:document.querySelector('header').getBoundingClientRect().height};
    }, {x:px,y:py,point:beforeZoom.point});
    assert.ok(afterZoom.scale > beforeZoom.scale); assert.equal(afterZoom.header,beforeZoom.header);
    assert.ok(afterZoom.error < 3, `Pointer zoom drift ${afterZoom.error}`);
    // Middle drag must pan both axes without changing PDF scale.
    await page.locator('#zoom').selectOption('3'); await ready(page);
    await page.evaluate(() => { const c=document.getElementById('container');c.scrollLeft=200;c.scrollTop=200; });
    const beforePan = await page.locator('#container').evaluate(c=>({x:c.scrollLeft,y:c.scrollTop}));
    await page.mouse.move(px,py);await page.mouse.down({button:'middle'});await page.mouse.move(px-80,py-60,{steps:5});await page.mouse.up({button:'middle'});
    const afterPan = await page.locator('#container').evaluate(c=>({x:c.scrollLeft,y:c.scrollTop}));
    assert.ok(Math.abs(afterPan.x-beforePan.x-80)<2 && Math.abs(afterPan.y-beforePan.y-60)<2, 'Middle drag both axes');
    await page.mouse.move(px,py);await page.mouse.click(px,py,{button:'middle'});await page.mouse.move(px+55,py+55);
    await page.waitForTimeout(300);
    const autoPan=await page.locator('#container').evaluate(c=>({x:c.scrollLeft,y:c.scrollTop}));
    assert.ok(autoPan.x>afterPan.x && autoPan.y>afterPan.y,'Middle click autoscroll both axes');
    await page.keyboard.press('Escape');await page.waitForTimeout(60);
    const stopped=await page.locator('#container').evaluate(c=>({x:c.scrollLeft,y:c.scrollTop}));
    await page.waitForTimeout(100);
    assert.deepEqual(await page.locator('#container').evaluate(c=>({x:c.scrollLeft,y:c.scrollTop})),stopped,'Escape stops autoscroll');
    await page.locator('#zoom').selectOption('page-width');await ready(page);
    assert.equal(await page.locator('#container').evaluate(c=>c.scrollLeft),0,'Fit width clears horizontal pan');
    await page.screenshot({path:path.join(output,`merged-highlight-dpr-${dpr}.png`)});
    results.push({ dpr, maximumOverlayErrorCssPx: maximumError, rasters,
      checks: ['native PDF coordinates', 'zoom 100/150/200/300%', 'pane resize', 'four rotations',
        'reload persistence', 'crop box', 'intrinsic page rotations', 'annotation navigation',
        'partial characters vs PDF font metrics', 'multiline boxes', 'cross-page fragments', 'stale selection guard',
        'mixed fonts and superscript merge', ...(dpr===1?['no opacity stacking']:[]),
        'Ctrl wheel pointer zoom', 'middle drag both axes', 'middle click autoscroll and Escape', 'fit width resets horizontal pan'] });
    assert.deepEqual(await page.evaluate(() => window.pdfLab.errors), []);
    await context.close();
  }
  if (process.env.PDF_LAB_SAMPLE) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url); await page.locator('#sample').click(); await ready(page);
    await page.evaluate(() => {
      const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
        .filter(el => el.textContent.trim().length > 20);
      const span = spans[0];
      if (!span) throw new Error('No real-paper text span');
      const range = document.createRange(); range.selectNodeContents(span);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      document.getElementById('container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      window.__realSpanText = span.textContent;
    });
    await page.locator('#mark').click(); await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(output, 'real-paper-dpr-2.png') });
    results.push({ realPaper: path.basename(process.env.PDF_LAB_SAMPLE), diagnostics: await page.evaluate(() => window.pdfLab.diagnostics()) });
    assert.deepEqual(await page.evaluate(() => window.pdfLab.errors), []);
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  const report = { passed: true, pdfjsVersion: require('pdfjs-dist/package.json').version, results, pageErrors };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); server.kill(); }
