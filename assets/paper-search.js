(function (global) {
  'use strict';
  var pdfIndexes = new Map(), markdownPaths = new Set(), library = null;
  function pathKey(value) { return normalizeSearch(value).replace(/\\/g, '/'); }
  function notify(name) {
    if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') global.dispatchEvent(new global.CustomEvent(name));
  }
  function normalizeSearch(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase();
  }

  function compactSearch(value) {
    return normalizeSearch(value).replace(/[\p{P}\p{S}\s]+/gu, '');
  }

  function oneEditApart(left, right) {
    if (Math.abs(left.length - right.length) > 1 || left === right) return false;
    var i = 0, j = 0, edits = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (left.length > right.length) i++;
      else if (right.length > left.length) j++;
      else { i++; j++; }
    }
    return edits + (left.length - i) + (right.length - j) <= 1;
  }

  function prepare(value) {
    var normalized = normalizeSearch(value);
    return { compact: compactSearch(value), words: Array.from(new Set(normalized.match(/[a-z0-9]+/g) || [])) };
  }
  function preparedScore(prepared, query) {
    var compact = prepared.compact;
    if (!compact) return null;
    var whole = compactSearch(query);
    if (whole && compact.indexOf(whole) >= 0) return compact.indexOf(whole) === 0 ? 0 : 1;
    var terms = normalizeSearch(query).split(/[\p{P}\p{S}\s]+/u).filter(Boolean);
    if (!terms.length) return null;
    var words = prepared.words;
    var penalty = 0;
    for (var i = 0; i < terms.length; i++) {
      var term = compactSearch(terms[i]);
      if (!term) continue;
      if (compact.indexOf(term) >= 0) { penalty += 1; continue; }
      if (!/^[a-z0-9]{4,}$/.test(term) || !words.some(function (word) { return oneEditApart(term, word); })) return null;
      penalty += 4;
    }
    return 3 + penalty;
  }
  function fieldSearchScore(value, query) { return preparedScore(prepare(value), query); }

  function score(paper, query, includeTags) {
    var fields = [paper.title, paper.parsedTitle, paper.name, paper.path];
    if (includeTags) fields = fields.concat(Array.isArray(paper.tags) ? paper.tags : []);
    fields = fields.concat(paper.searchFields || []);
    var best = null;
    fields.forEach(function (field, index) {
      var value = fieldSearchScore(field, query);
      if (value !== null) best = best === null ? index * 10 + value : Math.min(best, index * 10 + value);
    });
    var key = pathKey(paper.path || paper.paper);
    var pdf = !paper.hasMarkdown && !markdownPaths.has(key) ? pdfIndexes.get(key) : null;
    if (pdf) {
      var textScore = preparedScore(pdf.textSearch, query);
      // Only PDF-only opening excerpts supplement the original search fields.
      if (textScore !== null) best = best === null ? 1000 + textScore : Math.min(best, 1000 + textScore);
    }
    return best;
  }
  function filter(records, query, includeTags) {
    query = String(query || '').trim();
    if (!query) return records.slice();
    return records.map(function (paper, index) { return { paper: paper, score: score(paper, query, includeTags), index: index }; })
      .filter(function (item) { return item.score !== null; })
      .sort(function (a, b) { return a.score - b.score || String(a.paper.parsedTitle || a.paper.name || a.paper.title).localeCompare(String(b.paper.parsedTitle || b.paper.name || b.paper.title), 'zh-CN') || a.index - b.index; })
      .map(function (item) { return item.paper; });
  }
  var api = { score: score, filter: filter,
    setLibrary: function (root, papers) {
      if (!library || library.root !== root) { pdfIndexes.clear(); notify('paperbench-search-updated'); }
      library = { root: root, papers: papers || [] }; api.library = library;
      markdownPaths = new Set(library.papers.filter(function (paper) { return paper.hasMarkdown; }).map(function (paper) { return pathKey(paper.path); }));
      var paths = new Set(library.papers.map(function (paper) { return pathKey(paper.path); }));
      var removed = false;
      pdfIndexes.forEach(function (_, key) { if (!paths.has(key) || markdownPaths.has(key)) { pdfIndexes.delete(key); removed = true; } });
      if (removed) notify('paperbench-search-updated');
      notify('paperbench-search-library');
    },
    setPdfIndex: function (path, record) {
      var key = pathKey(path), previous = pdfIndexes.get(key);
      if (markdownPaths.has(key)) return;
      if (previous && previous.signature === record.signature) return;
      var text = String(record.text || '').slice(0, 800);
      pdfIndexes.set(key, Object.assign({}, record, { title: '', text: text, textSearch: prepare(text) }));
      notify('paperbench-search-updated');
    },
    removePdfIndex: function (path) { if (pdfIndexes.delete(pathKey(path))) notify('paperbench-search-updated'); },
    getPdfIndex: function (path) { return pdfIndexes.get(pathKey(path)); }
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.PaperSearch = api;
})(typeof window === 'undefined' ? globalThis : window);
