// One background text job at a time. Reading/annotation rendering is separate.
let manager;
const search = window.PaperSearch;
class IndexManager {
  constructor(root) {
    this.root = root; this.queue = new Map(); this.running = false; this.cancelled = false;
    this.abort = new AbortController(); this.worker = null; this.rejectJob = null; this.id = 0;
    this.completed = new Set(); this.failed = new Set();
  }
  cancel() { this.cancelled = true; this.abort.abort(); this.worker?.terminate(); this.rejectJob?.(new Error('Cancelled')); }
  refresh(papers) {
    papers = papers.filter(p => !p.hasMarkdown);
    const valid = new Set(papers.map(p => p.path));
    for (const path of this.completed) if (!valid.has(path)) this.completed.delete(path);
    for (const path of this.failed) if (!valid.has(path)) this.failed.delete(path);
    for (const path of this.queue.keys()) if (!valid.has(path)) this.queue.delete(path);
    for (const paper of papers) this.queue.set(paper.path, paper);
    this.total = papers.length; this.run();
  }
  async request(url, body) {
    const response = await fetch(url, { signal: this.abort.signal, ...(body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'PDF search request failed'); return result;
  }
  extract(url) {
    if (!this.worker) this.worker = new Worker(new URL('./search-worker.mjs', import.meta.url), { type: 'module' });
    return new Promise((resolve,reject) => {
      const id = ++this.id;
      let timer;
      const fail = error => { clearTimeout(timer); reject(error); };
      this.rejectJob = fail;
      timer = setTimeout(() => {
        this.worker?.terminate(); this.worker = null; this.rejectJob = null;
        fail(new Error('PDF 文字索引超时，可刷新论文库重试'));
      }, 90000);
      this.worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        clearTimeout(timer);
        this.rejectJob = null;
        if (data.ok) resolve(data.result); else fail(new Error(data.error));
      };
      this.worker.onerror = event => {
        clearTimeout(timer);
        this.worker?.terminate(); this.worker = null; this.rejectJob = null;
        fail(new Error(event.message || 'PDF search worker failed'));
      };
      this.worker.postMessage({ id, url });
    });
  }
  async run() {
    if (this.running || this.cancelled) return;
    this.running = true;
    while (this.queue.size && !this.cancelled) {
      const [path] = this.queue.keys(); this.queue.delete(path);
      try {
        const existing = search.getPdfIndex(path);
        const query = new URLSearchParams({ root: this.root, paper: path, known: existing?.signature || '' });
        const state = await this.request('/api/pdf-search/status?' + query);
        if (this.cancelled) break;
        if (state.eligible === false) { search.removePdfIndex(path); continue; }
        if (state.cached) {
          if (state.text !== null) search.setPdfIndex(path, state);
        } else {
          search.removePdfIndex(path);
          const url = '/api/pdf-search/source?' + new URLSearchParams({ root: this.root, paper: path, signature: state.signature });
          const result = await this.extract(url);
          if (this.cancelled) break;
          await this.request('/api/pdf-search/save', { root: this.root, paper: path, signature: state.signature, ...result });
          if (this.cancelled) break;
          search.setPdfIndex(path, { signature: state.signature, ...result });
        }
        this.completed.add(path); this.failed.delete(path);
      } catch (error) {
        if (!this.cancelled) { this.failed.add(path); console.warn('PDF 搜索索引暂不可用：', path, error.message); }
      }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    this.running = false;
  }
}
function refresh() {
  const library = search.library;
  if (!library) return;
  if (!manager || manager.root !== library.root) { manager?.cancel(); manager = new IndexManager(library.root); }
  manager.refresh(library.papers);
}
window.addEventListener('paperbench-search-library', refresh);
window.addEventListener('pagehide', () => manager?.cancel());
refresh();
