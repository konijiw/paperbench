// Manual region selection only: no figure detection, OCR, or background work.
export function installPdfCapture({ container, viewer, getPdf, onImage, notice }) {
  let layer, box, start, busy = false;
  function cancel() {
    layer?.remove(); layer = box = start = null;
    document.removeEventListener('keydown', keydown, true);
  }
  function keydown(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }
  function invalidate() {
    // PDF.js may finish fit-to-width after the capture button is clicked.
    // Keep the mode open until dragging starts; a live rectangle is cancelled.
    if (start) cancel();
    else if (layer) begin();
  }
  function begin() {
    if (!getPdf() || busy) return;
    cancel(); window.getSelection()?.removeAllRanges();
    const bounds = container.getBoundingClientRect();
    layer = document.createElement('div'); layer.className = 'pb-capture-layer';
    Object.assign(layer.style, { left: bounds.left + 'px', top: bounds.top + 'px', width: bounds.width + 'px', height: bounds.height + 'px' });
    const hint = document.createElement('div'); hint.className = 'pb-capture-hint'; hint.textContent = '框选单页区域 · Esc 取消';
    const close = document.createElement('button'); close.textContent = '取消'; close.onclick = cancel; hint.append(close);
    box = document.createElement('div'); box.className = 'pb-capture-box'; box.hidden = true;
    layer.append(hint, box); document.body.append(layer); document.addEventListener('keydown', keydown, true);
    layer.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      let page;
      for (let i = 0; i < getPdf().numPages; i++) {
        const candidate = viewer.getPageView(i), r = candidate.div.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { page = candidate; break; }
      }
      if (!page) return;
      e.preventDefault(); layer.setPointerCapture(e.pointerId);
      const r = page.div.getBoundingClientRect();
      start = { x: e.clientX, y: e.clientY, page, bounds: r, id: e.pointerId };
      update(e);
    });
    function update(e) {
      if (!start || e.pointerId !== start.id) return;
      const r = start.bounds, x = Math.max(r.left, Math.min(r.right, e.clientX)), y = Math.max(r.top, Math.min(r.bottom, e.clientY));
      start.rect = { left: Math.min(x, start.x), top: Math.min(y, start.y), right: Math.max(x, start.x), bottom: Math.max(y, start.y) };
      Object.assign(box.style, { left: start.rect.left - bounds.left + 'px', top: start.rect.top - bounds.top + 'px',
        width: start.rect.right - start.rect.left + 'px', height: start.rect.bottom - start.rect.top + 'px' }); box.hidden = false;
    }
    layer.addEventListener('pointermove', update);
    layer.addEventListener('pointercancel', cancel);
    layer.addEventListener('pointerup', async e => {
      if (!start || e.pointerId !== start.id) return;
      update(e); const chosen = start;
      if (chosen.rect.right - chosen.rect.left < 8 || chosen.rect.bottom - chosen.rect.top < 8) { start = null; box.hidden = true; return; }
      cancel(); busy = true;
      try {
        const page = chosen.page, source = getPdf(), pdfPage = await source.getPage(page.id);
        const r = chosen.rect, b = chosen.bounds, v = page.viewport;
        const points = [[r.left,r.top],[r.right,r.top],[r.right,r.bottom],[r.left,r.bottom]]
          .map(([x,y]) => v.convertToPdfPoint((x-b.left)*v.width/b.width, (y-b.top)*v.height/b.height));
        // Render from the PDF, independent of viewer zoom and display overlays.
        const area = (r.right-r.left)*v.width/b.width * (r.bottom-r.top)*v.height/b.height / (v.scale*v.scale);
        const scale = Math.min(2.5, Math.sqrt(6*1024*1024 / Math.max(1,area)));
        const target = pdfPage.getViewport({ scale, rotation: v.rotation });
        const projected = points.map(([x,y]) => target.convertToViewportPoint(x,y));
        const x = Math.floor(Math.min(...projected.map(p=>p[0]))), y = Math.floor(Math.min(...projected.map(p=>p[1])));
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(Math.max(...projected.map(p=>p[0])))-x;
        canvas.height = Math.ceil(Math.max(...projected.map(p=>p[1])))-y;
        await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: target, transform:[1,0,0,1,-x,-y] }).promise;
        if (source === getPdf()) onImage(canvas.toDataURL('image/png'), page.id);
        canvas.width = canvas.height = 0;
      } catch (error) { notice('截图失败：' + error.message); }
      finally { busy = false; }
    });
  }
  container.addEventListener('scroll', invalidate, { passive:true });
  window.addEventListener('resize', invalidate);
  return { begin, cancel, invalidate };
}
