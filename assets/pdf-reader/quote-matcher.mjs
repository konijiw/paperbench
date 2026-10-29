// Match legacy Markdown quotes without rewriting the saved Markdown anchors.
// Every normalized character retains its original offset for precise ranges.
export function normalizeWithOffsets(text) {
  let value = '', offsets = [];
  for (let i = 0; i < text.length;) {
    const char = String.fromCodePoint(text.codePointAt(i)), start = i;
    i += char.length;
    if (/[-\u2010]/u.test(char) && /^[ \t]*\n/.test(text.slice(i))) continue;
    const normalized = char.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑–—]/g, '-');
    for (const part of normalized) {
      if (/[\s\u00ad\u200b-\u200d\ufeff]/u.test(part)) continue;
      value += part;
      for (let j = 0; j < part.length; j++) offsets.push(start);
    }
  }
  return { value, offsets };
}
const compact = text => normalizeWithOffsets(String(text || '')).value;
function commonStart(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
function commonEnd(a, b) { let i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }
export function findQuote(text, quote, prefix = '', suffix = '') {
  const needle = compact(quote);
  if (!needle) return { status: 'missing' };
  const before = compact(prefix).slice(-100), after = compact(suffix).slice(0, 100);
  const candidates = [];
  for (let from = 0, at; (at = text.indexOf(needle, from)) >= 0; from = at + 1) {
    candidates.push({ at, score: commonEnd(text.slice(Math.max(0, at - before.length), at), before) +
      commonStart(text.slice(at + needle.length, at + needle.length + after.length), after) });
    if (candidates.length > 2000) return { status: 'ambiguous' };
  }
  if (!candidates.length) return { status: 'missing' };
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) return { status: 'ambiguous' };
  return { status: 'matched', start: candidates[0].at, end: candidates[0].at + needle.length };
}

export class PDFQuoteMatcher {
  constructor(pdf) { this.pdf = pdf; this.index = null; }
  async build() {
    if (this.index) return this.index;
    this.index = (async () => {
      let raw = ''; const items = [];
      for (let page = 1; page <= this.pdf.numPages; page++) {
        const content = await (await this.pdf.getPage(page)).getTextContent();
        let span = 0;
        for (const item of content.items) {
          if (typeof item.str !== 'string' || !item.str) continue;
          const start = raw.length; raw += item.str;
          items.push({ start, end: raw.length, page, span: span++, item, style: content.styles[item.fontName] });
          raw += item.hasEOL ? '\n' : ' ';
        }
        raw += '\n';
        // Index text only, not canvases, and let interaction remain responsive.
        if (page % 3 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { ...normalizeWithOffsets(raw), items, raw };
    })();
    return this.index;
  }
  async resolve(annotation) {
    const index = await this.build();
    const match = findQuote(index.value, annotation.quote, annotation.prefix, annotation.suffix);
    if (match.status !== 'matched') return match;
    const start = index.offsets[match.start], lastOffset = index.offsets[match.end - 1];
    const end = lastOffset + String.fromCodePoint(index.raw.codePointAt(lastOffset)).length;
    const fragments = new Map();
    for (const entry of index.items) {
      if (entry.end <= start || entry.start >= end) continue;
      const first = Math.max(0, start - entry.start), last = Math.min(entry.item.str.length, end - entry.start);
      let fragment = fragments.get(entry.page);
      if (!fragment) { fragment = { page: entry.page, quads: [], textRanges: [] }; fragments.set(entry.page, fragment); }
      fragment.textRanges.push({ span: entry.span, text: entry.item.str, start: first, end: last });
      // These estimates are for initial scrolling only. Visible highlights use
      // the remeasured character ranges after the text layer is ready.
      const item = entry.item, t = item.transform, length = Math.hypot(t[0], t[1]) || 1;
      const ux = t[0] / length, uy = t[1] / length;
      const height = item.height || length, ascent = entry.style?.ascent ?? .8;
      const descent = entry.style?.descent ?? -.2;
      const x0 = item.width * first / item.str.length, x1 = item.width * last / item.str.length;
      const point = (x, y) => [t[4] + ux * x - uy * y, t[5] + uy * x + ux * y];
      fragment.quads.push([point(x0, height * ascent), point(x1, height * ascent),
        point(x1, height * descent), point(x0, height * descent)].flat());
    }
    return { status: 'matched', anchor: { version: 1, fingerprint: this.pdf.fingerprints[0],
      fragments: [...fragments.values()] } };
  }
}
