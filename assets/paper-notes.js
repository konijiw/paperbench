(function () {
  'use strict';
  var options, enabled = false, editing = false;
  var editor, preview, panel, paperPath = '', paperHasMarkdown = false;
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
      var hint = document.createElement('p'); hint.textContent = enabled ? '可以自由写，也可以插入阅读小结模板。只写一句话、只填部分小节都可以。' : '整篇笔记与文字批注保存在原来的阅读记录里。';
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
      // Resolve before attaching to the live document: notes only load this paper's local images.
      if (!paperHasMarkdown || !file || /^(?:[a-z][a-z0-9+.-]*:|[\\/])/i.test(file)) {
        var hint = document.createElement('span'); hint.className = 'paper-note-prompt'; hint.textContent = '[图片未加载：仅支持当前 Markdown 论文目录中的图片]'; image.replaceWith(hint); return;
      }
      image.src = '/content/asset?paper=' + encodeURIComponent(paperPath) + '&file=' + encodeURIComponent(file);
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
    if (!enabled || !paperHasMarkdown) return false;
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
    setPaper(null);
  }
  function setPaper(paper) {
    paperPath = paper ? paper.path : ''; paperHasMarkdown = !!(paper && paper.hasMarkdown);
    enabled = !!paper; editor.disabled = !enabled;
    $('editPaperNote').disabled = !enabled; $('insertNoteTemplate').disabled = !enabled; $('expandPaperNote').disabled = !enabled;
    editor.value = paper ? paper.review.note || '' : '';
    editor.scrollTop = 0; preview.scrollTop = 0; setEditing(false);
    setSaveState(paper ? '已保存' : '选择论文后开始记录');
  }
  function setSaveState(text) { $('paperNoteSaveState').textContent = text; $('paperNoteSaveState').classList.toggle('error', text.indexOf('失败') >= 0); }
  window.LiteraturePaperNotes = { mount: mount, setPaper: setPaper, saveState: setSaveState, addAnnotation: addAnnotation, addImage: addImage };
})();
