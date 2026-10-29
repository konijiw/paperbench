(function () {
  'use strict';
  var options, enabled = false, editing = false;
  var editor, preview, panel, paperPath = '', paperHasMarkdown = false;
  var paperVersion = 0, imageBusy = false;
  var imagePrefix = 'paperbench-note-images/', imageDragType = 'application/x-paperbench-image';
  var template = [
    ['阅读目的', '我想从这篇论文弄清楚什么？'],
    ['一句话概括', '用自己的话记下最值得记住的内容。'],
    ['核心方法与结构', '它怎样解决问题？关键设计或假设是什么？'],
    ['关键证据', '记录实验条件、结果及图表或页码，区分原文与自己的判断。'],
    ['局限和待核对问题', '哪些是作者明确说明的局限？哪些是自己的疑问？'],
    ['对我的研究的启发', '能借鉴什么？还需要验证什么？']
  ];
  function $(id) { return document.getElementById(id); }
  function render() {
    preview.replaceChildren();
    if (!editor.value.trim()) {
      var empty = document.createElement('div'); empty.className = 'paper-note-empty';
      var title = document.createElement('strong'); title.textContent = enabled ? '先记下一点自己的理解' : '选择一篇论文，开始记录';
      var hint = document.createElement('p'); hint.textContent = enabled ? '可以自由写，也可以插入阅读小结模板。支持从正文拖入图片、拖入本地图片，或点击这里后 Ctrl+V 粘贴截图。' : '整篇笔记与文字批注保存在原来的阅读记录里。';
      empty.appendChild(title); empty.appendChild(hint);
      if (enabled) {
        var start = document.createElement('button'); start.type = 'button'; start.className = 'button secondary'; start.textContent = '开始写笔记';
        start.onclick = function () { setEditing(true); }; empty.appendChild(start);
      }
      preview.appendChild(empty); return;
    }
    var html;
    try { html = marked.parse(editor.value, { gfm: true, breaks: true }); }
    catch (_) { preview.textContent = editor.value; return; }
    var fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true, USE_PROFILES: { html: true }, FORBID_ATTR: ['srcset','style'], FORBID_TAGS: ['form','button','textarea','select','iframe','video','audio','style'] });
    fragment.querySelectorAll('img').forEach(function (image) {
      var source = image.getAttribute('src') || '', file;
      try { file = decodeURIComponent(source); } catch (_) { file = source; }
      var managed = /^paperbench-note-images\/[a-f0-9]{64}\.(png|jpg|gif|webp|bmp)$/.test(file);
      // Managed screenshots are portable and also work for papers with only a PDF.
      if ((!managed && !paperHasMarkdown) || !file || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(file)) {
        var hint = document.createElement('span'); hint.className = 'paper-note-prompt'; hint.textContent = '[图片未加载：仅支持当前 Markdown 论文目录中的图片]'; image.replaceWith(hint); return;
      }
      image.src = managed ? '/content/note-image?file=' + encodeURIComponent(file.slice(imagePrefix.length)) : '/content/asset?paper=' + encodeURIComponent(paperPath) + '&file=' + encodeURIComponent(file);
      image.loading = 'lazy'; image.className = 'paper-note-image';
      image.addEventListener('error', function () {
        var hint = document.createElement('span'); hint.className = 'paper-note-prompt'; hint.textContent = '[图片文件未找到：' + file + ']'; image.replaceWith(hint);
      }, { once: true });
    });
    preview.appendChild(fragment);
    preview.querySelectorAll('a').forEach(function (link) {
      var href = link.getAttribute('href') || '';
      if (/^#reader-(annotation|image)=/.test(href)) {
        link.classList.add('paper-note-source');
        link.addEventListener('click', function (event) {
          event.preventDefault();
          var match = /^#reader-(annotation|image)=(.*)$/.exec(href);
          try { options.locate(match[1], decodeURIComponent(match[2])); } catch (_) { options.toast('来源链接无法读取。'); }
        });
      } else if (/^https?:\/\//i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else { link.removeAttribute('href'); link.title = '此处保留链接文字；笔记暂不跳转本地文件。'; }
    });
    preview.querySelectorAll('input').forEach(function (input) { input.disabled = true; });
    // Headings stay ordinary Markdown in storage; folding is only a reading aid.
    Array.from(preview.children).forEach(function (heading) {
      if (heading.tagName !== 'H2' || heading.parentNode !== preview) return;
      var details = document.createElement('details'); details.className = 'paper-note-part'; details.open = true;
      var summary = document.createElement('summary'); summary.textContent = heading.textContent;
      var body = document.createElement('div'); body.className = 'paper-note-part-body';
      preview.insertBefore(details, heading); details.appendChild(summary);
      var next = heading.nextSibling; heading.remove();
      while (next && !(next.nodeType === 1 && /^(H1|H2)$/.test(next.tagName))) {
        var following = next.nextSibling; body.appendChild(next); next = following;
      }
      if (!body.textContent.trim() && !body.querySelector('img')) {
        var match = template.filter(function (part) { return part[0] === summary.textContent; })[0];
        if (match) { var hint = document.createElement('p'); hint.className = 'paper-note-prompt'; hint.textContent = match[1]; body.appendChild(hint); }
      }
      details.appendChild(body);
    });
  }
  function setEditing(value) {
    editing = !!value && enabled;
    panel.classList.toggle('note-editing', editing);
    editor.classList.toggle('hidden', !editing); preview.classList.toggle('hidden', editing);
    $('paperNoteToolbar').classList.toggle('hidden', !editing);
    $('readPaperNote').setAttribute('aria-pressed', String(!editing));
    $('editPaperNote').setAttribute('aria-pressed', String(editing));
    if (editing) editor.focus(); else render();
  }
  function commit() { if (enabled) options.change(editor.value); }
  function addMarkdown(text, source) {
    if (!enabled || (!paperHasMarkdown && source.indexOf('#reader-annotation=') !== 0)) return false;
    if (editor.value.indexOf('](' + source + ')') >= 0) { options.toast('这条内容已经加入笔记，可直接编辑已有摘录。'); return false; }
    var wasEditing = editing, position = wasEditing ? editor.selectionEnd : editor.value.length;
    var before = editor.value.slice(0, position), after = editor.value.slice(position);
    var prefix = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    var suffix = after && !after.startsWith('\n') ? '\n\n' : '\n';
    insert(prefix + text + suffix, position, position);
    if (!wasEditing) {
      setEditing(false);
      var links = preview.querySelectorAll('.paper-note-source');
      var added = Array.from(links).find(function (link) { return link.getAttribute('href') === source; });
      if (added) added.scrollIntoView({ block: 'nearest' });
    }
    return true;
  }
  function literal(text) { return String(text || '').replace(/([\\`*_{}\[\]()<>#+.!|~-])/g, '\\$1'); }
  function addAnnotation(annotation) {
    var source = '#reader-annotation=' + encodeURIComponent(annotation.id);
    var quote = String(annotation.quote || '').split(/\r?\n/).map(function (line) { return '> ' + literal(line); }).join('\n');
    var label = annotation.kind === 'translation' ? '**AI 译文**' : '**我的批注**';
    var text = '**原文摘录**\n\n' + quote + '\n\n' + (annotation.comment ? label + '\n\n' + literal(annotation.comment) + '\n\n' : '') + '[返回原文批注](' + source + ')\n';
    return addMarkdown(text, source);
  }
  function addImage(image) {
    var source = '#reader-image=' + encodeURIComponent(image.file);
    var file = image.file.replace(/\\/g, '/').split('/').map(function (part) { return encodeURIComponent(part).replace(/[!'()*]/g, function (char) { return '%' + char.charCodeAt(0).toString(16).toUpperCase(); }); }).join('/');
    return addMarkdown('![' + literal(image.alt || '原文图片') + '](<' + file + '>)\n\n[返回原文图片](' + source + ')\n', source);
  }
  function insert(text, start, end, selectionStart, selectionEnd) {
    if (!enabled) return;
    setEditing(true); editor.setSelectionRange(start, end);
    var applied = false;
    try { applied = document.execCommand('insertText', false, text); } catch (_) {}
    if (!applied) editor.setRangeText(text, start, end, 'end');
    editor.setSelectionRange(selectionStart == null ? start + text.length : selectionStart, selectionEnd == null ? start + text.length : selectionEnd);
    commit();
  }
  function format(kind) {
    if (!enabled) return;
    var start = editor.selectionStart, end = editor.selectionEnd, value = editor.value, selection = value.slice(start, end);
    if (kind === 'bold' || kind === 'italic') {
      var marker = kind === 'bold' ? '**' : '*', content = selection || '文字';
      insert(marker + content + marker, start, end, start + marker.length, start + marker.length + content.length); return;
    }
    start = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    if (end > start && value[end - 1] === '\n') end--;
    var lineEnd = value.indexOf('\n', end); end = lineEnd < 0 ? value.length : lineEnd;
    var prefix = { heading: '## ', list: '- ', quote: '> ', task: '- [ ] ' }[kind];
    var text = value.slice(start, end).split('\n').map(function (line) { return prefix + line; }).join('\n');
    insert(text, start, end);
  }
  function insertTemplate() {
    if (!enabled) return;
    var headings = new Set();
    editor.value.split('\n').forEach(function (line) { var match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line); if (match) headings.add(match[1]); });
    var missing = template.filter(function (part) { return !headings.has(part[0]); });
    if (!missing.length) { options.toast('六个小结标题已经存在，不会重复插入。'); return; }
    var old = editor.value, addition = (old ? (old.endsWith('\n\n') ? '' : old.endsWith('\n') ? '\n' : '\n\n') : '') + missing.map(function (part) { return '## ' + part[0] + '\n\n'; }).join('');
    insert(addition, old.length, old.length);
    // Place the cursor below the first newly inserted heading.
    var firstHeading = editor.value.indexOf('## ' + missing[0][0], old.length);
    if (firstHeading >= 0) { var firstBody = editor.value.indexOf('\n', firstHeading) + 2; editor.setSelectionRange(firstBody, firstBody); }
    options.toast('已补充小结标题，原有笔记保留；只填写需要的部分即可。');
  }
  function imageFiles(transfer) {
    if (!transfer) return [];
    var isImage = function (file) { return file && (/^image\//i.test(file.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || '')); };
    var files = Array.from(transfer.items || []).filter(function (item) { return item.kind === 'file'; }).map(function (item) {
      var file = item.getAsFile();
      return file && !file.type && /^image\//i.test(item.type || '') ? new File([file], file.name || '截图', { type: item.type }) : file;
    }).filter(isImage);
    return files.length ? files : Array.from(transfer.files || []).filter(isImage);
  }
  function acceptsImages(transfer) {
    if (!transfer) return false;
    var types = Array.from(transfer.types || []), items = Array.from(transfer.items || []);
    return types.indexOf(imageDragType) >= 0 || items.some(function (item) { return item.kind === 'file' && (!item.type || /^image\//i.test(item.type)); }) || imageFiles(transfer).length > 0 || (types.indexOf('Files') >= 0 && !items.length);
  }
  function sourceImage(transfer) {
    if (!transfer || !transfer.getData) return null;
    var custom = transfer.getData(imageDragType);
    if (custom) {
      var image = JSON.parse(custom);
      if (image.paper === paperPath && typeof image.file === 'string' && image.file) return image;
      return null;
    }
    // Browser "Copy image" can provide only HTML or a local image URL, not image bytes.
    var sources = [], html = transfer.getData('text/html');
    if (html) { var template = document.createElement('template'); template.innerHTML = html; var img = template.content.querySelector('img'); if (img) sources.push(img.getAttribute('src')); }
    sources = sources.concat((transfer.getData('text/uri-list') || transfer.getData('text/plain') || '').split(/\r?\n/));
    for (var source of sources) {
      if (!source || source[0] === '#') continue;
      try {
        var url = new URL(source, window.location.href);
        if (url.origin !== window.location.origin || url.pathname !== '/content/asset' || url.searchParams.get('paper') !== paperPath) continue;
        var file = url.searchParams.get('file');
        if (file) return { paper: paperPath, file: file, alt: '原文图片' };
      } catch (_) {}
    }
    return null;
  }
  function addSourceImage(image) { if (image && addImage(image)) options.toast('原文图片已加入笔记，保留来源链接。'); }
  async function pasteImage() {
    if (!enabled) return;
    if (!navigator.clipboard || !navigator.clipboard.read) { setEditing(true); options.toast('请在编辑框中按 Ctrl+V 粘贴截图。'); return; }
    try {
      var version = paperVersion, items = await navigator.clipboard.read(), files = [], html = '', text = '';
      for (var item of items) {
        var type = item.types.find(function (type) { return /^image\//i.test(type); });
        if (type) files.push(new File([await item.getType(type)], '截图.' + (type.split('/')[1] || 'png'), { type: type }));
        else {
          if (item.types.indexOf('text/html') >= 0) html = await (await item.getType('text/html')).text();
          if (item.types.indexOf('text/plain') >= 0) text = await (await item.getType('text/plain')).text();
        }
      }
      if (version !== paperVersion) return;
      if (files.length) { await importImages(files); return; }
      var image = sourceImage({ getData: function (type) { return type === 'text/html' ? html : type === 'text/plain' ? text : ''; } });
      if (image) { addSourceImage(image); return; }
      options.toast('剪贴板中没有可用图片，请先截图或使用“复制图片”。');
    } catch (_) { setEditing(true); options.toast('无法直接读取剪贴板，请在编辑框按 Ctrl+V 粘贴截图。'); }
  }
  async function importImages(files) {
    if (!enabled || !files.length) return;
    if (imageBusy) { options.toast('正在保存图片，请稍候再添加。'); return; }
    var version = paperVersion, paper = paperPath, wasEditing = editing, original = editor.value;
    var start = wasEditing ? editor.selectionStart : original.length, end = wasEditing ? editor.selectionEnd : original.length;
    var markdown = [], errors = [];
    imageBusy = true; setSaveState('正在保存图片…');
    try {
      for (var file of files) {
        if (version !== paperVersion) break;
        try {
          if (file.size > 10 * 1024 * 1024) throw new Error('单张图片不能超过 10 MB');
          var response = await fetch('/api/notes/image?paper=' + encodeURIComponent(paper), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
          var result = await response.json();
          if (!response.ok) throw new Error(result.error || '图片保存失败');
          if (!/^paperbench-note-images\/[a-f0-9]{64}\.(png|jpg|gif|webp|bmp)$/.test(result.file)) throw new Error('图片保存结果无效');
          markdown.push('![' + literal(file.name || '截图') + '](<' + result.file + '>)');
        } catch (error) { errors.push(error.message || '图片保存失败'); }
      }
      if (version !== paperVersion) { options.toast('已切换论文，本次图片未插入新笔记。'); return; }
      if (markdown.length) {
        // Do not replace text the user edited while the upload was in flight.
        if (editor.value !== original) { start = editing ? editor.selectionStart : editor.value.length; end = start; }
        var before = editor.value.slice(0, start), after = editor.value.slice(end);
        insert((before && !before.endsWith('\n\n') ? '\n\n' : '') + markdown.join('\n\n') + (after.startsWith('\n') ? '\n' : '\n\n'), start, end);
        if (!wasEditing) { setEditing(false); var images = preview.querySelectorAll('img'); if (images.length) images[images.length - 1].scrollIntoView({ block: 'nearest' }); }
        options.toast('已加入 ' + markdown.length + ' 张图片。' + (errors.length ? ' 部分未添加：' + errors[0] : ''));
      } else if (errors.length) { setSaveState('图片保存失败'); options.toast(errors[0]); }
    } finally { imageBusy = false; }
  }
  function mountImageInput() {
    var section = editor.closest('.paper-note-section');
    section.title = '可拖入正文图片或本地图片；点击笔记后 Ctrl+V 粘贴截图';
    editor.placeholder += ' 支持拖入图片或 Ctrl+V 粘贴截图。';
    preview.addEventListener('click', function (event) { if (!event.target.closest('a,button,summary,input')) preview.focus({ preventScroll: true }); });
    section.addEventListener('pointerdown', function (event) { if (!editing && !event.target.closest('a,button,summary,input,textarea')) preview.focus({ preventScroll: true }); });
    preview.addEventListener('keydown', function (event) {
      if (!enabled || event.isComposing || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'v') return;
      if (navigator.clipboard && navigator.clipboard.read) { event.preventDefault(); pasteImage(); }
      else setEditing(true);
    });
    $('pasteNoteImage').onclick = pasteImage;
    document.addEventListener('paste', function (event) {
      if (!enabled || !(section.contains(event.target) || section.contains(document.activeElement))) return;
      var source;
      try { source = sourceImage(event.clipboardData); } catch (_) {}
      if (source) { event.preventDefault(); event.stopPropagation(); addSourceImage(source); return; }
      var files = imageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault(); event.stopPropagation(); importImages(files);
    }, true);
    section.addEventListener('dragover', function (event) {
      if (!enabled || !acceptsImages(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'copy'; section.classList.add('note-image-drop');
    });
    section.addEventListener('dragleave', function (event) { if (!section.contains(event.relatedTarget)) section.classList.remove('note-image-drop'); });
    section.addEventListener('drop', function (event) {
      section.classList.remove('note-image-drop');
      if (!enabled || !acceptsImages(event.dataTransfer)) return;
      event.preventDefault(); event.stopPropagation();
      var source = event.dataTransfer.getData(imageDragType);
      if (source) {
        try {
          var image = JSON.parse(source);
          if (image.paper !== paperPath || typeof image.file !== 'string' || !image.file) throw new Error('请把当前论文的正文图片拖入笔记。');
          if (addImage(image)) options.toast('原文图片已加入笔记，保留来源链接。');
        } catch (error) { options.toast(error.message || '无法添加这张图片。'); }
      } else {
        var files = imageFiles(event.dataTransfer);
        if (files.length) importImages(files); else options.toast('阅读笔记接收图片；PDF 请拖到左侧论文库。');
      }
    });
    document.addEventListener('dragend', function () { section.classList.remove('note-image-drop'); });
  }
  function mount(config) {
    options = config; editor = $('paperNote'); preview = $('paperNotePreview'); panel = $('notesPanel');
    $('readPaperNote').onclick = function () { setEditing(false); };
    $('editPaperNote').onclick = function () { setEditing(true); };
    $('insertNoteTemplate').onclick = insertTemplate;
    editor.addEventListener('input', commit);
    editor.addEventListener('keydown', function (e) {
      if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      var key = e.key.toLowerCase();
      if (key === 'b' || key === 'i') { e.preventDefault(); format(key === 'b' ? 'bold' : 'italic'); }
      if (key === 's') { e.preventDefault(); options.save(); }
    });
    $('paperNoteToolbar').querySelectorAll('button').forEach(function (button) {
      button.addEventListener('mousedown', function (e) { e.preventDefault(); });
      button.onclick = function () { format(button.dataset.noteFormat); };
    });
    mountImageInput(); setPaper(null);
  }
  function setPaper(paper) {
    paperVersion++;
    paperPath = paper ? paper.path : ''; paperHasMarkdown = !!(paper && paper.hasMarkdown);
    enabled = !!paper; editor.disabled = !enabled;
    $('editPaperNote').disabled = !enabled; $('insertNoteTemplate').disabled = !enabled; $('expandPaperNote').disabled = !enabled; $('pasteNoteImage').disabled = !enabled;
    editor.value = paper ? paper.review.note || '' : '';
    editor.scrollTop = 0; preview.scrollTop = 0; setEditing(false);
    setSaveState(paper ? '已保存' : '选择论文后开始记录');
  }
  function setSaveState(text) { $('paperNoteSaveState').textContent = text; $('paperNoteSaveState').classList.toggle('error', text.indexOf('失败') >= 0); }
  window.LiteraturePaperNotes = { mount: mount, setPaper: setPaper, saveState: setSaveState, addAnnotation: addAnnotation, addImage: addImage };
})();
