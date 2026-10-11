(function () {
  'use strict';

  var state = {
    tree: null,
    papers: [],
    currentPath: null,
    currentPaper: null,
    markdownSource: '',
    selectedText: null,
    selectedImage: null,
    editingAnnotationId: null,
    dirty: false,
    saveTimer: null,
    loadToken: 0,
    filter: 'all',
    scope: 'all',
    query: '',
    viewMode: 'files',
    pendingTags: [],
    tagAction: null
  };

  var els = {};
  ['libraryPath','chooseRoot','refreshTree','paperCount','manageTags','libraryScope','treeMode','treeSearch','statusFilters','fileTree',
   'emptyState','paperView','paperTitle','paperMeta','pdfName','pdfFrame','markdownPane',
   'markdownContent','readingLayout','readerDivider','togglePdf','collapsePdf','pdfRail','sendSelectionToAi','annotateSelection','toggleNotes','saveState',
   'notesPanel','closeNotes','annotationCount','paperNote','annotationList','annotationDialog',
   'dialogTitle','selectedQuote','annotationText','confirmAnnotation','metadataDialog','editMetadata','customTitle','tagChips','availableTags','tagInput','addTag','saveMetadata','tagManagerDialog','tagManagerSummary','tagManagerSearch','tagManagerList','tagActionDialog','tagActionTitle','tagActionDescription','tagActionInput','tagSuggestions','confirmTagAction','favoritePaper','toast','aiPanel','aiRail','collapseAi','aiChatRoot','notesResizer','aiResizer'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  function api(url, options) {
    return fetch(url, options).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (text) {
          try { throw new Error(JSON.parse(text).error || text); }
          catch (e) { if (e instanceof SyntaxError) throw new Error(text || ('请求失败：' + response.status)); throw e; }
        });
      }
      var type = response.headers.get('content-type') || '';
      return type.indexOf('application/json') >= 0 ? response.json() : response.text();
    });
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { els.toast.classList.remove('show'); }, 2300);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, function (char) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char];
    });
  }

  function tagHue(tag) {
    var palette = [210, 266, 326, 8, 38, 88, 146, 178, 196, 238, 288, 348];
    var hash = 0;
    Array.from(String(tag || '')).forEach(function (char) { hash = ((hash * 31) + char.codePointAt(0)) >>> 0; });
    return palette[hash % palette.length];
  }

  function tagStyle(tag) { return '--tag-hue:' + tagHue(tag); }

  function statusLabel(value) {
    return value === 'deep' ? '已精读' : value === 'skimmed' ? '已粗读' : '未读';
  }

  function collectPapers(node, output) {
    if (!node) return;
    if (node.paper) output.push(node);
    (node.children || []).forEach(function (child) { collectPapers(child, output); });
  }

  function loadTree(keepSelection) {
    els.refreshTree.disabled = true;
    els.fileTree.innerHTML = '<div class="tree-loading">正在扫描论文目录…</div>';
    return api('/api/tree').then(function (data) {
      state.tree = data.tree;
      state.papers = [];
      collectPapers(data.tree, state.papers);
      els.libraryPath.textContent = data.libraryRoot;
      els.libraryPath.title = data.libraryRoot;
      els.paperCount.textContent = state.papers.length;
      renderTree();
      if (keepSelection && state.currentPath && !state.papers.some(function (p) { return p.path === state.currentPath; })) clearPaper();
    }).catch(function (error) {
      els.fileTree.innerHTML = '<div class="tree-empty">扫描失败：' + escapeHtml(error.message) + '</div>';
      showToast('论文库扫描失败');
    }).then(function () { els.refreshTree.disabled = false; });
  }

  function renderTree() {
    var query = state.query.trim().toLocaleLowerCase();
    var filtered = state.papers.filter(function (paper) {
      var tags = Array.isArray(paper.tags) ? paper.tags : [];
      var title = String(paper.title || '');
      var searchable = state.viewMode === 'tags'
        ? [title, paper.name, paper.path].concat(tags).join('\n')
        : [paper.name, paper.path].join('\n');
      return (!query || searchable.toLocaleLowerCase().indexOf(query) >= 0) &&
        (state.filter === 'all' || paper.status === state.filter) &&
        (state.scope !== 'favorites' || paper.favorite) &&
        (state.scope !== 'recent' || paper.lastOpenedAt);
    });
    if (!filtered.length) {
      els.fileTree.innerHTML = '<div class="tree-empty">没有符合当前条件的论文。</div>';
      return;
    }
    if (state.scope === 'recent') {
      filtered.sort(function (a, b) { return String(b.lastOpenedAt || '').localeCompare(String(a.lastOpenedAt || '')); });
      els.fileTree.innerHTML = filtered.map(function (paper) { return paperRow(paper, 0, paper.title || paper.name); }).join('');
    } else if (state.viewMode === 'tags') {
      els.fileTree.innerHTML = renderTagTree(filtered);
    } else if (query || state.filter !== 'all' || state.scope !== 'all') {
      els.fileTree.innerHTML = filtered.map(function (paper) { return paperRow(paper, 0, paper.name); }).join('');
    } else {
      els.fileTree.innerHTML = renderTreeNode(state.tree, 0, true);
    }
    bindTreeEvents();
  }

  function renderTreeNode(node, depth, root) {
    if (!node) return '';
    if (node.paper) return paperRow(node, depth, node.name);
    var children = (node.children || []).map(function (child) { return renderTreeNode(child, depth + (root ? 0 : 1), false); }).join('');
    if (root) return children;
    return '<div class="tree-folder" data-path="' + escapeHtml(node.path) + '">' +
      '<div class="tree-row folder" style="padding-left:' + (7 + depth * 14) + 'px"><span class="tree-arrow">▼</span><span class="tree-icon">▰</span><span class="tree-label" title="' + escapeHtml(node.path) + '">' + escapeHtml(node.name) + '</span></div>' +
      '<div class="tree-children">' + children + '</div></div>';
  }

  function paperRow(paper, depth, label) {
    var active = paper.path === state.currentPath ? ' active' : '';
    return '<div class="tree-row paper' + active + '" data-paper="' + escapeHtml(paper.path) + '" style="padding-left:' + (8 + depth * 14) + 'px" title="' + escapeHtml(paper.path) + '">' +
      '<span class="tree-arrow"></span><span class="tree-icon">▤</span><span class="tree-label">' + escapeHtml(label || paper.name) + '</span>' +
      (paper.favorite ? '<span class="favorite-marker" title="已收藏">★</span>' : '') +
      '<span class="status-dot ' + escapeHtml(paper.status || 'unread') + '" title="' + statusLabel(paper.status) + '"></span></div>';
  }

  function renderTagTree(papers) {
    var untagged = [];
    var groups = {};
    papers.forEach(function (paper) {
      var tags = Array.isArray(paper.tags) ? paper.tags.filter(Boolean) : [];
      if (!tags.length) untagged.push(paper);
      tags.forEach(function (tag) {
        var key = String(tag).trim();
        if (!key) return;
        var normalized = key.toLocaleLowerCase();
        if (!groups[normalized]) groups[normalized] = { name: key, papers: [] };
        groups[normalized].papers.push(paper);
      });
    });
    var html = untagged.map(function (paper) { return paperRow(paper, 0, paper.title || paper.name); }).join('');
    Object.keys(groups).sort(function (a, b) { return groups[a].name.localeCompare(groups[b].name, 'zh-CN'); }).forEach(function (key) {
      var group = groups[key];
      var rows = group.papers.slice().sort(function (a, b) {
        return String(a.title || a.name).localeCompare(String(b.title || b.name), 'zh-CN');
      }).map(function (paper) { return paperRow(paper, 1, paper.title || paper.name); }).join('');
      html += '<div class="tree-folder tag-folder" data-tag="' + escapeHtml(group.name) + '">' +
        '<div class="tree-row folder tag-colored" style="padding-left:7px;' + tagStyle(group.name) + '"><span class="tree-arrow">▼</span><span class="tree-icon">◆</span><span class="tree-label" title="' + escapeHtml(group.name) + '">' + escapeHtml(group.name) + '</span><span class="tag-count">' + group.papers.length + '</span></div>' +
        '<div class="tree-children">' + rows + '</div></div>';
    });
    return html;
  }

  function bindTreeEvents() {
    Array.prototype.forEach.call(els.fileTree.querySelectorAll('.tree-row.paper'), function (row) {
      row.addEventListener('click', function () { openPaper(row.getAttribute('data-paper')); });
    });
    Array.prototype.forEach.call(els.fileTree.querySelectorAll('.tree-row.folder'), function (row) {
      row.addEventListener('click', function () {
        var children = row.nextElementSibling;
        children.classList.toggle('collapsed');
        row.querySelector('.tree-arrow').textContent = children.classList.contains('collapsed') ? '▶' : '▼';
      });
    });
  }

  function clearPaper() {
    state.currentPath = null;
    state.currentPaper = null;
    state.markdownSource = '';
    state.selectedImage = null;
    els.paperView.classList.add('hidden');
    els.emptyState.classList.remove('hidden');
    els.notesPanel.classList.add('hidden');
    els.pdfFrame.removeAttribute('src');
    renderTree();
  }

  function openPaper(path) {
    if (!path || path === state.currentPath) return;
    var token = ++state.loadToken;
    Promise.resolve(state.dirty ? saveNow() : null).then(function () {
      state.currentPath = path;
      state.selectedText = null;
      state.selectedImage = null;
      els.annotateSelection.disabled = true;
      els.sendSelectionToAi.disabled = true;
      renderTree();
      els.emptyState.classList.add('hidden');
      els.paperView.classList.remove('hidden');
      els.paperTitle.textContent = '正在加载…';
      els.paperMeta.textContent = path;
      els.markdownContent.innerHTML = '<p class="loading-text">正在渲染 Markdown…</p>';
      return Promise.all([
        api('/api/paper?path=' + encodeURIComponent(path)),
        api('/content/markdown?paper=' + encodeURIComponent(path))
      ]);
    }).then(function (values) {
      if (token !== state.loadToken) return;
      state.currentPaper = values[0];
      state.markdownSource = values[1];
      normalizeReview();
      var openedPaper = state.papers.filter(function (item) { return item.path === state.currentPath; })[0];
      if (openedPaper) {
        openedPaper.favorite = state.currentPaper.review.favorite;
        openedPaper.lastOpenedAt = state.currentPaper.review.lastOpenedAt;
      }
      els.paperTitle.textContent = state.currentPaper.review.title || state.currentPaper.name;
      els.paperTitle.title = state.currentPaper.review.title || state.currentPaper.name;
      els.paperMeta.textContent = state.currentPaper.path;
      els.pdfName.textContent = state.currentPaper.pdfName;
      els.paperNote.value = state.currentPaper.review.note || '';
      updateStatusButtons();
      updateFavoriteButton();
      renderTree();
      setPdfCollapsed(state.currentPaper.review.pdfCollapsed !== false, false);
      updateReadingSplit();
      renderAnnotations();
      window.AILiteratureChat.setPaper(state.currentPaper).catch(function (error) {
        showToast('AI 工作区切换失败：' + error.message);
      });
      return renderMarkdown(token);
    }).then(function () {
      if (token !== state.loadToken || !state.currentPaper) return;
      els.markdownContent.scrollTop = state.currentPaper.review.markdownScroll || 0;
    }).catch(function (error) {
      if (token !== state.loadToken) return;
      showToast(error.message || '论文加载失败');
      els.paperTitle.textContent = '加载失败';
      els.markdownContent.innerHTML = '<p class="loading-text">' + escapeHtml(error.message) + '</p>';
    });
  }

  function normalizeReview() {
    var review = state.currentPaper.review || {};
    review.status = review.status === 'deep' || review.status === 'skimmed' ? review.status : 'unread';
    review.note = review.note || '';
    review.title = String(review.title || '').trim();
    review.tags = Array.isArray(review.tags) ? review.tags.filter(function (tag) { return String(tag || '').trim(); }).map(function (tag) { return String(tag).trim(); }) : [];
    review.favorite = !!review.favorite;
    review.lastOpenedAt = String(review.lastOpenedAt || '');
    review.annotations = Array.isArray(review.annotations) ? review.annotations : [];
    review.markdownScroll = Number(review.markdownScroll) || 0;
    review.pdfWidth = Math.max(28, Math.min(72, Number(review.pdfWidth) || 50));
    review.pdfCollapsed = review.pdfCollapsed !== false;
    state.currentPaper.review = review;
  }

  function renderMarkdown(token) {
    var html;
    try { html = marked.parse(state.markdownSource, { gfm: true, breaks: false }); }
    catch (error) { html = '<p>Markdown 解析失败：' + escapeHtml(error.message) + '</p>'; }
    els.markdownContent.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    rewriteLocalAssets();
    var typeset = window.MathJax && window.MathJax.typesetPromise ? window.MathJax.typesetPromise([els.markdownContent]) : Promise.resolve();
    return typeset.catch(function (error) { console.warn('MathJax:', error); }).then(function () {
      if (token !== state.loadToken) return;
      applyAllHighlights();
    });
  }

  function rewriteLocalAssets() {
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img'), function (image) {
      var source = image.getAttribute('src') || '';
      if (!/^(data:|blob:|https?:|\/)/i.test(source)) {
        image.setAttribute('data-paper-file', source);
        image.src = '/content/asset?paper=' + encodeURIComponent(state.currentPath) + '&file=' + encodeURIComponent(source);
      }
      image.title = image.getAttribute('data-paper-file') ? '单击选择图片，可发送给 AI' : (image.title || '图片');
    });
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('a'), function (link) {
      var href = link.getAttribute('href') || '';
      if (!/^(#|mailto:|https?:|\/)/i.test(href)) {
        link.href = '/content/asset?paper=' + encodeURIComponent(state.currentPath) + '&file=' + encodeURIComponent(href);
        link.target = '_blank';
      } else if (/^https?:/i.test(href)) {
        link.target = '_blank'; link.rel = 'noopener noreferrer';
      }
    });
  }

  function setStatus(status) {
    if (!state.currentPaper) return;
    state.currentPaper.review.status = status;
    var paper = state.papers.filter(function (p) { return p.path === state.currentPath; })[0];
    if (paper) paper.status = status;
    updateStatusButtons();
    renderTree();
    scheduleSave();
  }

  function updateStatusButtons() {
    var status = state.currentPaper ? state.currentPaper.review.status : 'unread';
    Array.prototype.forEach.call(document.querySelectorAll('.reading-status button'), function (button) {
      button.classList.toggle('active', button.getAttribute('data-status') === status);
    });
  }

  function updateReadingSplit() {
    if (!state.currentPaper) return;
    if (els.readingLayout.classList.contains('pdf-collapsed')) { els.readingLayout.style.gridTemplateColumns = ''; return; }
    var width = state.currentPaper.review.pdfWidth;
    els.readingLayout.style.gridTemplateColumns = 'minmax(300px,' + width + '%) 6px minmax(320px,1fr)';
  }

  function setPdfCollapsed(collapsed, save) {
    if (!state.currentPaper) return;
    state.currentPaper.review.pdfCollapsed = !!collapsed;
    els.readingLayout.classList.toggle('pdf-collapsed', !!collapsed);
    els.togglePdf.textContent = collapsed ? '展开 PDF' : '折叠 PDF';
    if (collapsed) els.pdfFrame.removeAttribute('src');
    else if (!els.pdfFrame.getAttribute('src')) els.pdfFrame.src = '/content/pdf?paper=' + encodeURIComponent(state.currentPath);
    updateReadingSplit();
    if (save !== false) scheduleSave();
  }

  function captureSelection() {
    if (!state.currentPaper) return;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { state.selectedText = null; els.annotateSelection.disabled = true; if (!state.selectedImage) els.sendSelectionToAi.disabled = true; return; }
    var range = selection.getRangeAt(0);
    if (!els.markdownContent.contains(range.commonAncestorContainer)) { state.selectedText = null; els.annotateSelection.disabled = true; if (!state.selectedImage) els.sendSelectionToAi.disabled = true; return; }
    var rawSelection = selection.toString();
    var quote = rawSelection.trim();
    if (!quote) { state.selectedText = null; els.annotateSelection.disabled = true; if (!state.selectedImage) els.sendSelectionToAi.disabled = true; return; }
    if (quote.length > 1500) quote = quote.substring(0, 1500);
    var beforeRange = document.createRange();
    beforeRange.selectNodeContents(els.markdownContent);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    var before = beforeRange.toString();
    var full = els.markdownContent.textContent || '';
    var leadingWhitespace = rawSelection.indexOf(quote);
    var start = before.length + Math.max(0, leadingWhitespace);
    state.selectedText = {
      quote: quote,
      prefix: full.substring(Math.max(0, start - 50), start),
      suffix: full.substring(start + quote.length, start + quote.length + 50)
    };
    els.annotateSelection.disabled = false;
    state.selectedImage = null;
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img.ai-image-selected'), function (image) { image.classList.remove('ai-image-selected'); });
    els.sendSelectionToAi.disabled = false;
    els.sendSelectionToAi.textContent = '发给 AI';
  }

  function selectMarkdownImage(image) {
    var file = image.getAttribute('data-paper-file');
    if (!file) { showToast('目前仅支持把论文目录中的本地图片发送给 AI'); return; }
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img.ai-image-selected'), function (other) { other.classList.remove('ai-image-selected'); });
    image.classList.add('ai-image-selected');
    state.selectedImage = { file: file, url: image.src };
    state.selectedText = null;
    els.annotateSelection.disabled = true;
    els.sendSelectionToAi.disabled = false;
    els.sendSelectionToAi.textContent = '发送图片';
  }

  function sendSelectionToAi() {
    if (state.selectedImage) {
      window.AILiteratureChat.addLocalImage(state.selectedImage).then(function () {
        showToast('图片已放入 AI 对话');
        state.selectedImage = null;
        Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img.ai-image-selected'), function (image) { image.classList.remove('ai-image-selected'); });
        els.sendSelectionToAi.disabled = true;
        els.sendSelectionToAi.textContent = '发给 AI';
      }).catch(function (error) { showToast(error.message); });
      return;
    }
    if (state.selectedText && window.AILiteratureChat.addTextSelection(state.selectedText.quote)) {
      showToast('文字选区已放入 AI 对话');
      window.getSelection().removeAllRanges();
      state.selectedText = null;
      els.annotateSelection.disabled = true;
      els.sendSelectionToAi.disabled = true;
    }
  }

  function openNewAnnotationDialog() {
    if (!state.selectedText) return;
    state.editingAnnotationId = null;
    els.dialogTitle.textContent = '添加文字批注';
    els.selectedQuote.textContent = state.selectedText.quote;
    els.annotationText.value = '';
    els.annotationDialog.showModal();
    setTimeout(function () { els.annotationText.focus(); }, 20);
  }

  function openEditAnnotationDialog(id) {
    var annotation = findAnnotation(id);
    if (!annotation) return;
    state.editingAnnotationId = id;
    els.dialogTitle.textContent = '修改文字批注';
    els.selectedQuote.textContent = annotation.quote;
    els.annotationText.value = annotation.comment || '';
    els.annotationDialog.showModal();
    setTimeout(function () { els.annotationText.focus(); }, 20);
  }

  function confirmAnnotation(event) {
    event.preventDefault();
    var comment = els.annotationText.value.trim();
    if (!comment) { els.annotationText.focus(); return; }
    var now = new Date().toISOString();
    if (state.editingAnnotationId) {
      var existing = findAnnotation(state.editingAnnotationId);
      if (existing) { existing.comment = comment; existing.updatedAt = now; }
    } else {
      var annotation = {
        id: makeId(), quote: state.selectedText.quote, prefix: state.selectedText.prefix,
        suffix: state.selectedText.suffix, comment: comment, createdAt: now, updatedAt: now
      };
      state.currentPaper.review.annotations.push(annotation);
      applyOneHighlight(annotation);
    }
    els.annotationDialog.close();
    window.getSelection().removeAllRanges();
    state.selectedText = null;
    els.annotateSelection.disabled = true;
    renderAnnotations();
    els.notesPanel.classList.remove('hidden');
    scheduleSave();
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'ann-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function findAnnotation(id) {
    if (!state.currentPaper) return null;
    return state.currentPaper.review.annotations.filter(function (item) { return item.id === id; })[0] || null;
  }

  function deleteAnnotation(id) {
    if (!state.currentPaper || !window.confirm('删除这条批注？')) return;
    state.currentPaper.review.annotations = state.currentPaper.review.annotations.filter(function (item) { return item.id !== id; });
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('mark[data-annotation-id="' + cssEscape(id) + '"]'), function (mark) {
      var parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    });
    renderAnnotations();
    scheduleSave();
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function renderAnnotations() {
    var annotations = state.currentPaper ? state.currentPaper.review.annotations : [];
    els.annotationCount.textContent = annotations.length + ' 条文字批注';
    if (!annotations.length) {
      els.annotationList.innerHTML = '<div class="annotation-empty">在 Markdown 中选择一段文字，<br>即可添加与原文绑定的批注。</div>';
      return;
    }
    els.annotationList.innerHTML = annotations.map(function (annotation) {
      return '<article class="annotation-card" data-id="' + escapeHtml(annotation.id) + '">' +
        '<div class="annotation-quote" title="定位到原文">“' + escapeHtml(annotation.quote) + '”</div>' +
        '<div class="annotation-comment">' + escapeHtml(annotation.comment) + '</div>' +
        '<div class="annotation-card-footer"><span>' + formatDate(annotation.updatedAt || annotation.createdAt) + '</span>' +
        '<div class="annotation-card-actions"><button data-action="edit">修改</button><button data-action="delete">删除</button></div></div></article>';
    }).join('');
    Array.prototype.forEach.call(els.annotationList.querySelectorAll('.annotation-card'), function (card) {
      var id = card.getAttribute('data-id');
      card.querySelector('.annotation-quote').addEventListener('click', function () { focusAnnotation(id); });
      card.querySelector('[data-action="edit"]').addEventListener('click', function () { openEditAnnotationDialog(id); });
      card.querySelector('[data-action="delete"]').addEventListener('click', function () { deleteAnnotation(id); });
    });
  }

  function formatDate(value) {
    if (!value) return '';
    var date = new Date(value);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  function applyAllHighlights() {
    if (!state.currentPaper) return;
    state.currentPaper.review.annotations.forEach(applyOneHighlight);
  }

  function applyOneHighlight(annotation) {
    if (!annotation.quote || els.markdownContent.querySelector('mark[data-annotation-id="' + cssEscape(annotation.id) + '"]')) return;
    var textNodes = collectTextNodes();
    var full = textNodes.map(function (item) { return item.node.nodeValue; }).join('');
    var start = chooseMatch(full, annotation);
    if (start < 0) return;
    var end = start + annotation.quote.length;
    for (var i = textNodes.length - 1; i >= 0; i--) {
      var item = textNodes[i];
      var nodeStart = item.start;
      var nodeEnd = nodeStart + item.node.nodeValue.length;
      var overlapStart = Math.max(start, nodeStart);
      var overlapEnd = Math.min(end, nodeEnd);
      if (overlapStart >= overlapEnd) continue;
      var range = document.createRange();
      range.setStart(item.node, overlapStart - nodeStart);
      range.setEnd(item.node, overlapEnd - nodeStart);
      var mark = document.createElement('mark');
      mark.className = 'annotation-highlight';
      mark.setAttribute('data-annotation-id', annotation.id);
      mark.title = annotation.comment || '查看批注';
      try { range.surroundContents(mark); } catch (_) { }
    }
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('mark[data-annotation-id="' + cssEscape(annotation.id) + '"]'), function (mark) {
      mark.addEventListener('click', function () { focusAnnotation(annotation.id); });
    });
  }

  function collectTextNodes() {
    var walker = document.createTreeWalker(els.markdownContent, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent || parent.closest('script,style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var result = [], offset = 0, node;
    while ((node = walker.nextNode())) {
      result.push({ node: node, start: offset });
      offset += node.nodeValue.length;
    }
    return result;
  }

  function chooseMatch(full, annotation) {
    var positions = [], from = 0, found;
    while ((found = full.indexOf(annotation.quote, from)) >= 0 && positions.length < 100) { positions.push(found); from = found + 1; }
    if (!positions.length) return -1;
    if (positions.length === 1) return positions[0];
    var best = positions[0], bestScore = -1;
    positions.forEach(function (position) {
      var prefix = full.substring(Math.max(0, position - (annotation.prefix || '').length), position);
      var suffix = full.substring(position + annotation.quote.length, position + annotation.quote.length + (annotation.suffix || '').length);
      var score = commonEnd(prefix, annotation.prefix || '') + commonStart(suffix, annotation.suffix || '');
      if (score > bestScore) { best = position; bestScore = score; }
    });
    return best;
  }

  function commonStart(a, b) { var i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
  function commonEnd(a, b) { var i = 0; while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++; return i; }

  function focusAnnotation(id) {
    els.notesPanel.classList.remove('hidden');
    Array.prototype.forEach.call(document.querySelectorAll('.annotation-highlight,.annotation-card'), function (element) { element.classList.remove('active'); });
    var marks = els.markdownContent.querySelectorAll('mark[data-annotation-id="' + cssEscape(id) + '"]');
    var card = els.annotationList.querySelector('.annotation-card[data-id="' + cssEscape(id) + '"]');
    Array.prototype.forEach.call(marks, function (mark) { mark.classList.add('active'); });
    if (card) card.classList.add('active');
    if (marks.length) marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function openMetadataDialog() {
    if (!state.currentPaper) return;
    els.customTitle.value = state.currentPaper.review.title || '';
    state.pendingTags = (state.currentPaper.review.tags || []).slice();
    els.tagInput.value = '';
    renderTagChips();
    els.metadataDialog.showModal();
    setTimeout(function () { els.customTitle.focus(); }, 20);
  }

  function renderTagChips() {
    if (!state.pendingTags.length) {
      els.tagChips.innerHTML = '<span class="tag-empty">尚未添加标签</span>';
      renderAvailableTags();
      return;
    }
    els.tagChips.innerHTML = state.pendingTags.map(function (tag, index) {
      return '<span class="tag-chip tag-colored" style="' + tagStyle(tag) + '"><span>' + escapeHtml(tag) + '</span><button type="button" data-remove-tag="' + index + '" title="移除标签">×</button></span>';
    }).join('');
    renderAvailableTags();
  }

  function allKnownTags() {
    var tags = [];
    state.papers.forEach(function (paper) {
      (Array.isArray(paper.tags) ? paper.tags : []).forEach(function (tag) {
        tag = String(tag || '').trim();
        if (tag && !tags.some(function (item) { return item.toLocaleLowerCase() === tag.toLocaleLowerCase(); })) tags.push(tag);
      });
    });
    return tags.sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
  }

  function renderAvailableTags() {
    var known = allKnownTags();
    els.availableTags.innerHTML = known.length
      ? known.map(function (tag) {
          var selected = state.pendingTags.some(function (item) { return item.toLocaleLowerCase() === tag.toLocaleLowerCase(); });
          return '<span class="available-tag tag-colored" style="' + tagStyle(tag) + '">' +
            '<button type="button" class="tag-pick' + (selected ? ' selected' : '') + '" data-select-tag="' + escapeHtml(tag) + '"' + (selected ? ' disabled' : '') + '>' + escapeHtml(tag) + (selected ? ' ✓' : '') + '</button>' +
            '<button type="button" class="tag-delete" data-delete-tag="' + escapeHtml(tag) + '" title="从全部文章删除该标签" aria-label="删除标签 ' + escapeHtml(tag) + '">×</button>' +
            '</span>';
        }).join('')
      : '<span class="tag-empty">暂无已有标签</span>';
  }

  function deleteKnownTag(tag) {
    if (!tag || !window.confirm('确认从全部文章中删除标签“' + tag + '”？\n\n该标签会从所有文章中移除，但不会删除或移动论文文件。')) return;
    saveNow().then(function () {
      return api('/api/tags/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: tag })
      });
    }).then(function (result) {
      state.papers.forEach(function (paper) {
        paper.tags = (paper.tags || []).filter(function (item) { return item.toLocaleLowerCase() !== tag.toLocaleLowerCase(); });
      });
      state.pendingTags = state.pendingTags.filter(function (item) { return item.toLocaleLowerCase() !== tag.toLocaleLowerCase(); });
      if (state.currentPaper) {
        state.currentPaper.review.tags = (state.currentPaper.review.tags || []).filter(function (item) { return item.toLocaleLowerCase() !== tag.toLocaleLowerCase(); });
      }
      renderTagChips();
      renderTree();
      renderTagManager();
      showToast('标签已删除，已从 ' + result.affected + ' 篇文章中移除');
    }).catch(function (error) { showToast('删除标签失败：' + error.message); });
  }

  function addPendingTag() {
    var tag = els.tagInput.value.trim();
    if (!tag) return;
    if (state.pendingTags.some(function (item) { return item.toLocaleLowerCase() === tag.toLocaleLowerCase(); })) {
      showToast('该标签已经添加');
      return;
    }
    state.pendingTags.push(tag);
    els.tagInput.value = '';
    renderTagChips();
    els.tagInput.focus();
  }

  function tagInventory() {
    var inventory = {};
    state.papers.forEach(function (paper) {
      (paper.tags || []).forEach(function (rawTag) {
        var tag = String(rawTag || '').trim();
        var key = tag.toLocaleLowerCase();
        if (!tag) return;
        if (!inventory[key]) inventory[key] = { name: tag, count: 0 };
        inventory[key].count += 1;
      });
    });
    return Object.keys(inventory).map(function (key) { return inventory[key]; }).sort(function (a, b) {
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  function openTagManager() {
    els.tagManagerSearch.value = '';
    renderTagManager();
    els.tagManagerDialog.showModal();
    setTimeout(function () { els.tagManagerSearch.focus(); }, 20);
  }

  function renderTagManager() {
    if (!els.tagManagerList) return;
    var all = tagInventory();
    var query = String(els.tagManagerSearch.value || '').trim().toLocaleLowerCase();
    var tags = all.filter(function (item) { return !query || item.name.toLocaleLowerCase().indexOf(query) >= 0; });
    els.tagManagerSummary.textContent = all.length + ' 个标签';
    els.tagManagerList.innerHTML = tags.length ? tags.map(function (item) {
      return '<div class="tag-manager-row tag-colored" style="' + tagStyle(item.name) + '">' +
        '<span class="tag-color-dot"></span><span class="tag-manager-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>' +
        '<span class="tag-manager-count">' + item.count + ' 篇</span>' +
        '<button type="button" class="tag-manager-action" data-tag-action="rename" data-tag="' + escapeHtml(item.name) + '">重命名</button>' +
        '<button type="button" class="tag-manager-action" data-tag-action="merge" data-tag="' + escapeHtml(item.name) + '">合并</button>' +
        '<button type="button" class="tag-manager-action danger" data-tag-action="delete" data-tag="' + escapeHtml(item.name) + '">删除</button></div>';
    }).join('') : '<div class="tag-manager-empty">' + (all.length ? '没有匹配的标签' : '还没有标签') + '</div>';
  }

  function openTagAction(mode, source) {
    state.tagAction = { mode: mode, source: source };
    els.tagActionTitle.textContent = mode === 'merge' ? '合并标签' : '重命名标签';
    els.tagActionDescription.textContent = mode === 'merge'
      ? '把“' + source + '”合并到另一个已有或新标签；所有相关文章会一起更新。'
      : '将“' + source + '”改成新名称；如果新名称已经存在，将自动合并。';
    els.tagActionInput.value = mode === 'rename' ? source : '';
    els.tagSuggestions.innerHTML = allKnownTags().filter(function (tag) {
      return tag.toLocaleLowerCase() !== source.toLocaleLowerCase();
    }).map(function (tag) { return '<option value="' + escapeHtml(tag) + '"></option>'; }).join('');
    els.tagManagerDialog.close();
    els.tagActionDialog.showModal();
    setTimeout(function () { els.tagActionInput.focus(); els.tagActionInput.select(); }, 20);
  }

  function replaceTag(tags, source, target) {
    var result = [];
    (tags || []).forEach(function (tag) {
      var value = String(tag).toLocaleLowerCase() === source.toLocaleLowerCase() ? target : String(tag);
      if (!result.some(function (item) { return item.toLocaleLowerCase() === value.toLocaleLowerCase(); })) result.push(value);
    });
    return result;
  }

  function applyTagAction(event) {
    event.preventDefault();
    if (!state.tagAction) return;
    var action = state.tagAction;
    var target = els.tagActionInput.value.trim();
    if (!target) { showToast('请输入目标标签'); els.tagActionInput.focus(); return; }
    if (target === action.source) { showToast('标签名称没有变化'); return; }
    els.confirmTagAction.disabled = true;
    saveNow().then(function () {
      return api('/api/tags/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: action.source, target: target })
      });
    }).then(function (result) {
      state.papers.forEach(function (paper) { paper.tags = replaceTag(paper.tags, action.source, target); });
      state.pendingTags = replaceTag(state.pendingTags, action.source, target);
      if (state.currentPaper) state.currentPaper.review.tags = replaceTag(state.currentPaper.review.tags, action.source, target);
      renderTagChips();
      renderTree();
      showToast((action.mode === 'merge' ? '标签已合并' : '标签已重命名') + '，更新了 ' + result.affected + ' 篇文章');
      state.tagAction = null;
      els.tagActionDialog.close();
      renderTagManager();
      els.tagManagerDialog.showModal();
    }).catch(function (error) { showToast('更新标签失败：' + error.message); })
      .then(function () { els.confirmTagAction.disabled = false; });
  }

  function updateFavoriteButton() {
    var favorite = !!(state.currentPaper && state.currentPaper.review.favorite);
    els.favoritePaper.textContent = favorite ? '★ 已收藏' : '☆ 收藏';
    els.favoritePaper.title = favorite ? '取消收藏当前论文' : '收藏当前论文';
    els.favoritePaper.classList.toggle('active', favorite);
  }

  function toggleFavorite() {
    if (!state.currentPaper) return;
    var favorite = !state.currentPaper.review.favorite;
    state.currentPaper.review.favorite = favorite;
    var paper = state.papers.filter(function (item) { return item.path === state.currentPath; })[0];
    if (paper) paper.favorite = favorite;
    updateFavoriteButton();
    renderTree();
    scheduleSave();
    showToast(favorite ? '已加入收藏' : '已取消收藏');
  }

  function saveMetadata(event) {
    event.preventDefault();
    if (!state.currentPaper) return;
    var title = els.customTitle.value.trim();
    state.currentPaper.review.title = title;
    state.currentPaper.review.tags = state.pendingTags.slice();
    var paper = state.papers.filter(function (item) { return item.path === state.currentPath; })[0];
    if (paper) {
      paper.title = title;
      paper.tags = state.pendingTags.slice();
    }
    els.paperTitle.textContent = title || state.currentPaper.name;
    els.paperTitle.title = title || state.currentPaper.name;
    els.metadataDialog.close();
    renderTree();
    scheduleSave();
    showToast('标题与标签已更新');
  }

  function scheduleSave() {
    if (!state.currentPaper) return;
    state.dirty = true;
    els.saveState.textContent = '待保存';
    els.saveState.className = 'save-state saving';
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, 650);
  }

  function saveNow() {
    clearTimeout(state.saveTimer);
    if (!state.dirty || !state.currentPaper) return Promise.resolve();
    var path = state.currentPath;
    var review = state.currentPaper.review;
    state.dirty = false;
    els.saveState.textContent = '保存中';
    els.saveState.className = 'save-state saving';
    return api('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperPath: path, review: review })
    }).then(function () {
      if (state.currentPath === path) { els.saveState.textContent = '已保存'; els.saveState.className = 'save-state'; }
    }).catch(function (error) {
      if (state.currentPath === path) { state.dirty = true; els.saveState.textContent = '失败'; els.saveState.className = 'save-state error'; }
      showToast('保存失败：' + error.message);
    });
  }

  function beginDividerDrag(event) {
    if (window.innerWidth <= 760 || !state.currentPaper || event.button !== 0) return;
    event.preventDefault();
    var divider = els.readerDivider;
    var pointerId = event.pointerId;
    var finished = false;
    divider.classList.add('dragging');
    document.body.classList.add('reader-resizing');
    try { divider.setPointerCapture(pointerId); } catch (_) { }
    function move(e) {
      if (finished || e.pointerId !== pointerId) return;
      var rect = els.readingLayout.getBoundingClientRect();
      var percent = Math.max(28, Math.min(72, ((e.clientX - rect.left) / rect.width) * 100));
      state.currentPaper.review.pdfWidth = Math.round(percent * 10) / 10;
      updateReadingSplit();
    }
    function finish(e) {
      if (finished || (e.pointerId != null && e.pointerId !== pointerId)) return;
      finished = true;
      divider.removeEventListener('pointermove', move);
      divider.removeEventListener('pointerup', finish);
      divider.removeEventListener('pointercancel', finish);
      divider.removeEventListener('lostpointercapture', finish);
      try { if (divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId); } catch (_) { }
      divider.classList.remove('dragging');
      document.body.classList.remove('reader-resizing');
      scheduleSave();
    }
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', finish);
    divider.addEventListener('pointercancel', finish);
    divider.addEventListener('lostpointercapture', finish);
  }

  function applySidePanelWidths() {
    var notesDefault = window.innerWidth <= 1450 ? 300 : 330;
    var aiDefault = window.innerWidth <= 1450 ? 390 : 440;
    var notesWidth = Math.max(260, Math.min(520, Number(localStorage.getItem('ai-literature-reader.notes-width')) || notesDefault));
    var aiWidth = Math.max(340, Math.min(720, Number(localStorage.getItem('ai-literature-reader.ai-width')) || aiDefault));
    els.notesPanel.style.setProperty('--notes-width', notesWidth + 'px');
    els.aiPanel.style.setProperty('--ai-width', aiWidth + 'px');
  }

  function beginSidePanelDrag(panel, cssVariable, storageKey, minimum, maximum, event) {
    if (event.button !== 0 || panel.classList.contains('collapsed')) return;
    event.preventDefault();
    var handle = event.currentTarget;
    var pointerId = event.pointerId;
    var startX = event.clientX;
    var startWidth = panel.getBoundingClientRect().width;
    var finished = false;
    handle.classList.add('dragging');
    document.body.classList.add('side-panel-resizing');
    try { handle.setPointerCapture(pointerId); } catch (_) { }
    function move(e) {
      if (finished || e.pointerId !== pointerId) return;
      var width = Math.max(minimum, Math.min(maximum, startWidth + startX - e.clientX));
      panel.style.setProperty(cssVariable, Math.round(width) + 'px');
    }
    function finish(e) {
      if (finished || (e.pointerId != null && e.pointerId !== pointerId)) return;
      finished = true;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      try { if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId); } catch (_) { }
      handle.classList.remove('dragging');
      document.body.classList.remove('side-panel-resizing');
      localStorage.setItem(storageKey, String(Math.round(panel.getBoundingClientRect().width)));
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
  }

  els.chooseRoot.addEventListener('click', function () {
    els.chooseRoot.disabled = true;
    api('/api/select-root').then(function (result) {
      if (result.selected) { clearPaper(); return loadTree(false); }
    }).catch(function (error) { showToast('选择文件夹失败：' + error.message); })
      .then(function () { els.chooseRoot.disabled = false; });
  });
  els.refreshTree.addEventListener('click', function () { loadTree(true); });
  els.manageTags.addEventListener('click', openTagManager);
  els.libraryScope.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-scope]');
    if (!button) return;
    state.scope = button.getAttribute('data-scope');
    Array.prototype.forEach.call(els.libraryScope.querySelectorAll('button'), function (item) { item.classList.toggle('active', item === button); });
    renderTree();
  });
  els.treeSearch.addEventListener('input', function () { state.query = els.treeSearch.value; renderTree(); });
  els.treeMode.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-mode]');
    if (!button) return;
    state.viewMode = button.getAttribute('data-mode') === 'tags' ? 'tags' : 'files';
    Array.prototype.forEach.call(els.treeMode.querySelectorAll('button'), function (item) { item.classList.toggle('active', item === button); });
    els.treeSearch.placeholder = state.viewMode === 'tags' ? '搜索标题、标签或文件名' : '筛选论文名称';
    renderTree();
  });
  els.statusFilters.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-filter]'); if (!button) return;
    state.filter = button.getAttribute('data-filter');
    Array.prototype.forEach.call(els.statusFilters.querySelectorAll('button'), function (item) { item.classList.toggle('active', item === button); });
    renderTree();
  });
  Array.prototype.forEach.call(document.querySelectorAll('.reading-status button'), function (button) {
    button.addEventListener('click', function () { setStatus(button.getAttribute('data-status')); });
  });
  els.markdownContent.addEventListener('mouseup', function () { setTimeout(captureSelection, 0); });
  els.markdownContent.addEventListener('click', function (event) {
    var image = event.target.closest && event.target.closest('img');
    if (image && els.markdownContent.contains(image)) selectMarkdownImage(image);
  });
  els.sendSelectionToAi.addEventListener('click', sendSelectionToAi);
  els.annotateSelection.addEventListener('click', openNewAnnotationDialog);
  els.confirmAnnotation.addEventListener('click', confirmAnnotation);
  els.editMetadata.addEventListener('click', openMetadataDialog);
  els.addTag.addEventListener('click', addPendingTag);
  els.tagInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); addPendingTag(); }
  });
  els.tagChips.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-remove-tag]');
    if (!button) return;
    state.pendingTags.splice(Number(button.getAttribute('data-remove-tag')), 1);
    renderTagChips();
  });
  els.availableTags.addEventListener('click', function (event) {
    var deleteButton = event.target.closest('button[data-delete-tag]');
    if (deleteButton) { deleteKnownTag(deleteButton.getAttribute('data-delete-tag')); return; }
    var button = event.target.closest('button[data-select-tag]');
    if (!button) return;
    state.pendingTags.push(button.getAttribute('data-select-tag'));
    renderTagChips();
  });
  els.saveMetadata.addEventListener('click', saveMetadata);
  els.favoritePaper.addEventListener('click', toggleFavorite);
  els.tagManagerSearch.addEventListener('input', renderTagManager);
  els.tagManagerList.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-tag-action]');
    if (!button) return;
    var action = button.getAttribute('data-tag-action');
    var tag = button.getAttribute('data-tag');
    if (action === 'delete') { deleteKnownTag(tag); return; }
    openTagAction(action, tag);
  });
  els.confirmTagAction.addEventListener('click', applyTagAction);
  els.tagActionDialog.addEventListener('close', function () {
    if (!state.tagAction) return;
    state.tagAction = null;
    renderTagManager();
    if (!els.tagManagerDialog.open) els.tagManagerDialog.showModal();
  });
  els.toggleNotes.addEventListener('click', function () { els.notesPanel.classList.toggle('hidden'); });
  els.closeNotes.addEventListener('click', function () { els.notesPanel.classList.add('hidden'); });
  els.togglePdf.addEventListener('click', function () { setPdfCollapsed(!els.readingLayout.classList.contains('pdf-collapsed')); });
  els.collapsePdf.addEventListener('click', function () { setPdfCollapsed(true); });
  els.pdfRail.addEventListener('click', function () { setPdfCollapsed(false); });
  els.collapseAi.addEventListener('click', function () { els.aiPanel.classList.add('collapsed'); localStorage.setItem('ai-literature-reader.ai-collapsed', 'true'); });
  els.aiRail.addEventListener('click', function () { els.aiPanel.classList.remove('collapsed'); localStorage.setItem('ai-literature-reader.ai-collapsed', 'false'); window.AILiteratureChat.focus(); });
  els.paperNote.addEventListener('input', function () { if (state.currentPaper) { state.currentPaper.review.note = els.paperNote.value; scheduleSave(); } });
  els.markdownContent.addEventListener('scroll', function () {
    if (!state.currentPaper) return;
    state.currentPaper.review.markdownScroll = els.markdownContent.scrollTop;
    clearTimeout(els.markdownContent._scrollTimer);
    els.markdownContent._scrollTimer = setTimeout(scheduleSave, 800);
  });
  els.readerDivider.addEventListener('pointerdown', beginDividerDrag);
  els.notesResizer.addEventListener('pointerdown', function (event) { beginSidePanelDrag(els.notesPanel, '--notes-width', 'ai-literature-reader.notes-width', 260, 520, event); });
  els.aiResizer.addEventListener('pointerdown', function (event) { beginSidePanelDrag(els.aiPanel, '--ai-width', 'ai-literature-reader.ai-width', 340, 720, event); });
  window.addEventListener('beforeunload', function () { if (state.dirty) saveNow(); });
  window.addEventListener('pagehide', function () { navigator.sendBeacon('/close', ''); });
  function heartbeat() { fetch('/heartbeat', { method: 'POST', cache: 'no-store' }).catch(function () {}); }
  heartbeat(); setInterval(heartbeat, 4000);
  applySidePanelWidths();
  if (localStorage.getItem('ai-literature-reader.ai-collapsed') === 'true') els.aiPanel.classList.add('collapsed');
  window.AILiteratureChat.mount(els.aiChatRoot).catch(function (error) { showToast('Codex 连接失败：' + error.message); });
  loadTree(false);
})();
