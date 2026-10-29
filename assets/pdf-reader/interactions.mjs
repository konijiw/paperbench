// PDF-local gestures: never intercept wheel events outside the reading surface.
export function installPdfGestures({ container, viewer, hasDocument, onZoom }) {
  let wheelTarget, wheelApplied, pan = null, auto = null, frame = 0;
  const indicator = document.createElement('div');
  indicator.className = 'pb-pan-indicator'; indicator.textContent = '✥';
  indicator.setAttribute('aria-hidden', 'true'); indicator.hidden = true;
  document.body.append(indicator);
  function stopAuto() {
    auto = null; cancelAnimationFrame(frame); indicator.hidden = true;
    container.classList.remove('pb-autopan');
  }
  function stop() {
    stopAuto();
    if (pan && container.hasPointerCapture(pan.id)) container.releasePointerCapture(pan.id);
    pan = null; container.classList.remove('pb-panning');
  }
  function wheel(event) {
    if (!hasDocument() || !event.ctrlKey) return;
    event.preventDefault(); event.stopPropagation(); stop();
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1;
    const delta = Math.max(-100, Math.min(100, event.deltaY * unit));
    if (viewer.currentScale !== wheelApplied) wheelTarget = viewer.currentScale;
    wheelTarget = Math.max(.25, Math.min(4, (wheelTarget ?? viewer.currentScale) * Math.exp(-delta * .002)));
    onZoom();
    const bounds = container.getBoundingClientRect();
    // PDFViewer's origin uses its offset-parent coordinates. Our reader is
    // nested below a toolbar, so raw client coordinates would shift the focus.
    viewer.updateScale({ scaleFactor: wheelTarget / viewer.currentScale, drawingDelay: 120,
      origin: [event.clientX - bounds.left + container.offsetLeft,
        event.clientY - bounds.top + container.offsetTop] });
    wheelApplied = viewer.currentScale;
  }
  function tick(now) {
    if (!auto) return;
    const dt = Math.min(32, now - auto.time) / 1000; auto.time = now;
    const velocity = value => Math.sign(value) * Math.min(1600, Math.max(0, Math.abs(value) - 12) * 9);
    container.scrollLeft += velocity(auto.x - auto.originX) * dt;
    container.scrollTop += velocity(auto.y - auto.originY) * dt;
    frame = requestAnimationFrame(tick);
  }
  function down(event) {
    if (event.button !== 1 || !hasDocument()) return;
    event.preventDefault(); event.stopPropagation();
    if (auto) { stopAuto(); return; }
    pan = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: container.scrollLeft, top: container.scrollTop, moved: false };
    container.setPointerCapture(event.pointerId);
    container.classList.add('pb-panning');
  }
  function move(event) {
    if (auto) { auto.x = event.clientX; auto.y = event.clientY; }
    if (!pan || event.pointerId !== pan.id) return;
    const dx = event.clientX - pan.x, dy = event.clientY - pan.y;
    if (Math.hypot(dx, dy) > 4) pan.moved = true;
    if (!pan.moved) return;
    event.preventDefault();
    container.scrollLeft = pan.left - dx; container.scrollTop = pan.top - dy;
  }
  function up(event) {
    if (event.button !== 1 || !pan || event.pointerId !== pan.id) return;
    event.preventDefault(); const completed = pan; pan = null;
    if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
    container.classList.remove('pb-panning');
    if (!completed.moved) {
      auto = { originX: event.clientX, originY: event.clientY,
        x: event.clientX, y: event.clientY, time: performance.now() };
      indicator.style.left = `${event.clientX}px`; indicator.style.top = `${event.clientY}px`;
      indicator.hidden = false; container.classList.add('pb-autopan'); frame = requestAnimationFrame(tick);
    }
  }
  container.addEventListener('wheel', wheel, { passive: false, capture: true });
  container.addEventListener('pointerdown', down, true);
  container.addEventListener('pointermove', move);
  container.addEventListener('pointerup', up);
  container.addEventListener('pointercancel', stop);
  container.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  document.addEventListener('pointermove', event => { if (auto) { auto.x = event.clientX; auto.y = event.clientY; } });
  document.addEventListener('pointerdown', event => { if (auto && event.button !== 1) stopAuto(); }, true);
  document.addEventListener('keydown', () => { if (auto) stopAuto(); });
  window.addEventListener('blur', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  return { stop };
}
