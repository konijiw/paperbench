// PDF.js can split a word into multiple items when font size/style changes.
// Keep those touching fragments together, while preserving word and column gaps.
export function pdfTextContentToText(content) {
  const items = content.items.filter(item => typeof item.str === 'string');
  return items.map((item, index) => {
    if (item.hasEOL) return item.str + '\n';
    const next = items[index + 1];
    let separator = ' ';
    if (item.str && next?.str && !/\s$/.test(item.str) && !/^\s/.test(next.str) &&
        item.transform && next.transform && item.dir === 'ltr' && next.dir === 'ltr') {
      const height = Math.abs(item.transform[3]);
      const gap = next.transform[4] - item.transform[4] - item.width;
      if (height > 0 && Math.abs(next.transform[5] - item.transform[5]) < height * .08 &&
          gap >= -height * .08 && gap <= height * .12) separator = '';
    }
    return item.str + separator;
  }).join('').trim();
}
