import * as pdfjs from './pdfjs/build/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf-reader/pdfjs/build/pdf.worker.mjs';
let busy = false;
window.PaperBenchPdfProcessing = {
  async extract(paper, progress) {
    if (busy) throw new Error('已有文本提取任务，请等待完成');
    busy = true;
    const task = pdfjs.getDocument({ url: '/content/pdf?paper=' + encodeURIComponent(paper),
      cMapUrl: '/pdf-reader/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: '/pdf-reader/pdfjs/standard_fonts/', wasmUrl: '/pdf-reader/pdfjs/wasm/' });
    try {
      const pdf = await task.promise;
      const parts = [`PDF 文本提取 · 共 ${pdf.numPages} 页\n页码为物理页码。普通文字提取不保证公式、表格及多栏阅读顺序正确。\n`];
      let characters = 0, total = 0;
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent();
        const text = content.items.filter(item => typeof item.str === 'string')
          .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
        characters += text.replace(/\s/g, '').length;
        const part = `\n\n===== PDF 第 ${number} / ${pdf.numPages} 页 =====\n\n${text || '[本页未提取到文字]'}\n`;
        total += part.length;
        if (total > 8 * 1024 * 1024) throw new Error('提取文本超过 8 MB，请使用精细解析或拆分文档');
        parts.push(part); page.cleanup(); progress?.(number, pdf.numPages);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!characters) throw new Error('此 PDF 没有可提取的文字，可能是扫描件；请使用精细解析');
      return parts.join('');
    } finally { await task.destroy().catch(() => {}); busy = false; }
  },
};
