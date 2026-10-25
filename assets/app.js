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
    annotationDraft: null,
    annotationDrafts: Object.create(null),
    dirty: false,
    saveTimer: null,
    loadToken: 0,
    filter: 'all',
    scope: 'all',
    query: '',
    viewMode: 'files',
    pendingTags: [],
    tagAction: null,
    translating: false,
    translationClient: null,
    notesExpanded: false,
    notesLayoutAuto: null,
    attachments: [], availablePapers: [], duplicates: [], expandedPapers: {}, activeAttachment: null, libraryRevision: 0
  };

  var els = {};
  ['libraryPath','chooseRoot','importPdfs','importPdfFiles','refreshTree','paperCount','manageTags','showDuplicates','duplicateCount','libraryScope','treeMode','treeSearch','statusFilters','fileTree','headerPaperActions','toggleExplorer','collapseExplorer','explorerRail','appShell','explorerPanel',
   'emptyState','paperView','paperTitle','paperMeta','paperLocation','manageAttachments','pdfName','pdfFrame','markdownPane','attachmentViewer','attachmentViewerTitle','attachmentOpenFolder','attachmentFullscreen','attachmentVideoList','attachmentVideo','attachmentPdf',
   'markdownContent','markdownImageTools','selectedImageName','addImageToNote','clearSelectedImage','readingLayout','readerDivider','togglePdf','collapsePdf','pdfRail','toggleMarkdown','collapseMarkdown','markdownRail','sendSelectionToAi','translateSelection','annotateSelection','toggleNotes','toggleAi','saveState',
   'notesPanel','notesLayoutSwitch','closeNotes','notesRail','annotationCount','paperNote','expandPaperNote','annotationListHeading','annotationList','annotationEditor',
   'annotationEditorTitle','annotationDraftStatus','closeAnnotationEditor','cancelAnnotationEditor','locateAnnotationDraft','selectedQuote','annotationText','confirmAnnotation','metadataDialog','editMetadata','customTitle','tagChips','availableTags','tagInput','addTag','saveMetadata','tagManagerDialog','tagManagerSummary','tagManagerSearch','tagManagerList','tagActionDialog','tagActionTitle','tagActionDescription','tagActionInput','tagSuggestions','confirmTagAction','favoritePaper','toast','aiPanel','aiRail','collapseAi','aiChatRoot','notesResizer','aiResizer','attachmentDialog','closeAttachmentDialog','attachmentAnchorHint','addAttachmentFile','linkParsedPaper','attachmentPaperPicker','attachmentPaperChoice','confirmParsedLink','attachmentList','duplicateDialog','closeDuplicateDialog','duplicateList'].forEach(function (id) {
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
      state.attachments = data.attachments || [];
      state.availablePapers = data.availablePapers || [];
      state.duplicates = data.duplicates || [];
      state.libraryRevision = data.revision || 0;
      state.papers = [];
      collectPapers(data.tree, state.papers);
      els.libraryPath.textContent = data.libraryRoot;
      els.libraryPath.title = data.libraryRoot;
      els.paperCount.textContent = state.papers.length;
      els.duplicateCount.textContent = state.duplicates.length;
      els.showDuplicates.classList.toggle('hidden', !state.duplicates.length);
      renderTree();
      if (keepSelection && state.currentPath && !state.availablePapers.some(function (p) { return p.path === state.currentPath; })) clearPaper();
      var refreshed = state.availablePapers.filter(function (p) { return p.path === state.currentPath; })[0];
      if (keepSelection && refreshed && state.currentPaper && refreshed.hasMarkdown !== state.currentPaper.hasMarkdown) {
        var reopenPath = state.currentPath;
        return Promise.resolve(state.dirty ? saveNow() : null).then(function () {
          if (state.dirty) return;
          clearPaper();
          openPaper(reopenPath);
        });
      }
    }).catch(function (error) {
      els.fileTree.innerHTML = '<div class="tree-empty">扫描失败：' + escapeHtml(error.message) + '</div>';
      showToast('论文库扫描失败');
    }).then(function () { els.refreshTree.disabled = false; });
  }

  function renderTree() {
    var query = state.query.trim();
    var filtered = state.papers.filter(function (paper) {
      return (state.filter === 'all' || paper.status === state.filter) &&
        (state.scope !== 'favorites' || paper.favorite) &&
        (state.scope !== 'recent' || paper.lastOpenedAt);
    });
    if (query) {
      filtered = filtered.map(function (paper) { return { paper: paper, score: paperSearchScore(paper, query) }; })
        .filter(function (item) { return item.score !== null; })
        .sort(function (a, b) { return a.score - b.score || String(a.paper.parsedTitle || a.paper.name).localeCompare(String(b.paper.parsedTitle || b.paper.name), 'zh-CN'); })
        .map(function (item) { return item.paper; });
    }
    if (!filtered.length) {
      els.fileTree.innerHTML = '<div class="tree-empty">没有符合当前条件的论文。</div>';
      return;
    }
    if (state.scope === 'added') {
      filtered.sort(function (a, b) { return String(b.addedAt || '').localeCompare(String(a.addedAt || '')) || String(a.path).localeCompare(String(b.path), 'zh-CN'); });
      els.fileTree.innerHTML = filtered.map(function (paper) { return paperRow(paper, 0, paper.title || paper.parsedTitle || paper.name, true, true); }).join('');
    } else if (query) {
      els.fileTree.innerHTML = filtered.map(function (paper) { return paperRow(paper, 0, paper.title || paper.parsedTitle || paper.name, true); }).join('');
    } else if (state.scope === 'recent') {
      filtered.sort(function (a, b) { return String(b.lastOpenedAt || '').localeCompare(String(a.lastOpenedAt || '')); });
      els.fileTree.innerHTML = filtered.map(function (paper) { return paperRow(paper, 0, paper.title || paper.name); }).join('');
    } else if (state.viewMode === 'tags') {
      els.fileTree.innerHTML = renderTagTree(filtered);
    } else if (state.filter !== 'all' || state.scope !== 'all') {
      els.fileTree.innerHTML = filtered.map(function (paper) { return paperRow(paper, 0, paper.name); }).join('');
    } else {
      els.fileTree.innerHTML = renderTreeNode(state.tree, 0, true);
    }
    bindTreeEvents();
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

  function fieldSearchScore(value, query) {
    var normalized = normalizeSearch(value), compact = compactSearch(value);
    if (!compact) return null;
    var whole = compactSearch(query);
    if (whole && compact.indexOf(whole) >= 0) return compact.indexOf(whole) === 0 ? 0 : 1;
    var terms = normalizeSearch(query).split(/[\p{P}\p{S}\s]+/u).filter(Boolean);
    if (!terms.length) return null;
    var words = normalized.match(/[a-z0-9]+/g) || [];
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

  function paperSearchScore(paper, query) {
    var fields = [paper.title, paper.parsedTitle, paper.name, paper.path];
    if (state.viewMode === 'tags') fields = fields.concat(Array.isArray(paper.tags) ? paper.tags : []);
    var best = null;
    fields.forEach(function (field, index) {
      var score = fieldSearchScore(field, query);
      if (score !== null) best = best === null ? index * 10 + score : Math.min(best, index * 10 + score);
    });
    return best;
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

  function paperRow(paper, depth, label, searchResult, addedResult) {
    var active = paper.path === state.currentPath ? ' active' : '';
    var attachments = state.attachments.filter(function (item) { return item.parent === paper.path; });
    var expanded = !!state.expandedPapers[paper.path];
    var addedDate = new Date(paper.addedAt);
    var addedLabel = addedResult && !isNaN(addedDate.getTime()) ? (paper.addedTimeEstimated ? '约 ' : '') + addedDate.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) + ' 加入' : '';
    return '<div class="tree-row paper' + active + (attachments.length ? ' has-attachments' : '') + (searchResult ? ' search-result' : '') + '" data-paper="' + escapeHtml(paper.path) + '" style="padding-left:' + (8 + depth * 14) + 'px" title="' + escapeHtml(paper.path + (addedResult ? '\n' + (paper.addedTimeEstimated ? '入库时间估计：' : '入库时间：') + new Date(paper.addedAt).toLocaleString('zh-CN') : '')) + '">' +
      '<span class="tree-arrow">' + (attachments.length ? (expanded ? '▼' : '▶') : '') + '</span><span class="tree-icon">▤</span><span class="tree-label">' + (searchResult ? '<strong>' + escapeHtml(label || paper.name) + '</strong><small>' + escapeHtml((addedLabel ? addedLabel + ' · ' : '') + paper.path) + '</small>' : escapeHtml(label || paper.name)) + '</span>' +
      (paper.favorite ? '<span class="favorite-marker" title="已收藏">★</span>' : '') +
      '<span class="status-dot ' + escapeHtml(paper.status || 'unread') + '" title="' + statusLabel(paper.status) + '"></span></div>' +
      (attachments.length ? '<div class="tree-attachment-children' + (expanded ? '' : ' collapsed') + '">' + attachments.map(function (link) {
        return '<div class="tree-row attachment' + (state.activeAttachment === link.id || (link.kind === 'parsed' && state.currentPath === link.path) ? ' active' : '') + '" data-attachment="' + escapeHtml(link.id) + '" title="' + escapeHtml((/\.(mp4|webm|ogg|ogv|m4v)$/i.test(link.name) ? '视频附件，点击播放：' : '附件：') + link.name) + '"><span class="tree-arrow"></span><span class="tree-icon">' + attachmentIcon(link) + '</span><span class="tree-label">' + escapeHtml(link.name) + '</span></div>';
      }).join('') + '</div>' : '');
  }

  function attachmentIcon(link) {
    if (link.kind === 'parsed') return '▤';
    if (/\.pdf$/i.test(link.name)) return '▣';
    if (/\.(mp4|webm|ogg|ogv|m4v)$/i.test(link.name)) return '🎞';
    if (/\.zip$/i.test(link.name)) return '▧';
    return '◇';
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
      row.addEventListener('click', function (event) {
        var path = row.getAttribute('data-paper');
        if (event.target.classList.contains('tree-arrow') && row.classList.contains('has-attachments')) {
          state.expandedPapers[path] = !state.expandedPapers[path]; renderTree(); return;
        }
        openPaper(path);
      });
    });
    Array.prototype.forEach.call(els.fileTree.querySelectorAll('.tree-row.attachment'), function (row) {
      row.addEventListener('click', function () { openAttachment(row.getAttribute('data-attachment')); });
    });
    Array.prototype.forEach.call(els.fileTree.querySelectorAll('.tree-row.folder'), function (row) {
      row.addEventListener('click', function () {
        var children = row.nextElementSibling;
        children.classList.toggle('collapsed');
        row.querySelector('.tree-arrow').textContent = children.classList.contains('collapsed') ? '▶' : '▼';
      });
    });
  }

  function attachmentById(id) { return state.attachments.filter(function (item) { return item.id === id; })[0] || null; }
  function closeAttachmentViewer() {
    var wasZip = state.activeAttachment && /\.zip$/i.test((attachmentById(state.activeAttachment) || {}).name || '');
    els.attachmentVideo.pause();
    els.attachmentVideo.removeAttribute('src');
    els.attachmentVideo.load();
    els.attachmentPdf.removeAttribute('src');
    els.attachmentViewer.classList.add('hidden');
    els.appShell.classList.remove('attachment-view-mode');
    state.activeAttachment = null;
    if (wasZip) fetch('/api/attachments/cache/clear', { method: 'POST' }).catch(function () {});
    if (state.currentPaper) { els.paperView.classList.remove('hidden'); els.headerPaperActions.classList.remove('hidden'); }
  }

  function showAttachmentViewer(link, mode) {
    closeAttachmentViewer();
    state.activeAttachment = link.id;
    els.paperView.classList.add('hidden');
    els.emptyState.classList.add('hidden');
    els.headerPaperActions.classList.add('hidden');
    els.attachmentViewer.classList.remove('hidden');
    els.appShell.classList.toggle('attachment-view-mode', mode === 'video');
    els.attachmentViewerTitle.textContent = link.name;
    els.attachmentVideoList.classList.add('hidden');
    els.attachmentVideoList.innerHTML = '';
    els.attachmentVideo.classList.add('hidden');
    els.attachmentPdf.classList.add('hidden');
    els.attachmentFullscreen.classList.toggle('hidden', mode !== 'video');
    renderTree();
  }

  function openAttachment(id) {
    var link = attachmentById(id);
    if (!link) return;
    if (link.kind === 'parsed') { closeAttachmentViewer(); openPaper(link.path); return; }
    if (/\.pdf$/i.test(link.name)) {
      showAttachmentViewer(link, 'pdf');
      els.attachmentPdf.src = '/content/attachment?id=' + encodeURIComponent(link.id);
    } else if (/\.(mp4|webm|ogg|ogv|m4v)$/i.test(link.name)) {
      showAttachmentViewer(link, 'video');
      els.attachmentVideo.classList.remove('hidden');
      els.attachmentVideo.src = '/content/attachment?id=' + encodeURIComponent(link.id);
      els.attachmentVideo.load();
    } else if (/\.zip$/i.test(link.name)) {
      api('/api/attachments/zip-videos?id=' + encodeURIComponent(link.id)).then(function (result) {
        if (!result.videos || !result.videos.length) return openAttachmentFolder(link.id);
        showAttachmentViewer(link, 'video');
        els.attachmentVideoList.classList.remove('hidden');
        els.attachmentVideoList.innerHTML = result.videos.map(function (item, index) {
          return '<button type="button" data-entry="' + index + '">' + escapeHtml(item.name) + '</button>';
        }).join('');
        Array.prototype.forEach.call(els.attachmentVideoList.querySelectorAll('button'), function (button) {
          button.addEventListener('click', function () {
            var video = result.videos[Number(button.getAttribute('data-entry'))];
            els.attachmentVideo.classList.remove('hidden');
            els.attachmentVideo.src = '/content/attachment?id=' + encodeURIComponent(link.id) + '&entry=' + encodeURIComponent(video.name);
            els.attachmentVideo.load();
            els.attachmentVideo.play().catch(function () {});
          });
        });
      }).catch(function (error) { showToast('读取 ZIP 失败：' + error.message); });
    } else openAttachmentFolder(link.id);
  }

  function openAttachmentFolder(id) {
    return api('/api/attachments/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
      .catch(function (error) { showToast('打开文件夹失败：' + error.message); });
  }

  function anchorForAttachment() {
    var selected = state.selectedText;
    return state.attachmentParent === state.currentPath && selected && selected.quote
      ? { quote: selected.quote, prefix: selected.prefix || '', suffix: selected.suffix || '' } : {};
  }

  function openAttachmentDialog() {
    if (!state.currentPath) return;
    var paper = state.attachments.filter(function (item) { return item.kind === 'parsed' && item.path === state.currentPath; })[0];
    state.attachmentParent = paper ? paper.parent : state.currentPath;
    var selection = anchorForAttachment();
    els.attachmentAnchorHint.textContent = selection.quote ? '当前选区可同时关联到新附件：' + selection.quote.slice(0, 75)
      : state.currentPaper && !state.currentPaper.hasMarkdown ? '当前只有 PDF，新附件将关联整篇论文。'
      : '附件默认关联整篇论文；如需关联正文段落，可在正文中选中文字后打开此窗口。';
    els.attachmentPaperPicker.classList.add('hidden');
    renderAttachmentList();
    els.attachmentDialog.showModal();
  }

  function renderAttachmentList() {
    var links = state.attachments.filter(function (item) { return item.parent === state.attachmentParent; });
    els.attachmentList.innerHTML = links.length ? links.map(function (link) {
      return '<div class="attachment-list-row"><span>' + attachmentIcon(link) + ' ' + escapeHtml(link.name) + '</span>' +
        (link.quote ? '<small title="' + escapeHtml(link.quote) + '">正文链接</small>' : '') +
        '<button class="button secondary" type="button" data-open="' + escapeHtml(link.id) + '">打开</button>' +
        '<button class="button secondary" type="button" data-remove="' + escapeHtml(link.id) + '">解除关联</button></div>';
    }).join('') : '<p class="attachment-hint">这篇论文尚无附件。</p>';
    Array.prototype.forEach.call(els.attachmentList.querySelectorAll('[data-open]'), function (button) {
      button.addEventListener('click', function () { els.attachmentDialog.close(); openAttachment(button.getAttribute('data-open')); });
    });
    Array.prototype.forEach.call(els.attachmentList.querySelectorAll('[data-remove]'), function (button) {
      button.addEventListener('click', function () {
        var id = button.getAttribute('data-remove');
        var link = attachmentById(id);
        if (!window.confirm(link && link.kind === 'file' ? '删除这项附件及阅读器保存的副本？原始来源文件不受影响。' : '解除这篇已解析材料的关联？磁盘上的论文文件不受影响。')) return;
        api('/api/attachments/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
          .then(function () { return loadTree(true); }).then(renderAttachmentList)
          .catch(function (error) { showToast(error.message); });
      });
    });
  }

  function renderDuplicateList() {
    els.duplicateList.innerHTML = state.duplicates.length ? state.duplicates.map(function (group, groupIndex) {
      var papers = group.papers || [];
      var sorted = papers.slice().sort(function (a, b) {
        return (Number(b.annotations || 0) * 100 + Number(b.note) * 20 + Number(b.chat) * 10 + Number(b.attachments) * 5) -
          (Number(a.annotations || 0) * 100 + Number(a.note) * 20 + Number(a.chat) * 10 + Number(a.attachments) * 5);
      });
      var keep = sorted[0];
      return '<div class="duplicate-group"><strong>建议保留：' + escapeHtml(keep.name) + '</strong><p class="attachment-hint">' + escapeHtml(keep.path) + '</p>' + papers.map(function (paper) {
        return '<div class="duplicate-paper"><span title="' + escapeHtml(paper.path) + '">' + escapeHtml(paper.path) + '</span><small>批注 ' + paper.annotations + ' · 笔记 ' + (paper.note ? '有' : '无') + ' · AI 对话 ' + (paper.chat ? '有' : '无') + ' · 附件 ' + paper.attachments + '</small>' +
          (paper.path === keep.path ? '<small>保留</small>' :
            (paper.attachments ? '<button class="button secondary" type="button" data-group="' + groupIndex + '" data-transfer="' + escapeHtml(paper.path) + '" data-keep="' + escapeHtml(keep.path) + '">转移附件</button>' : '') +
            '<button class="button secondary" type="button" data-group="' + groupIndex + '" data-recycle="' + escapeHtml(paper.path) + '" data-keep="' + escapeHtml(keep.path) + '">移至回收站</button>') + '</div>';
      }).join('') + '</div>';
    }).join('') : '<p class="attachment-hint">没有发现 PDF 内容完全相同的论文。</p>';
    Array.prototype.forEach.call(els.duplicateList.querySelectorAll('[data-recycle]'), function (button) {
      button.addEventListener('click', function () {
        var group = state.duplicates[Number(button.getAttribute('data-group'))];
        openPaperRecycle(button.getAttribute('data-recycle'), { keep: button.getAttribute('data-keep'), hash: group.hash });
      });
    });
    Array.prototype.forEach.call(els.duplicateList.querySelectorAll('[data-transfer]'), function (button) {
      button.addEventListener('click', function () {
        var group = state.duplicates[Number(button.getAttribute('data-group'))];
        var remove = button.getAttribute('data-transfer'), keep = button.getAttribute('data-keep');
        if (!window.confirm('把“' + remove + '”关联的附件转给“' + keep + '”？附件文件不会复制或删除。')) return;
        api('/api/duplicates/transfer-attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: remove, keep: keep, hash: group.hash }) })
          .then(function () { return loadTree(true); }).then(renderDuplicateList)
          .catch(function (error) { showToast('转移失败：' + error.message); });
      });
    });
  }

  function clearPaper() {
    closeAttachmentViewer();
    suspendAnnotationEditor();
    state.annotationDrafts = Object.create(null);
    if (state.notesExpanded) setNotesExpanded(false);
    window.LiteraturePaperNotes.setPaper(null);
    state.currentPath = null;
    state.currentPaper = null;
    clearMarkdownImageSelection();
    state.markdownSource = '';
    state.selectedImage = null;
    state.selectedText = null;
    els.paperView.classList.add('hidden');
    els.emptyState.classList.remove('hidden');
    els.headerPaperActions.classList.add('hidden');
    els.pdfFrame.removeAttribute('src');
    renderTree();
  }

  function openPaper(path) {
    if (!path) return;
    if (path === state.currentPath && !els.paperView.classList.contains('hidden')) return;
    closeAttachmentViewer();
    var token = ++state.loadToken;
    suspendAnnotationEditor();
    window.LiteraturePaperNotes.setPaper(null);
    clearMarkdownImageSelection();
    Promise.resolve(state.dirty ? saveNow() : null).then(function () {
      state.currentPath = path;
      state.selectedText = null;
      state.selectedImage = null;
      els.annotateSelection.disabled = true;
      els.translateSelection.disabled = true;
      els.sendSelectionToAi.disabled = true;
      renderTree();
      els.emptyState.classList.add('hidden');
      els.paperView.classList.remove('hidden');
      els.headerPaperActions.classList.remove('hidden');
      els.paperTitle.textContent = '正在加载…';
      els.paperMeta.textContent = path;
      els.markdownContent.innerHTML = '<p class="loading-text">正在加载论文…</p>';
      return api('/api/paper?path=' + encodeURIComponent(path)).then(function (paper) {
        if (!paper.hasMarkdown) return [paper, ''];
        return api('/content/markdown?paper=' + encodeURIComponent(path)).then(function (markdown) { return [paper, markdown]; });
      });
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
      window.LiteraturePaperNotes.setPaper(state.currentPaper);
      updateStatusButtons();
      updateFavoriteButton();
      renderTree();
      els.pdfFrame.removeAttribute('src');
      updatePaneVisibility();
      renderAnnotations();
      window.AILiteratureChat.setPaper(state.currentPaper).catch(function (error) {
        showToast('AI 工作区切换失败：' + error.message);
      });
      if (!state.currentPaper.hasMarkdown) {
        els.markdownContent.innerHTML = '';
        return;
      }
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
    review.markdownCollapsed = review.markdownCollapsed === true;
    if (review.markdownCollapsed) review.pdfCollapsed = false;
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
      applyAttachmentAnchors();
    });
  }

  function rewriteLocalAssets() {
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img'), function (image) {
      var source = image.getAttribute('src') || '';
      if (!/^(data:|blob:|https?:|\/)/i.test(source)) {
        image.setAttribute('data-paper-file', source);
        image.src = '/content/asset?paper=' + encodeURIComponent(state.currentPath) + '&file=' + encodeURIComponent(source);
      }
      image.title = image.getAttribute('data-paper-file') ? '单击选择图片，可加入笔记或发送给 AI' : (image.title || '图片');
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
    els.readingLayout.style.setProperty('--pdf-width', state.currentPaper.review.pdfWidth + '%');
  }

  function updatePaneVisibility() {
    if (!state.currentPaper) return;
    var review = state.currentPaper.review;
    var pdfOnly = !state.currentPaper.hasMarkdown;
    var pdfCollapsed = pdfOnly ? false : review.pdfCollapsed;
    var markdownCollapsed = pdfOnly ? true : review.markdownCollapsed;
    els.readingLayout.classList.toggle('pdf-only', pdfOnly);
    els.readingLayout.classList.toggle('pdf-collapsed', pdfCollapsed);
    els.readingLayout.classList.toggle('markdown-collapsed', markdownCollapsed);
    els.togglePdf.classList.toggle('hidden', pdfOnly);
    els.toggleMarkdown.classList.toggle('hidden', pdfOnly);
    els.togglePdf.setAttribute('aria-pressed', String(!pdfCollapsed));
    els.togglePdf.textContent = pdfCollapsed ? '展开 PDF' : '收起 PDF';
    els.togglePdf.title = els.togglePdf.textContent;
    els.toggleMarkdown.setAttribute('aria-pressed', String(!markdownCollapsed));
    els.toggleMarkdown.textContent = markdownCollapsed ? '展开 Markdown' : '收起 Markdown';
    els.toggleMarkdown.title = els.toggleMarkdown.textContent;
    if (!pdfCollapsed && !els.pdfFrame.getAttribute('src'))
      els.pdfFrame.src = '/content/pdf?paper=' + encodeURIComponent(state.currentPath);
    updateReadingSplit();
  }

  function setPdfCollapsed(collapsed, save) {
    if (!state.currentPaper || !state.currentPaper.hasMarkdown) return;
    state.currentPaper.review.pdfCollapsed = !!collapsed;
    if (collapsed) state.currentPaper.review.markdownCollapsed = false;
    updatePaneVisibility();
    if (save !== false) scheduleSave();
  }

  function setMarkdownCollapsed(collapsed, save) {
    if (!state.currentPaper || !state.currentPaper.hasMarkdown) return;
    state.currentPaper.review.markdownCollapsed = !!collapsed;
    if (collapsed) {
      state.currentPaper.review.pdfCollapsed = false;
      state.selectedText = null;
      state.selectedImage = null;
      updateImageNoteTools();
      window.getSelection().removeAllRanges();
      els.annotateSelection.disabled = true;
      els.translateSelection.disabled = true;
      els.sendSelectionToAi.disabled = true;
      els.sendSelectionToAi.textContent = '发给 AI';
      Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img.ai-image-selected'), function (image) { image.classList.remove('ai-image-selected'); });
    }
    updatePaneVisibility();
    if (save !== false) scheduleSave();
  }

  function setExplorerCollapsed(collapsed, temporary) {
    if (!temporary && state.notesLayoutAuto) state.notesLayoutAuto.explorer = false;
    els.appShell.classList.toggle('explorer-collapsed', !!collapsed);
    els.explorerPanel.classList.toggle('collapsed', !!collapsed);
    els.toggleExplorer.setAttribute('aria-pressed', String(!collapsed));
    els.toggleExplorer.textContent = collapsed ? '展开目录' : '收起目录';
    els.toggleExplorer.title = els.toggleExplorer.textContent;
    els.toggleExplorer.setAttribute('aria-label', els.toggleExplorer.title);
    if (!temporary) localStorage.setItem('ai-literature-reader.explorer-collapsed', String(!!collapsed));
    if (state.notesExpanded) fitNotesWidth();
  }

  function setNotesCollapsed(collapsed) {
    if (collapsed && state.notesExpanded) setNotesExpanded(false);
    els.notesPanel.classList.toggle('collapsed', !!collapsed);
    els.toggleNotes.setAttribute('aria-pressed', String(!collapsed));
    els.toggleNotes.textContent = collapsed ? '展开批注栏' : '收起批注栏';
    els.toggleNotes.title = els.toggleNotes.textContent;
    localStorage.setItem('ai-literature-reader.notes-collapsed', String(!!collapsed));
  }

  function setNotesLayout(layout, remember) {
    if (['balanced', 'notes', 'annotations'].indexOf(layout) < 0) layout = 'balanced';
    els.notesPanel.dataset.noteLayout = layout;
    els.notesLayoutSwitch.querySelectorAll('button').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.notesLayout === layout));
    });
    if (remember !== false) {
      try { localStorage.setItem('ai-literature-reader.notes-layout', layout); } catch (_) {}
    }
  }

  function setAiCollapsed(collapsed, focus, temporary) {
    if (!temporary && state.notesLayoutAuto) state.notesLayoutAuto.ai = false;
    els.aiPanel.classList.toggle('collapsed', !!collapsed);
    els.toggleAi.setAttribute('aria-pressed', String(!collapsed));
    els.toggleAi.textContent = collapsed ? '展开 AI' : '收起 AI';
    els.toggleAi.title = els.toggleAi.textContent;
    if (!temporary) localStorage.setItem('ai-literature-reader.ai-collapsed', String(!!collapsed));
    if (state.notesExpanded) fitNotesWidth();
    if (!collapsed && focus) window.AILiteratureChat.focus();
  }

  function captureSelection() {
    if (!state.currentPaper) return;
    var selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { state.selectedText = null; els.annotateSelection.disabled = true; els.translateSelection.disabled = true; if (!state.selectedImage) els.sendSelectionToAi.disabled = true; return; }
    var range = selection.getRangeAt(0);
    if (!els.markdownContent.contains(range.commonAncestorContainer)) { state.selectedText = null; els.annotateSelection.disabled = true; els.translateSelection.disabled = true; if (!state.selectedImage) els.sendSelectionToAi.disabled = true; return; }
    var rawSelection = selection.toString();
    var quote = rawSelection.trim();
    if (!quote) { state.selectedText = null; els.annotateSelection.disabled = true; els.translateSelection.disabled = true; if (!state.selectedImage) els.sendSelectionToAi.disabled = true; return; }
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
    els.translateSelection.disabled = state.translating;
    state.selectedImage = null;
    updateImageNoteTools();
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img.ai-image-selected'), function (image) { image.classList.remove('ai-image-selected'); });
    els.sendSelectionToAi.disabled = false;
    els.sendSelectionToAi.textContent = '发给 AI';
  }

  function selectMarkdownImage(image) {
    if (!state.currentPaper || !state.currentPaper.hasMarkdown || state.currentPaper.path !== state.currentPath) return;
    var file = image.getAttribute('data-paper-file');
    if (!file) { showToast('目前仅支持选择论文目录中的本地图片'); return; }
    Array.prototype.forEach.call(els.markdownContent.querySelectorAll('img.ai-image-selected'), function (other) { other.classList.remove('ai-image-selected'); });
    image.classList.add('ai-image-selected');
    state.selectedImage = { file: file, url: image.src, alt: (image.alt || '').slice(0, 240) };
    updateImageNoteTools();
    state.selectedText = null;
    els.annotateSelection.disabled = true;
    els.translateSelection.disabled = true;
    els.sendSelectionToAi.disabled = false;
    els.sendSelectionToAi.textContent = '发送图片';
  }

  function updateImageNoteTools() {
    els.markdownImageTools.classList.toggle('hidden', !state.selectedImage);
    if (state.selectedImage) {
      els.selectedImageName.textContent = state.selectedImage.alt || state.selectedImage.file.split(/[\\/]/).pop();
      els.selectedImageName.title = state.selectedImage.file;
    }
  }

  function clearMarkdownImageSelection() {
    state.selectedImage = null; updateImageNoteTools();
    els.markdownContent.querySelectorAll('img.ai-image-selected').forEach(function (image) { image.classList.remove('ai-image-selected'); });
    els.sendSelectionToAi.disabled = !state.selectedText;
    els.sendSelectionToAi.textContent = '发给 AI';
  }

  function addAnnotationToNote(id) {
    if (!state.currentPaper || !state.currentPaper.hasMarkdown) return;
    var annotation = state.currentPaper.review.annotations.find(function (item) { return item.id === id; });
    if (!annotation) return;
    setNotesCollapsed(false);
    if (window.LiteraturePaperNotes.addAnnotation(annotation)) showToast('批注已加入整篇笔记，保留原文、批注和来源链接。');
  }

  function locateNoteSource(kind, value) {
    if (!state.currentPaper || !state.currentPaper.hasMarkdown || state.currentPaper.path !== state.currentPath) return;
    if (kind === 'annotation') {
      if (!state.currentPaper.review.annotations.some(function (item) { return item.id === value; })) {
        showToast('原批注已删除；笔记中的摘录仍保留，可在正文中搜索核对。'); return;
      }
      focusAnnotation(value);
      if (!els.markdownContent.querySelector('mark[data-annotation-id="' + cssEscape(value) + '"]')) showToast('未能定位原文，Markdown 内容可能已变化；笔记摘录仍保留。');
      return;
    }
    if (kind === 'image') {
      if (state.currentPaper.review.markdownCollapsed) setMarkdownCollapsed(false);
      var image = Array.from(els.markdownContent.querySelectorAll('img[data-paper-file]')).find(function (item) { return item.getAttribute('data-paper-file') === value; });
      if (!image) { showToast('当前 Markdown 中未找到这张图片，文件或正文可能已变化。'); return; }
      image.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      image.classList.add('note-image-located');
      setTimeout(function () { image.classList.remove('note-image-located'); }, 2500);
    }
  }

  function sendSelectionToAi() {
    if (state.selectedImage) {
      window.AILiteratureChat.addLocalImage(state.selectedImage).then(function () {
        showToast('图片已放入 AI 对话');
        state.selectedImage = null;
        updateImageNoteTools();
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
      els.translateSelection.disabled = true;
      els.sendSelectionToAi.disabled = true;
    }
  }

  function translateSelection() {
    if (!state.selectedText || state.translating || !state.currentPaper) return;
    var selection = {
      quote: state.selectedText.quote,
      prefix: state.selectedText.prefix,
      suffix: state.selectedText.suffix
    };
    var paperPath = state.currentPath;
    state.translating = true;
    els.translateSelection.disabled = true;
    els.translateSelection.textContent = '翻译中…';
    els.annotateSelection.disabled = true;
    els.sendSelectionToAi.disabled = true;
    if (!state.translationClient) {
      state.translationClient = new window.ZoteroCodexModules.CodexClient.BrowserCodexClient({ log: function () {} });
    }
    state.translationClient.translateText(selection.quote).then(function (translation) {
      if (!state.currentPaper || state.currentPath !== paperPath) {
        showToast('论文已切换，本次译文未保存');
        return;
      }
      var now = new Date().toISOString();
      var annotation = {
        id: makeId(), quote: selection.quote, prefix: selection.prefix, suffix: selection.suffix,
        comment: translation, kind: 'translation', createdAt: now, updatedAt: now
      };
      state.currentPaper.review.annotations.push(annotation);
      applyOneHighlight(annotation);
      renderAnnotations();
      scheduleSave();
      window.getSelection().removeAllRanges();
      state.selectedText = null;
      showToast('译文已保存到批注');
    }).catch(function (error) {
      showToast('翻译失败：' + error.message);
    }).then(function () {
      state.translating = false;
      els.translateSelection.textContent = 'AI 翻译';
      els.translateSelection.disabled = !state.selectedText;
      els.annotateSelection.disabled = !state.selectedText;
      els.sendSelectionToAi.disabled = !state.selectedText && !state.selectedImage;
    });
  }

  function annotationDraftChanged(draft) {
    return !!draft && String(draft.comment || '').trim() !== String(draft.originalComment || '').trim();
  }

  function suspendAnnotationEditor() {
    // Drafts stay in memory per paper; scrolling, copying and switching papers do not save or discard them.
    state.annotationDraft = null;
    els.annotationEditor.classList.add('hidden');
    els.notesPanel.classList.remove('annotation-composing');
  }

  function renderAnnotationEditor(focus) {
    var valid = state.currentPaper && state.currentPaper.hasMarkdown && state.currentPaper.path === state.currentPath;
    var draft = valid ? state.annotationDrafts[state.currentPath] : null;
    if (!draft) { suspendAnnotationEditor(); return; }
    if (state.annotationDraft !== draft) els.annotationEditor.scrollTop = 0;
    state.annotationDraft = draft;
    els.annotationEditor.classList.remove('hidden');
    els.notesPanel.classList.add('annotation-composing');
    els.annotationEditorTitle.textContent = draft.id ? '修改文字批注' : '添加文字批注';
    els.selectedQuote.textContent = draft.quote;
    if (els.annotationText.value !== draft.comment) els.annotationText.value = draft.comment;
    els.annotationText.removeAttribute('aria-invalid');
    els.annotationDraftStatus.classList.remove('error');
    els.annotationDraftStatus.textContent = annotationDraftChanged(draft) ? '未保存草稿 · 收起侧栏或切换论文会暂存，关闭程序后不保留' : '可继续阅读、选字和复制，最初的原文不会改变';
    if (focus) { setNotesCollapsed(false); setNotesLayout('annotations', false); els.annotationText.focus({ preventScroll: true }); }
  }

  function beginAnnotationDraft(id, source) {
    if (!state.currentPaper || !state.currentPaper.hasMarkdown || state.currentPaper.path !== state.currentPath) return;
    var previous = state.annotationDrafts[state.currentPath];
    if (previous && previous.id === id && (id || (previous.quote === source.quote && previous.prefix === source.prefix && previous.suffix === source.suffix))) {
      renderAnnotationEditor(true); return;
    }
    if (annotationDraftChanged(previous) && !window.confirm('当前有尚未保存的批注，放弃这份草稿并编辑另一条？')) return;
    var original = id ? String(source.comment || '') : '';
    state.annotationDrafts[state.currentPath] = {
      paper: state.currentPath, id: id, quote: source.quote, prefix: source.prefix || '', suffix: source.suffix || '',
      originalComment: original, comment: original
    };
    renderAnnotationEditor(true);
  }

  function openNewAnnotationEditor() {
    if (state.selectedText) beginAnnotationDraft(null, Object.assign({}, state.selectedText));
  }

  function openEditAnnotationEditor(id) {
    var annotation = findAnnotation(id);
    if (annotation) beginAnnotationDraft(id, annotation);
  }

  function cancelAnnotationEditor() {
    var draft = state.annotationDraft;
    if (!draft) return;
    if (annotationDraftChanged(draft) && !window.confirm('放弃这次未保存的批注编辑？')) return;
    delete state.annotationDrafts[draft.paper];
    suspendAnnotationEditor();
  }

  function locateAnnotationDraft() {
    var draft = state.annotationDraft;
    if (!draft || !state.currentPaper || state.currentPath !== draft.paper) return;
    if (state.currentPaper.review.markdownCollapsed) setMarkdownCollapsed(false);
    if (draft.id) { focusAnnotation(draft.id); return; }
    var nodes = collectTextNodes(), full = nodes.map(function (item) { return item.node.nodeValue; }).join('');
    var start = chooseMatch(full, draft);
    var target = nodes.find(function (item) { return item.start <= start && item.start + item.node.nodeValue.length > start; });
    if (start < 0 || !target) { showToast('未能定位选中的原文，正文内容可能已变化。'); return; }
    target.node.parentElement.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function confirmAnnotation(event) {
    event.preventDefault();
    var draft = state.annotationDraft;
    if (!draft || !state.currentPaper || state.currentPath !== draft.paper || state.currentPaper.path !== draft.paper) return;
    var comment = els.annotationText.value.trim();
    if (!comment) {
      els.annotationDraftStatus.textContent = '请先写下批注内容，或点击取消。';
      els.annotationDraftStatus.classList.add('error'); els.annotationText.setAttribute('aria-invalid', 'true');
      els.annotationText.focus({ preventScroll: true }); return;
    }
    var now = new Date().toISOString(), annotation;
    if (draft.id) {
      annotation = findAnnotation(draft.id);
      if (!annotation) { showToast('原批注已删除，不能覆盖保存；请取消后重新选取原文。'); return; }
      annotation.comment = comment; annotation.updatedAt = now;
      els.markdownContent.querySelectorAll('mark[data-annotation-id="' + cssEscape(draft.id) + '"]').forEach(function (mark) { mark.title = comment; });
    } else {
      annotation = {
        id: makeId(), quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix,
        comment: comment, kind: 'note', createdAt: now, updatedAt: now
      };
      state.currentPaper.review.annotations.push(annotation);
      applyOneHighlight(annotation);
    }
    delete state.annotationDrafts[draft.paper]; suspendAnnotationEditor();
    renderAnnotations(); setNotesCollapsed(false); scheduleSave();
    var card = els.annotationList.querySelector('.annotation-card[data-id="' + cssEscape(annotation.id) + '"]');
    if (card) { card.classList.add('active'); card.scrollIntoView({ block: 'nearest' }); }
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
    if (!state.currentPaper) return;
    var draft = state.annotationDrafts[state.currentPath], editing = draft && draft.id === id;
    if (!window.confirm(editing && annotationDraftChanged(draft) ? '删除这条批注，并放弃它尚未保存的修改？' : '删除这条批注？')) return;
    if (editing) { delete state.annotationDrafts[state.currentPath]; suspendAnnotationEditor(); }
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
    renderAnnotationEditor(false);
    var annotations = state.currentPaper ? state.currentPaper.review.annotations : [];
    var pdfOnlyWithoutAnnotations = state.currentPaper && !state.currentPaper.hasMarkdown && !annotations.length;
    els.notesPanel.classList.toggle('only-paper-note', !!pdfOnlyWithoutAnnotations);
    els.annotationCount.textContent = pdfOnlyWithoutAnnotations ? '整篇论文笔记' : annotations.length + ' 条批注';
    els.annotationListHeading.classList.toggle('hidden', !!pdfOnlyWithoutAnnotations);
    els.annotationList.classList.toggle('hidden', !!pdfOnlyWithoutAnnotations);
    if (!annotations.length) {
      els.annotationList.innerHTML = '<div class="annotation-empty">在 Markdown 中选择一段文字，<br>即可添加与原文绑定的批注。</div>';
      return;
    }
    els.annotationList.innerHTML = annotations.map(function (annotation) {
      return '<article class="annotation-card" data-id="' + escapeHtml(annotation.id) + '">' +
        (annotation.kind === 'translation' ? '<div class="annotation-kind">AI 翻译</div>' : '') +
        '<div class="annotation-quote" title="定位到原文">“' + escapeHtml(annotation.quote) + '”</div>' +
        '<div class="annotation-comment">' + escapeHtml(annotation.comment) + '</div>' +
        '<div class="annotation-card-footer"><span>' + formatDate(annotation.updatedAt || annotation.createdAt) + '</span>' +
        '<div class="annotation-card-actions">' + (state.currentPaper.hasMarkdown ? '<button data-action="note" title="将原文和批注加入整篇笔记：编辑时插入光标处，阅读时追加到文末">加入笔记</button>' : '') + '<button data-action="edit">修改</button><button data-action="delete">删除</button></div></div></article>';
    }).join('');
    Array.prototype.forEach.call(els.annotationList.querySelectorAll('.annotation-card'), function (card) {
      var id = card.getAttribute('data-id');
      card.querySelector('.annotation-quote').addEventListener('click', function () { focusAnnotation(id); });
      card.querySelector('[data-action="edit"]').addEventListener('click', function () { openEditAnnotationEditor(id); });
      card.querySelector('[data-action="delete"]').addEventListener('click', function () { deleteAnnotation(id); });
      var addNote = card.querySelector('[data-action="note"]');
      if (addNote) addNote.addEventListener('click', function () { addAnnotationToNote(id); });
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

  function applyAttachmentAnchors() {
    state.attachments.filter(function (link) { return link.parent === state.currentPath && link.quote; }).forEach(function (link) {
      var nodes = collectTextNodes();
      var full = nodes.map(function (item) { return item.node.nodeValue; }).join('');
      var start = chooseMatch(full, link);
      if (start < 0) return;
      var end = start + link.quote.length;
      var node = nodes.filter(function (item) { return item.start < end && item.start + item.node.nodeValue.length >= end; })[0];
      if (!node) return;
      var marker = document.createElement('button');
      marker.type = 'button'; marker.className = 'attachment-inline'; marker.textContent = ' ↗';
      marker.title = '打开附件：' + link.name;
      marker.addEventListener('click', function () { openAttachment(link.id); });
      var range = document.createRange();
      range.setStart(node.node, end - node.start); range.collapse(true);
      range.insertNode(marker);
    });
  }

  function applyOneHighlight(annotation) {
    if (!annotation.quote || els.markdownContent.querySelector('mark[data-annotation-id="' + cssEscape(annotation.id) + '"]')) return;
    var textNodes = collectTextNodes();
    var full = textNodes.map(function (item) { return item.node.nodeValue; }).join('');
    var start = chooseMatch(full, annotation);
    var end = start + annotation.quote.length;
    if (start < 0) {
      var compact = '', offsets = [];
      for (var index = 0; index < full.length; index++) {
        if (/\s/u.test(full[index])) continue;
        offsets.push(index);
        compact += full[index];
      }
      var compactQuote = annotation.quote.replace(/\s+/gu, '');
      if (!compactQuote) return;
      var compactStart = chooseMatch(compact, {
        quote: compactQuote,
        prefix: (annotation.prefix || '').replace(/\s+/gu, ''),
        suffix: (annotation.suffix || '').replace(/\s+/gu, '')
      });
      if (compactStart < 0) return;
      start = offsets[compactStart];
      end = offsets[compactStart + compactQuote.length - 1] + 1;
    }
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
        if (!parent || parent.closest('script,style,.attachment-inline')) return NodeFilter.FILTER_REJECT;
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
    if (state.currentPaper && state.currentPaper.review.markdownCollapsed) setMarkdownCollapsed(false);
    setNotesCollapsed(false);
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
    if (!state.currentPaper || state.recyclingPaper === state.currentPath) return;
    state.dirty = true;
    els.saveState.textContent = '待保存';
    els.saveState.className = 'save-state saving';
    window.LiteraturePaperNotes.saveState('待保存');
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
    window.LiteraturePaperNotes.saveState('保存中…');
    return api('/api/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperPath: path, review: review })
    }).then(function () {
      if (state.currentPath === path && !state.dirty) { els.saveState.textContent = '已保存'; els.saveState.className = 'save-state'; window.LiteraturePaperNotes.saveState('已保存'); }
    }).catch(function (error) {
      if (state.currentPath === path) { state.dirty = true; els.saveState.textContent = '失败'; els.saveState.className = 'save-state error'; window.LiteraturePaperNotes.saveState('保存失败，请重试'); }
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
    if (state.notesExpanded) fitNotesWidth();
  }

  function notesMaximumWidth() {
    var explorer = els.explorerPanel.classList.contains('collapsed') ? 38 : (window.innerWidth <= 1450 ? 235 : 280);
    var ai = els.aiPanel.classList.contains('collapsed') ? 38 : (parseFloat(els.aiPanel.style.getPropertyValue('--ai-width')) || 440);
    var readingMinimum = Math.min(400, Math.max(180, window.innerWidth * 0.36));
    return Math.max(180, Math.min(860, els.appShell.clientWidth - explorer - ai - readingMinimum));
  }

  function fitNotesWidth() {
    if (!state.notesExpanded) return;
    var preferred = Number(localStorage.getItem('ai-literature-reader.notes-expanded-width')) || Math.max(460, window.innerWidth * 0.36);
    els.notesPanel.style.setProperty('--notes-width', Math.round(Math.min(notesMaximumWidth(), Math.max(300, preferred))) + 'px');
  }

  function setNotesExpanded(expanded) {
    if (expanded && !state.currentPaper) return;
    if (expanded === state.notesExpanded) return;
    state.notesExpanded = !!expanded;
    els.notesPanel.classList.toggle('notes-expanded', !!expanded);
    els.appShell.classList.toggle('notes-writing', !!expanded);
    els.expandPaperNote.textContent = expanded ? '收回侧栏' : '并排展开';
    els.expandPaperNote.setAttribute('aria-pressed', String(!!expanded));
    els.expandPaperNote.title = expanded ? '恢复普通笔记侧栏宽度' : '与论文并排展开笔记';
    if (expanded) {
      setNotesCollapsed(false);
      state.notesLayoutAuto = { ai: false, explorer: false };
      // Make room when necessary, restoring only panels that were folded here.
      if (notesMaximumWidth() < 460 && !els.aiPanel.classList.contains('collapsed')) {
        state.notesLayoutAuto.ai = true; setAiCollapsed(true, false, true);
      }
      if (notesMaximumWidth() < 420 && !els.explorerPanel.classList.contains('collapsed')) {
        state.notesLayoutAuto.explorer = true; setExplorerCollapsed(true, true);
      }
      fitNotesWidth();
    } else {
      var restore = state.notesLayoutAuto; state.notesLayoutAuto = null;
      if (restore && restore.ai) setAiCollapsed(false, false, true);
      if (restore && restore.explorer) setExplorerCollapsed(false, true);
      applySidePanelWidths();
    }
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
      var dynamicMaximum = typeof maximum === 'function' ? maximum() : maximum;
      var width = Math.max(Math.min(minimum, dynamicMaximum), Math.min(dynamicMaximum, startWidth + startX - e.clientX));
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
    Array.prototype.forEach.call(els.libraryScope.querySelectorAll('button'), function (item) { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    renderTree();
  });
  els.treeSearch.addEventListener('input', function () { state.query = els.treeSearch.value; renderTree(); });
  els.treeMode.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-mode]');
    if (!button) return;
    state.viewMode = button.getAttribute('data-mode') === 'tags' ? 'tags' : 'files';
    Array.prototype.forEach.call(els.treeMode.querySelectorAll('button'), function (item) { item.classList.toggle('active', item === button); });
    els.treeSearch.placeholder = state.viewMode === 'tags' ? '搜索论文标题、标签或文件名' : '搜索论文标题或文件名';
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
  els.addImageToNote.addEventListener('click', function () {
    if (!state.selectedImage || !state.currentPaper || !state.currentPaper.hasMarkdown) return;
    setNotesCollapsed(false);
    if (window.LiteraturePaperNotes.addImage(state.selectedImage)) showToast('图片已加入整篇笔记，可切换“阅读”查看，或继续填写自己的理解。');
  });
  els.clearSelectedImage.addEventListener('click', clearMarkdownImageSelection);
  els.translateSelection.addEventListener('click', translateSelection);
  els.annotateSelection.addEventListener('click', openNewAnnotationEditor);
  els.annotationEditor.addEventListener('submit', confirmAnnotation);
  els.closeAnnotationEditor.addEventListener('click', cancelAnnotationEditor);
  els.cancelAnnotationEditor.addEventListener('click', cancelAnnotationEditor);
  els.locateAnnotationDraft.addEventListener('click', locateAnnotationDraft);
  els.annotationText.addEventListener('input', function () {
    if (!state.annotationDraft) return;
    state.annotationDraft.comment = els.annotationText.value;
    els.annotationText.removeAttribute('aria-invalid'); els.annotationDraftStatus.classList.remove('error');
    els.annotationDraftStatus.textContent = annotationDraftChanged(state.annotationDraft) ? '未保存草稿 · 收起侧栏或切换论文会暂存，关闭程序后不保留' : '可继续阅读、选字和复制，最初的原文不会改变';
  });
  els.annotationEditor.addEventListener('keydown', function (event) {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); confirmAnnotation(event); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelAnnotationEditor(); }
  });
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
  els.paperLocation.addEventListener('click', function () {
    if (!state.currentPath) return;
    api('/api/paper/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: state.currentPath }) })
      .catch(function (error) { showToast('打开论文目录失败：' + error.message); });
  });
  els.manageAttachments.addEventListener('click', openAttachmentDialog);
  var openPaperRecycle;
  // Both entry points share the same confirmation and recycling operation.
  (function () {
    var action = document.getElementById('recyclePaper');
    var dialog = document.createElement('dialog');
    dialog.className = 'paper-recycle-dialog';
    dialog.setAttribute('aria-labelledby', 'paperRecycleHeading');
    dialog.innerHTML = '<h2 id="paperRecycleHeading">移至回收站</h2><p class="recycle-title"></p>' +
      '<p>将整个论文目录（包括 PDF、Markdown 和图片）移至 Windows 回收站：</p><div class="recycle-path"></div>' +
      '<div class="recycle-records"></div><p class="recycle-keep"></p><p class="recycle-help">独立保存的笔记、批注、引用、AI 对话和附件文件会保留。从系统回收站还原到原位置后，可继续使用。</p>' +
      '<p class="recycle-error" role="alert"></p><div class="recycle-buttons"><button type="button" class="button secondary recycle-cancel">取消</button><button type="button" class="button recycle-confirm">移至回收站</button></div>';
    document.body.appendChild(dialog);
    var cancel = dialog.querySelector('.recycle-cancel'), confirm = dialog.querySelector('.recycle-confirm');
    var error = dialog.querySelector('.recycle-error'), pending = false, preview = null, generation = 0;
    cancel.addEventListener('click', function () { if (!pending) dialog.close(); });
    dialog.addEventListener('cancel', function (e) { if (pending) e.preventDefault(); });
    dialog.addEventListener('close', function () { ++generation; });
    action.addEventListener('click', function () { if (state.currentPath) openPaperRecycle(state.currentPath); });
    openPaperRecycle = async function (path, duplicate) {
      if (pending || dialog.open || !path) return;
      if (state.translating && state.currentPath === path) { showToast('正在翻译，请完成后再移至回收站。'); return; }
      if (state.annotationDrafts[path]) { showToast('请先保存或取消当前批注草稿，再移至回收站。'); return; }
      var token = ++generation;
      preview = null; error.textContent = ''; confirm.disabled = true;
      dialog.querySelector('.recycle-title').textContent = path;
      dialog.querySelector('.recycle-keep').textContent = duplicate ? '保留的副本：' + duplicate.keep : '';
      dialog.querySelector('.recycle-path').textContent = '正在读取目录信息…';
      dialog.querySelector('.recycle-records').textContent = '';
      dialog.showModal(); cancel.focus();
      try {
        await saveNow();
        if (state.dirty) throw new Error('当前阅读记录未保存成功，请重试保存后再操作。');
        var data = await api('/api/paper/recycle-preview?path=' + encodeURIComponent(path));
        if (!dialog.open || token !== generation) return;
        if (duplicate) { data.keep = duplicate.keep; data.hash = duplicate.hash; }
        preview = data;
        dialog.querySelector('.recycle-title').textContent = data.title;
        dialog.querySelector('.recycle-path').textContent = data.directory;
        dialog.querySelector('.recycle-records').textContent = '已有记录：' + data.annotations + ' 条批注' +
          (data.hasNote ? ' · 有整篇论文笔记' : '') + (data.hasCitation ? ' · 有引用信息' : '') + ' · ' + data.attachments + ' 项附件关联';
        error.textContent = (data.warnings || []).join('；'); confirm.disabled = false;
      } catch (e) { if (dialog.open && token === generation) error.textContent = e.message; }
    };
    confirm.addEventListener('click', async function () {
      if (pending || !preview) return;
      var path = preview.path;
      pending = true; cancel.disabled = true; confirm.disabled = true; confirm.textContent = '正在移至回收站…'; error.textContent = '';
      try {
        if (state.currentPath === path) clearTimeout(els.markdownContent._scrollTimer);
        await saveNow();
        if (state.dirty) throw new Error('当前阅读记录未保存成功，请重试后再操作。');
        state.recyclingPaper = path;
        // Release the PDF viewer's file handle before asking Windows to move the folder.
        if (state.currentPath === path) els.pdfFrame.removeAttribute('src');
        await api('/api/paper/recycle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preview) });
        if (state.currentPath === path) { ++state.loadToken; clearPaper(); }
        dialog.close(); showToast('已移至系统回收站，阅读记录已保留。');
        await loadTree(true);
        if (els.duplicateDialog.open) renderDuplicateList();
      } catch (e) {
        error.textContent = e.message;
        // Reopen the surviving paper if Windows cancelled or could not recycle it.
        if (state.currentPath === path) { clearPaper(); openPaper(path); }
      } finally {
        state.recyclingPaper = null; pending = false; cancel.disabled = false; confirm.disabled = false; confirm.textContent = '移至回收站';
      }
    });
  })();
  els.closeAttachmentDialog.addEventListener('click', function () { els.attachmentDialog.close(); });
  els.addAttachmentFile.addEventListener('click', function () {
    var body = Object.assign({ parent: state.attachmentParent }, anchorForAttachment());
    els.addAttachmentFile.disabled = true;
    api('/api/attachments/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (result) { if (!result.cancelled) return loadTree(true).then(function () { renderAttachmentList(); if (body.quote && state.currentPaper) renderMarkdown(state.loadToken); }); })
      .catch(function (error) { showToast('添加附件失败：' + error.message); })
      .then(function () { els.addAttachmentFile.disabled = false; });
  });
  els.linkParsedPaper.addEventListener('click', function () {
    var linked = state.attachments.filter(function (item) { return item.kind === 'parsed'; }).map(function (item) { return item.path; });
    var candidates = state.availablePapers.filter(function (item) { return item.hasMarkdown && item.path !== state.attachmentParent && linked.indexOf(item.path) < 0; });
    if (!candidates.length) { showToast('没有可关联的已解析材料'); return; }
    els.attachmentPaperChoice.innerHTML = candidates.map(function (paper) { return '<option value="' + escapeHtml(paper.path) + '">' + escapeHtml((paper.title || paper.name) + ' — ' + paper.path) + '</option>'; }).join('');
    els.attachmentPaperPicker.classList.remove('hidden');
  });
  els.confirmParsedLink.addEventListener('click', function () {
    var body = Object.assign({ parent: state.attachmentParent, path: els.attachmentPaperChoice.value }, anchorForAttachment());
    api('/api/attachments/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () { els.attachmentPaperPicker.classList.add('hidden'); return loadTree(true); })
      .then(function () { renderAttachmentList(); if (body.quote && state.currentPaper) renderMarkdown(state.loadToken); })
      .catch(function (error) { showToast('关联失败：' + error.message); });
  });
  els.attachmentOpenFolder.addEventListener('click', function () { if (state.activeAttachment) openAttachmentFolder(state.activeAttachment); });
  els.attachmentFullscreen.addEventListener('click', function () {
    var video = els.attachmentVideo;
    if (video.classList.contains('hidden')) return;
    if (video.requestFullscreen) video.requestFullscreen();
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  });
  els.attachmentVideo.addEventListener('error', function () { if (state.activeAttachment) showToast('浏览器无法播放此视频编码，可通过“打开所在文件夹”使用系统播放器。'); });
  els.showDuplicates.addEventListener('click', function () { renderDuplicateList(); els.duplicateDialog.showModal(); });
  els.closeDuplicateDialog.addEventListener('click', function () { els.duplicateDialog.close(); });
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
  els.toggleExplorer.addEventListener('click', function () { setExplorerCollapsed(!els.explorerPanel.classList.contains('collapsed')); });
  els.collapseExplorer.addEventListener('click', function () { setExplorerCollapsed(true); });
  els.explorerRail.addEventListener('click', function () { setExplorerCollapsed(false); });
  els.toggleNotes.addEventListener('click', function () { setNotesCollapsed(!els.notesPanel.classList.contains('collapsed')); });
  els.closeNotes.addEventListener('click', function () { setNotesCollapsed(true); });
  els.notesRail.addEventListener('click', function () { setNotesCollapsed(false); });
  els.notesLayoutSwitch.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-notes-layout]');
    if (button) setNotesLayout(button.dataset.notesLayout);
  });
  els.togglePdf.addEventListener('click', function () { setPdfCollapsed(!els.readingLayout.classList.contains('pdf-collapsed')); });
  els.toggleMarkdown.addEventListener('click', function () { setMarkdownCollapsed(!els.readingLayout.classList.contains('markdown-collapsed')); });
  els.collapseMarkdown.addEventListener('click', function () { setMarkdownCollapsed(true); });
  els.markdownRail.addEventListener('click', function () { setMarkdownCollapsed(false); });
  els.collapsePdf.addEventListener('click', function () { setPdfCollapsed(true); });
  els.pdfRail.addEventListener('click', function () { setPdfCollapsed(false); });
  els.toggleAi.addEventListener('click', function () { setAiCollapsed(!els.aiPanel.classList.contains('collapsed'), true); });
  els.collapseAi.addEventListener('click', function () { setAiCollapsed(true); });
  els.aiRail.addEventListener('click', function () { setAiCollapsed(false, true); });
  window.LiteraturePaperNotes.mount({
    change: function (text) { if (state.currentPaper) { state.currentPaper.review.note = text; scheduleSave(); } },
    save: saveNow,
    locate: locateNoteSource,
    toast: showToast
  });
  window.LiteratureMaterialExport.mount({ current: function () {
    return state.currentPaper && state.currentPaper.path === state.currentPath ? { paper: state.currentPath, review: JSON.parse(JSON.stringify(state.currentPaper.review)) } : null;
  } });
  window.LiteraturePdfImport.mount({
    toast: showToast,
    root: function () { return els.libraryPath.title || ''; },
    busy: function (value) { els.chooseRoot.disabled = value; },
    imported: async function () {
      await loadTree(true);
      state.scope = 'added'; state.filter = 'all'; state.query = ''; els.treeSearch.value = '';
      els.libraryScope.querySelectorAll('button').forEach(function (button) { button.classList.toggle('active', button.dataset.scope === 'added'); button.setAttribute('aria-pressed', String(button.dataset.scope === 'added')); });
      els.statusFilters.querySelectorAll('button').forEach(function (button) { button.classList.toggle('active', button.dataset.filter === 'all'); });
      renderTree();
      return { duplicateGroups: state.duplicates.length };
    }
  });
  els.expandPaperNote.addEventListener('click', function () { setNotesExpanded(!state.notesExpanded); });
  els.markdownContent.addEventListener('scroll', function () {
    if (!state.currentPaper) return;
    state.currentPaper.review.markdownScroll = els.markdownContent.scrollTop;
    clearTimeout(els.markdownContent._scrollTimer);
    els.markdownContent._scrollTimer = setTimeout(scheduleSave, 800);
  });
  els.readerDivider.addEventListener('pointerdown', beginDividerDrag);
  els.notesResizer.addEventListener('pointerdown', function (event) {
    beginSidePanelDrag(els.notesPanel, '--notes-width', state.notesExpanded ? 'ai-literature-reader.notes-expanded-width' : 'ai-literature-reader.notes-width', state.notesExpanded ? 300 : 260, state.notesExpanded ? notesMaximumWidth : 520, event);
  });
  window.addEventListener('resize', fitNotesWidth);
  els.aiResizer.addEventListener('pointerdown', function (event) { beginSidePanelDrag(els.aiPanel, '--ai-width', 'ai-literature-reader.ai-width', 340, 720, event); });
  window.addEventListener('beforeunload', function () { if (state.dirty) saveNow(); });
  window.addEventListener('pagehide', function () { navigator.sendBeacon('/close', ''); });
  function heartbeat() { fetch('/heartbeat', { method: 'POST', cache: 'no-store' }).catch(function () {}); }
  heartbeat(); setInterval(heartbeat, 4000);
  setInterval(function () {
    api('/api/library-revision').then(function (result) {
      if (result.revision && result.revision !== state.libraryRevision) loadTree(true);
    }).catch(function () {});
  }, 12000);
  applySidePanelWidths();
  setNotesLayout(localStorage.getItem('ai-literature-reader.notes-layout') || 'balanced', false);
  setExplorerCollapsed(localStorage.getItem('ai-literature-reader.explorer-collapsed') === 'true');
  setNotesCollapsed(localStorage.getItem('ai-literature-reader.notes-collapsed') !== 'false');
  setAiCollapsed(localStorage.getItem('ai-literature-reader.ai-collapsed') === 'true');
  window.AILiteratureChat.mount(els.aiChatRoot).catch(function (error) { showToast('Codex 连接失败：' + error.message); });
  document.getElementById('openCitations').addEventListener('click', function () {
    if (state.currentPaper) window.LiteratureCitations.open(state.currentPath);
  });
  loadTree(false);
})();
