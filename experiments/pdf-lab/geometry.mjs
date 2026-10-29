// Coordinates persisted by this experiment are PDF user-space points.
// Device pixels are deliberately absent: the viewer owns raster resolution.
export function clientRectToQuad(rect, surface, viewport) {
  const point = (x, y) => viewport.convertToPdfPoint(
    (x - surface.left) * viewport.width / surface.width,
    (y - surface.top) * viewport.height / surface.height,
  );
  return [point(rect.left, rect.top), point(rect.right, rect.top),
    point(rect.right, rect.bottom), point(rect.left, rect.bottom)].flat();
}

export function quadToViewport(quad, viewport) {
  const points = [];
  for (let i = 0; i < quad.length; i += 2)
    points.push(viewport.convertToViewportPoint(quad[i], quad[i + 1]));
  return points;
}

// Typography is not a semantic boundary. Cluster by visual line, then join only
// nearby runs. Fixed seed bands prevent a tall formula from chaining two lines.
// The returned rects can overlap: a single SVG path/group composites them once.
export function highlightRects(polygons, rotation = 0) {
  const vertical = Math.abs(rotation % 180) === 90;
  const boxes = polygons.map(points => {
    const along = points.map(p => p[vertical ? 1 : 0]);
    const across = points.map(p => p[vertical ? 0 : 1]);
    return { a: Math.min(...along), b: Math.max(...along),
      c: Math.min(...across), d: Math.max(...across) };
  }).filter(r => r.b > r.a && r.d > r.c);
  const lines = [];
  // Prefer long main-text runs over isolated superscripts as line seeds.
  for (const rect of boxes.sort((a, b) => (b.b - b.a) - (a.b - a.a))) {
    const height = rect.d - rect.c, center = (rect.c + rect.d) / 2;
    let match, score = Infinity;
    for (const line of lines) {
      const distance = Math.abs(center - line.center);
      const overlap = Math.min(rect.d, line.d) - Math.max(rect.c, line.c);
      if (distance > Math.max(height, line.height) * .7 || overlap < -line.height * .15) continue;
      if (distance < score) { match = line; score = distance; }
    }
    if (match) match.runs.push(rect);
    else lines.push({ center, height, c: rect.c, d: rect.d, runs: [rect] });
  }
  const result = [];
  for (const line of lines) {
    const runs = line.runs.sort((a, b) => a.a - b.a);
    let current;
    for (const run of runs) {
      if (current && run.a - current.b <= line.height * .75) {
        current.b = Math.max(current.b, run.b);
        current.c = Math.min(current.c, run.c); current.d = Math.max(current.d, run.d);
      } else { current = { ...run }; result.push(current); }
    }
  }
  return result.map(r => vertical
    ? { x: r.c, y: r.a, width: r.d - r.c, height: r.b - r.a }
    : { x: r.a, y: r.c, width: r.b - r.a, height: r.d - r.c });
}

export function rectsPath(rects) {
  return rects.map(r => `M${r.x},${r.y}h${r.width}v${r.height}h${-r.width}Z`).join('');
}

export function validAnnotation(annotation, pageCount) {
  return typeof annotation?.id === 'string' && typeof annotation.quote === 'string' &&
    typeof annotation.comment === 'string' && Array.isArray(annotation.fragments) &&
    annotation.fragments.length > 0 && annotation.fragments.every(fragment =>
      Number.isInteger(fragment.page) && fragment.page > 0 && fragment.page <= pageCount &&
      Array.isArray(fragment.quads) && fragment.quads.length > 0 &&
      fragment.quads.every(q => Array.isArray(q) && q.length === 8 && q.every(Number.isFinite)) &&
      (fragment.textRanges === undefined || (Array.isArray(fragment.textRanges) && fragment.textRanges.every(a =>
        Number.isInteger(a.span) && a.span >= 0 && typeof a.text === 'string' &&
        Number.isInteger(a.start) && Number.isInteger(a.end) && a.start >= 0 &&
        a.end > a.start && a.end <= a.text.length))));
}
