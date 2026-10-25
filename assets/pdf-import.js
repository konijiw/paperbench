(function () {
  'use strict';
  var options, panel, overlay, button, picker, entries = [], jobs = [], history = [];
  var running = false, activity = null, nextId = 0, selectionRound = 0, dragDepth = 0;
  function $(id) { return document.getElementById(id); }
  async function api(url, data, binary) {
    var response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: binary ? {} : { 'Content-Type': 'application/json' }, body: binary ? data : JSON.stringify(data) });
    var result = await response.json(); if (!response.ok) throw new Error(result.error || '导入请求失败'); return result;
  }
  function size(value) { return value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB'; }
  function available() { return entries.filter(function (entry) { return entry.file && (entry.status === 'pending' || entry.status === 'error'); }); }
  function label(entry) {
    return { pending: '待导入', queued: '已排队', importing: '正在导入 ' + (entry.progress || 0) + '%', done: '已导入', error: '失败 · ' + entry.error }[entry.status];
  }
  function controls() {
    var waiting = available().length, queued = entries.filter(function (entry) { return entry.status === 'queued' || entry.status === 'importing'; }).length;
    button.textContent = activity ? '导入中 ' + activity.index + '/' + activity.total : waiting + queued ? '导入 PDF（' + (waiting + queued) + '）' : '导入论文 PDF';
    button.title = activity ? activity.name + ' · ' + activity.percent + '%' : '跨文件夹累计选取；拖入 PDF 则直接自动入库';
    if (!panel) return;
    $('pdfImportCount').textContent = entries.length ? '清单 ' + entries.length + ' 份 · 待导入 ' + waiting + (queued ? ' · 已排队 ' + queued : '') : '清单为空，可从多个文件夹分次添加';
    $('pdfImportStart').disabled = !waiting; $('pdfImportStart').textContent = waiting ? '开始导入（' + waiting + '）' : '开始导入';
    $('pdfImportClear').disabled = !entries.length || entries.some(function (entry) { return entry.status === 'queued' || entry.status === 'importing'; });
    $('pdfImportProgress').classList.toggle('hidden', !activity);
    if (activity) {
      $('pdfImportProgress').value = activity.percent;
      $('pdfImportActivity').textContent = (activity.source === 'drop' ? '拖入文件自动导入' : '清单批量导入') + ' · ' + activity.index + '/' + activity.total + ' · ' + activity.percent + '%\n' + activity.name;
    } else $('pdfImportActivity').textContent = '拖入会直接自动入库；按钮清单只有点击“开始导入”才执行。';
  }
  function render() {
    if (!panel) return;
    var list = $('pdfImportList'); list.replaceChildren();
    entries.forEach(function (entry) {
      var row = document.createElement('div'); row.className = 'pdf-import-row'; row.dataset.importEntry = entry.id; row.dataset.state = entry.status;
      var icon = document.createElement('span'); icon.className = 'pdf-import-file-icon'; icon.textContent = 'PDF';
      var body = document.createElement('div'), title = document.createElement('strong'), meta = document.createElement('small'), state = document.createElement('small');
      body.className = 'pdf-import-file-info'; title.textContent = entry.name; title.title = entry.name;
      meta.textContent = entry.origin + ' · ' + size(entry.size) + (entries.some(function (other) { return other.id !== entry.id && other.name === entry.name; }) ? ' · 同名文件分别保留' : '');
      state.className = 'pdf-import-file-state'; state.textContent = label(entry); state.title = entry.path || entry.error || '';
      body.appendChild(title); body.appendChild(meta); body.appendChild(state);
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'plain-icon'; remove.textContent = '×'; remove.title = '从清单移除，不删除原文件'; remove.setAttribute('aria-label', '移除 ' + entry.name);
      remove.disabled = entry.status === 'queued' || entry.status === 'importing';
      remove.onclick = function () { entries = entries.filter(function (other) { return other !== entry; }); render(); };
      row.appendChild(icon); row.appendChild(body); row.appendChild(remove); list.appendChild(row);
    });
    if (!entries.length) {
      var empty = document.createElement('div'); empty.className = 'pdf-import-empty';
      empty.textContent = '点击“继续添加 PDF”，可以先选文件夹 A，再去文件夹 B 继续选。收起窗口后，清单仍会保留。'; list.appendChild(empty);
    }
    $('pdfImportHistoryText').textContent = history.slice().reverse().map(function (item) { return (item.ok ? '✓ ' : '失败：') + item.name + (item.error ? ' · ' + item.error : ''); }).join('\n');
    $('pdfImportHistory').classList.toggle('hidden', !history.length);
    controls();
  }
  function updateEntry(entry) {
    if (panel) {
      var row = $('pdfImportList').querySelector('[data-import-entry="' + entry.id + '"]');
      if (row) { row.dataset.state = entry.status; row.querySelector('.pdf-import-file-state').textContent = label(entry); }
    }
    controls();
  }
  function createEntries(files, origin) {
    var result = [], rejected = 0;
    Array.from(files).forEach(function (file) {
      if (!(/\.pdf$/i.test(file.name) || file.type === 'application/pdf') || file.size <= 0 || file.size > 8 * 1073741824) { rejected++; return; }
      if (result.length >= 2000) { rejected++; return; }
      result.push({ id: String(++nextId), file: file, name: /\.pdf$/i.test(file.name) ? file.name : file.name + '.pdf', size: file.size, status: 'pending', progress: 0, error: '', origin: origin });
    });
    if (rejected) options.toast('忽略了 ' + rejected + ' 个不支持的项目：仅导入有效 PDF 文件，单份不超过 8 GB，不递归导入文件夹。');
    return result;
  }
  function show() {
    if (!panel) init();
    if (!panel.open) panel.show(); render();
  }
  function selectFiles() { picker.value = ''; picker.click(); }
  function enqueue(items, source) {
    if (!items.length) return;
    items.forEach(function (entry) { entry.status = 'queued'; entry.error = ''; });
    jobs.push({ items: items, source: source, root: options.root() }); render(); controls(); pump();
  }
  function normalizedRoot(value) { return String(value || '').replace(/\//g, '\\').replace(/[\\]+$/, '').toLocaleLowerCase(); }
  async function importOne(entry, root, progress) {
    var id = null;
    try {
      var signature = await entry.file.slice(0, 1024).text();
      if (signature.indexOf('%PDF-') < 0) throw new Error('文件没有 PDF 标识，请确认文件已下载完成且格式正确。');
      var started = await api('/api/papers/import-pdfs/start', { name: entry.name, size: entry.size, libraryRoot: root });
      id = started.id; var offset = 0;
      while (offset < entry.size) {
        var chunk = entry.file.slice(offset, Math.min(offset + 1048576, entry.size));
        await api('/api/papers/import-pdfs/chunk?id=' + encodeURIComponent(id) + '&offset=' + offset, chunk, true);
        offset += chunk.size; entry.progress = Math.round(offset * 100 / entry.size); progress(offset); updateEntry(entry);
      }
      // Completion receipts make this retry safe if the first response was lost after committing.
      var result;
      try { result = await api('/api/papers/import-pdfs/complete', { id: id }); }
      catch (_) { result = await api('/api/papers/import-pdfs/complete', { id: id }); }
      id = null; return result.path;
    } finally {
      if (id) { try { await api('/api/papers/import-pdfs/cancel', { id: id }); } catch (_) {} }
    }
  }
  async function pump() {
    if (running) return;
    running = true; options.busy(true);
    try {
      while (jobs.length) {
        var job = jobs.shift(), imported = 0, failed = 0, completedBytes = 0, totalBytes = job.items.reduce(function (sum, entry) { return sum + entry.size; }, 0);
        var root = job.root, rootError = '';
        try {
          var settings = await api('/api/settings');
          if (root && normalizedRoot(root) !== normalizedRoot(settings.libraryRoot)) throw new Error('论文库已切换，请在当前论文库重新导入。');
          root = settings.libraryRoot;
        } catch (e) { rootError = e.message; }
        for (var index = 0; index < job.items.length; index++) {
          var entry = job.items[index]; entry.status = 'importing'; entry.progress = 0;
          activity = { source: job.source, index: index + 1, total: job.items.length, name: entry.name, percent: Math.round(completedBytes * 100 / totalBytes) }; render();
          try {
            if (rootError) throw new Error(rootError);
            entry.path = await importOne(entry, root, function (offset) { activity.percent = Math.round((completedBytes + offset) * 100 / totalBytes); });
            entry.status = 'done'; entry.file = null; imported++;
            history.push({ name: entry.name, ok: true });
          } catch (error) {
            entry.status = 'error'; entry.error = error.message || '文件读取或传输失败'; failed++;
            history.push({ name: entry.name, ok: false, error: entry.error });
          }
          completedBytes += entry.size; history = history.slice(-40); render();
        }
        var duplicateGroups = 0;
        if (imported) { try { var refreshed = await options.imported(); duplicateGroups = refreshed && refreshed.duplicateGroups || 0; } catch (e) { options.toast('已导入，但列表刷新失败：' + e.message); } }
        options.toast('已导入 ' + imported + ' 篇' + (failed ? '，失败 ' + failed + ' 份；点击“导入论文 PDF”可查看结果。' : '，可在“最新加入”中查看。') +
          (duplicateGroups ? ' 论文库中发现 ' + duplicateGroups + ' 组重复 PDF，请点击“重复论文”检查。' : ''));
      }
    } finally { activity = null; running = false; options.busy(false); render(); controls(); }
  }
  function init() {
    panel = document.createElement('dialog'); panel.className = 'pdf-import-dialog'; panel.setAttribute('aria-label', '跨文件夹导入 PDF');
    panel.innerHTML = '<div class="pdf-import-heading"><div><strong>导入论文 PDF</strong><small>跨文件夹累计选择，确认后一起导入</small></div><button id="pdfImportClose" class="plain-icon" type="button" aria-label="收起待导入清单" title="收起窗口，清单保留，正在导入的任务继续">×</button></div>' +
      '<div class="pdf-import-body"><div class="pdf-import-tools"><button id="pdfImportAdd" class="button secondary" type="button">继续添加 PDF</button><button id="pdfImportClear" class="pdf-import-text-button" type="button">清空清单</button><span id="pdfImportCount"></span></div>' +
      '<div id="pdfImportList" class="pdf-import-list"></div><p class="attachment-hint">可以分多次从不同文件夹选取，同名文件分别保留并自动避让目录名。清单仅在本次页面中暂存，刷新或关闭页面会清空；原文件保留。拖入 PDF 会直接入库，不追加到这份待选清单。</p>' +
      '<progress id="pdfImportProgress" class="hidden" value="0" max="100" aria-label="PDF 导入进度"></progress><div id="pdfImportActivity" class="pdf-import-activity" role="status" aria-live="polite"></div>' +
      '<details id="pdfImportHistory" class="pdf-import-history hidden"><summary>最近导入结果</summary><pre id="pdfImportHistoryText"></pre></details></div>' +
      '<div class="pdf-import-footer"><button id="pdfImportLater" class="button secondary" type="button">收起，稍后继续</button><button id="pdfImportStart" class="button accent" type="button" disabled>开始导入</button></div>';
    document.body.appendChild(panel);
    $('pdfImportClose').onclick = $('pdfImportLater').onclick = function () { panel.close(); };
    panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); panel.close(); } });
    $('pdfImportAdd').onclick = selectFiles;
    $('pdfImportClear').onclick = function () { if (!entries.some(function (entry) { return entry.status === 'queued' || entry.status === 'importing'; })) { entries = []; render(); } };
    $('pdfImportStart').onclick = function () { enqueue(available(), 'manual'); };
  }
  function fileDrag(event) { return event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf('Files') >= 0; }
  function inAi(event) { return event.target && event.target.closest && event.target.closest('#aiPanel'); }
  function hideDrop() { dragDepth = 0; overlay.classList.add('hidden'); document.body.classList.remove('pdf-file-dragging'); }
  function showDrop() { overlay.classList.remove('hidden'); document.body.classList.add('pdf-file-dragging'); }
  window.LiteraturePdfImport = { mount: function (config) {
    options = config; button = $('importPdfs'); picker = $('importPdfFiles');
    button.onclick = function () { show(); if (!entries.length && !running && !history.length) selectFiles(); };
    picker.onchange = function () {
      var files = Array.from(this.files || []); this.value = ''; if (!files.length) return;
      var added = createEntries(files, '第 ' + (++selectionRound) + ' 次选取');
      entries = entries.concat(added); show();
    };
    overlay = document.createElement('div'); overlay.className = 'pdf-drop-overlay hidden'; overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = '<div><strong>松开 PDF，直接导入论文库</strong><span>支持多份文件 · 自动复制，原文件保留</span></div>';
    document.body.appendChild(overlay);
    document.addEventListener('dragenter', function (e) { if (!fileDrag(e) || inAi(e)) return; e.preventDefault(); dragDepth++; showDrop(); });
    document.addEventListener('dragover', function (e) {
      if (!fileDrag(e)) return;
      if (inAi(e)) { hideDrop(); return; }
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; showDrop();
    });
    document.addEventListener('dragleave', function (e) { if (!fileDrag(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hideDrop(); });
    document.addEventListener('dragend', hideDrop);
    document.addEventListener('drop', function (e) {
      hideDrop(); if (!fileDrag(e) || inAi(e)) return;
      e.preventDefault();
      var files = Array.from(e.dataTransfer.files || []), added = createEntries(files, '直接拖入');
      if (added.length) { options.toast(running ? '已接收 ' + added.length + ' 份 PDF，按顺序自动导入。' : '正在自动导入 ' + added.length + ' 份 PDF…'); enqueue(added, 'drop'); }
    });
    window.addEventListener('blur', hideDrop);
    window.addEventListener('beforeunload', function (e) { if (running || available().length) { e.preventDefault(); e.returnValue = ''; } });
  } };
})();
