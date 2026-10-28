(function () {
  'use strict';
  var options, dialog, records = [], selected = new Set(), rootKey = '', busy = false, jobId = '', timer;
  var nameEdited = false, nameTags = [], operation = 0;
  function updateAutomaticName() {
    if (!nameEdited) $('materialName').value = nameTags.length ? Array.from(nameTags.join('、')).slice(0, 80).join('') : '阅读资料';
  }
  function $(id) { return document.getElementById(id); }
  async function api(path, body) {
    var response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var value = await response.json(); if (!response.ok) throw new Error(value.error || '请求失败'); return value;
  }
  function status(text) { $('materialStatus').textContent = text; }
  function setBusy(value) {
    busy = value; dialog.setAttribute('aria-busy', String(value));
    dialog.querySelectorAll('[data-export-control]').forEach(function (control) { control.disabled = value; });
    $('materialClose').disabled = value; $('materialStart').disabled = value || !selected.size;
  }
  function visible() {
    var query = $('materialSearch').value.trim().toLocaleLowerCase();
    return records.filter(function (record) { return !query || [record.title, record.path].concat(record.tags || []).join(' ').toLocaleLowerCase().indexOf(query) >= 0; });
  }
  function count() {
    $('materialCount').textContent = '已选 ' + selected.size + ' / ' + records.length + ' 篇 · 当前显示 ' + visible().length + ' 篇';
    $('materialStart').disabled = busy || !selected.size;
    $('materialStart').textContent = selected.size ? '选择位置并导出（' + selected.size + '）' : '选择位置并导出';
  }
  function render() {
    var list = $('materialList'); list.replaceChildren();
    visible().forEach(function (record) {
      var label = document.createElement('label'); label.className = 'material-paper';
      var box = document.createElement('input'); box.type = 'checkbox'; box.checked = selected.has(record.path); box.disabled = busy; box.dataset.exportControl = '';
      box.onchange = function () { if (box.checked) selected.add(record.path); else selected.delete(record.path); count(); };
      var text = document.createElement('span'), title = document.createElement('strong'), meta = document.createElement('small'), path = document.createElement('small');
      title.textContent = record.title;
      meta.textContent = [record.hasMarkdown ? 'PDF + Markdown' : '仅 PDF', record.hasNote ? '有整篇笔记' : '无整篇笔记', record.annotations + ' 条批注', record.hasCitation ? '有引用信息' : '未保存引用'].join(' · ');
      path.textContent = (record.tags || []).map(function (tag) { return '#' + tag; }).join(' ') + ((record.tags || []).length ? ' · ' : '') + record.path;
      text.appendChild(title); text.appendChild(meta); text.appendChild(path);
      if ((record.warnings || []).length) { var warning = document.createElement('small'); warning.className = 'material-warning'; warning.textContent = record.warnings.join('；'); text.appendChild(warning); }
      label.appendChild(box); label.appendChild(text); list.appendChild(label);
    });
    if (!list.children.length) { var empty = document.createElement('p'); empty.className = 'attachment-hint'; empty.textContent = records.length ? '没有匹配的论文。' : '当前论文库没有可导出的论文。'; list.appendChild(empty); }
    count();
  }
  async function load() {
    var token = ++operation; clearTimeout(timer);
    $('materialProgress').classList.add('hidden'); $('materialWarnings').textContent = '';
    setBusy(true); status('正在只读读取论文与标签…');
    try {
      var data = await api('/api/material-export/papers'); if (token !== operation) return;
      rootKey = data.rootKey; records = data.papers || [];
      selected = new Set(Array.from(selected).filter(function (path) { return records.some(function (record) { return record.path === path; }); }));
      nameTags = nameTags.filter(function (tag) { return records.some(function (record) { return selected.has(record.path) && (record.tags || []).indexOf(tag) >= 0; }); }); updateAutomaticName();
      var tags = new Set(); records.forEach(function (record) { (record.tags || []).forEach(function (tag) { tags.add(tag); }); });
      $('materialTag').replaceChildren(); var initial = document.createElement('option'); initial.value = ''; initial.textContent = '选择标签，追加勾选相关论文'; $('materialTag').appendChild(initial);
      Array.from(tags).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }).forEach(function (tag) { var option = document.createElement('option'); option.value = tag; option.textContent = tag; $('materialTag').appendChild(option); });
      status((data.warnings || []).length ? '已读取 ' + records.length + ' 篇。扫描说明：' + data.warnings.join('；') : '选择标签或手动勾选论文。导出只复制资料，不修改原始文件和阅读记录。');
    } catch (e) { if (token !== operation) return; rootKey = ''; records = []; selected.clear(); status(e.message); }
    finally { if (token === operation) { setBusy(false); render(); } }
  }
  async function poll(id, token) {
    if (id !== jobId || token !== operation) return;
    try {
      var job = await api('/api/material-export/status?id=' + encodeURIComponent(id));
      if (id !== jobId || token !== operation) return;
      $('materialProgress').max = job.total || 1; $('materialProgress').value = job.completed;
      status(job.message + '\n进度：' + job.completed + ' / ' + job.total + (job.destination ? '\n目录：' + job.destination : ''));
      $('materialWarnings').textContent = job.warnings && job.warnings.length ? '说明 / 缺失资源（也会写入资料包）：\n' + job.warnings.join('\n') : '';
      if (job.state === 'running') { timer = setTimeout(function () { poll(id, token); }, 800); return; }
      setBusy(false); $('materialOpenFolder').classList.remove('hidden');
      if (job.state === 'complete') status('导出完成：' + job.total + ' 篇。可以在外部 Codex 中打开这个目录。\n' + job.destination + ((job.warnings || []).length ? '\n请先查看目录内“导出说明与缺失资源.md”。' : ''));
    } catch (e) {
      if (id !== jobId || token !== operation) return;
      status('暂时无法获取进度：' + e.message + '\n任务可能仍在后台执行，请保持窗口打开，正在重试…');
      timer = setTimeout(function () { poll(id, token); }, 2000);
    }
  }
  async function start() {
    if (busy || !selected.size || !rootKey) return;
    var token = ++operation; clearTimeout(timer);
    var current = options.current ? options.current() : null;
    setBusy(true); $('materialOpenFolder').classList.add('hidden'); $('materialWarnings').textContent = ''; $('materialProgress').classList.add('hidden');
    status('请选择导出位置，程序会在其中新建资料文件夹。不会覆盖已有目录。');
    try {
      var result = await api('/api/material-export/start', { rootKey: rootKey, papers: Array.from(selected), name: $('materialName').value.trim() || '阅读资料', current: current, includeChats: $('materialIncludeChats').checked });
      if (result.cancelled) { setBusy(false); status('已取消选择位置，未开始导出。'); return; }
      jobId = result.id; $('materialProgress').classList.remove('hidden'); $('materialProgress').value = 0;
      poll(jobId, token);
    } catch (e) { setBusy(false); status('未能开始导出：' + e.message); }
  }
  function init() {
    dialog = document.createElement('dialog'); dialog.className = 'material-export-dialog'; dialog.setAttribute('aria-label', '导出阅读资料');
    dialog.innerHTML = '<div class="material-export-heading"><div><strong>导出阅读资料</strong><small>给外部 AI 工作区、调研与写作使用</small></div><button id="materialClose" class="plain-icon" type="button" aria-label="关闭">×</button></div>' +
      '<div class="material-export-body"><p class="attachment-hint">只读原资料，始终新建副本。包含 PDF、已有 Markdown 与相关图片、整篇笔记、已保存批注/译文、阅读记录及已有引用；AI 对话可选导出，未保存批注草稿、视频、ZIP 或未选择的关联材料不自动打包。</p>' +
      '<label class="material-name">资料包名称<input id="materialName" data-export-control maxlength="80" placeholder="例如：灵巧手触觉调研" value="阅读资料"></label>' +
      '<label class="material-chat-option"><input id="materialIncludeChats" data-export-control type="checkbox"><span><strong>包含关联 AI 对话</strong><small>按论文目录与已保存关联读取本机 Codex 历史，生成可独立阅读的 Markdown；不发送消息，缺失历史不影响其他资料导出。</small></span></label>' +
      '<div class="material-export-tools"><select id="materialTag" data-export-control aria-label="按标签追加勾选"><option value="">选择标签，追加勾选相关论文</option></select><button id="materialRefresh" data-export-control type="button" class="button secondary">刷新列表</button></div>' +
      '<input id="materialSearch" data-export-control type="search" class="material-search" placeholder="搜索标题、标签或目录；搜索不清空已有勾选" aria-label="搜索待导出的论文">' +
      '<div class="material-export-select"><span id="materialCount"></span><button id="materialSelectVisible" data-export-control type="button">勾选当前列表</button><button id="materialClear" data-export-control type="button">清空勾选</button></div>' +
      '<div id="materialList" class="material-export-list"></div><p class="attachment-hint">选择标签会追加勾选，也可搜索后继续添加其他文章。当前打开论文的笔记和记录会取本次窗口内快照；导出不会触发保存或改写原记录。缺失文件和无法转换的链接会列入说明。</p>' +
      '<progress id="materialProgress" class="hidden" value="0" max="1" aria-label="导出进度"></progress><div id="materialStatus" class="material-export-status" role="status" aria-live="polite"></div><pre id="materialWarnings" class="material-export-warnings"></pre>' +
      '</div><div class="material-export-footer"><button id="materialOpenFolder" class="button secondary hidden" type="button">打开导出目录</button><button id="materialStart" class="button accent" type="button" disabled>选择位置并导出</button></div>';
    document.body.appendChild(dialog);
    dialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault(); });
    $('materialClose').onclick = function () { if (!busy) dialog.close(); };
    $('materialSearch').oninput = render;
    $('materialName').oninput = function () { nameEdited = !!this.value.trim(); };
    $('materialTag').onchange = function () {
      var tag = this.value; if (!tag) return;
      records.forEach(function (record) { if ((record.tags || []).some(function (value) { return value.toLocaleLowerCase() === tag.toLocaleLowerCase(); })) selected.add(record.path); });
      if (nameTags.indexOf(tag) < 0) nameTags.push(tag);
      updateAutomaticName();
      this.value = ''; render(); status('已追加勾选标签“' + tag + '”下的论文，可继续添加或取消个别条目。');
    };
    $('materialSelectVisible').onclick = function () { visible().forEach(function (record) { selected.add(record.path); }); render(); };
    $('materialClear').onclick = function () { selected.clear(); nameTags = []; updateAutomaticName(); render(); };
    $('materialRefresh').onclick = load;
    $('materialStart').onclick = start;
    $('materialOpenFolder').onclick = async function () { try { await api('/api/material-export/open', { id: jobId }); } catch (e) { status(e.message); } };
  }
  window.LiteratureMaterialExport = { mount: function (config) {
    options = config;
    $('openMaterialExport').onclick = function () {
      if (!dialog) init(); if (dialog.open) return;
      dialog.showModal(); if (!busy) load();
    };
  } };
})();
