(function () {
  'use strict';
  // Parse one self-contained entry; reject unsupported macros rather than corrupting them.
  function parseBib(text) {
    var s = String(text).trim(), h = /^@([a-z]+)\s*\{\s*([A-Za-z0-9_:.+-]+)\s*,/i.exec(s);
    if (!h || /^(string|comment|preamble)$/i.test(h[1])) throw new Error('请提供一条完整文献，格式为 @article{引用键, ...}。');
    var i = h[0].length, fields = {}, closed = false;
    function space() { while (/\s/.test(s.charAt(i)) && i < s.length) i++; }
    while (i < s.length) {
      space();
      if (s[i] === '}') { i++; closed = true; break; }
      if (s[i] === ',') { i++; continue; }
      var f = /^([a-z][a-z0-9_-]*)\s*=\s*/i.exec(s.slice(i));
      if (!f) throw new Error('无法读取文献字段，请检查逗号、等号和括号。');
      i += f[0].length;
      var value = '', start, depth, quote;
      if (s[i] === '{' || s[i] === '"') {
        quote = s[i++] === '"'; start = i; depth = 1;
        while (i < s.length) {
          if (s[i] === '\\') { i += 2; continue; }
          if (s[i] === '{') depth++;
          if (s[i] === '}') { if (!quote || depth > 1) depth--; }
          if ((quote && s[i] === '"' && depth === 1) || (!quote && depth === 0)) break;
          i++;
        }
        if (i >= s.length) throw new Error('字段的括号或引号没有闭合。');
        value = s.slice(start, i++);
      } else {
        var num = /^\d+/.exec(s.slice(i));
        if (!num) {
          var month = /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?=\s*[,}])/i.exec(s.slice(i));
          if (f[1].toLowerCase() !== 'month' || !month) throw new Error('暂不支持自定义 BibTeX 宏或字符串拼接，请先导出为独立、完整的条目。');
          value = month[0]; i += value.length;
        } else { value = num[0]; i += value.length; }
      }
      space();
      if (s[i] !== ',' && s[i] !== '}') throw new Error('字段之间缺少逗号，或使用了暂不支持的字符串拼接。');
      if (Object.prototype.hasOwnProperty.call(fields, f[1].toLowerCase())) throw new Error('文献包含重复字段：' + f[1]);
      fields[f[1].toLowerCase()] = value;
    }
    if (!closed || s.slice(i).trim()) throw new Error('每篇论文请只导入一条文献，且检查末尾括号。');
    if (!fields.title) throw new Error('文献缺少 title（标题）字段。');
    return { type: h[1].toLowerCase(), key: h[2], fields: fields };
  }
  function serialize(entry, mode) {
    var f = Object.assign({}, entry.fields), type = entry.type;
    if (mode === 'biblatex') {
      if (f.month && /^[a-z]/i.test(f.month)) {
        var monthIndex = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(f.month.slice(0, 3).toLowerCase());
        if (monthIndex >= 0) f.month = String(monthIndex + 1);
      }
      if (f.journal && !f.journaltitle) { f.journaltitle = f.journal; delete f.journal; }
      if (f.address && !f.location) { f.location = f.address; delete f.address; }
    } else {
      if (f.journaltitle && !f.journal) { f.journal = f.journaltitle; delete f.journaltitle; }
      if (f.location && !f.address) { f.address = f.location; delete f.location; }
      if (f.date && !f.year && /^\d{4}/.test(f.date)) f.year = f.date.slice(0, 4);
      if (type === 'online') type = 'misc';
    }
    return '@' + type + '{' + entry.key + ',\n' + Object.keys(f).map(function (k) { return '  ' + k + ' = {' + f[k] + '}'; }).join(',\n') + '\n}\n';
  }
  function readableCitationKey(fields) {
    function ascii(value) { return String(value || '').replace(/\\[a-zA-Z]+/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]/g, ' '); }
    function cap(word) { return word.charAt(0).toUpperCase() + word.slice(1); }
    var ignored = new Set('a an the of on in for to and or with by from as at into via is are be its this that using based toward towards study design approach method'.split(' '));
    function words(value) { return ascii(value).split(/ +/).filter(function (word) { return word && !ignored.has(word.toLowerCase()); }); }
    var first = String(fields.author || '').split(/\s+and\s+|;/i)[0].trim().replace(/[{}]/g, '');
    var family = first.indexOf(',') >= 0 ? first.split(',')[0] : first.split(/\s+/).pop();
    var surname = ascii(family).split(/ +/).filter(Boolean).map(cap).join('') || 'Anon';
    var year = /(?:19|20)\d{2}/.exec(fields.year || fields.date || '');
    var title = String(fields.title || ''), keywords = words(title), colon = title.indexOf(':');
    if (colon > 0) { var name = words(title.slice(0, colon)); if (name.length && name.length <= 3) keywords = name; }
    return surname.slice(0, 32) + (year ? year[0] : 'Nd') + (keywords.slice(0, 3).map(cap).join('') || 'Paper').slice(0, 36);
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { parse: parseBib, serialize: serialize, makeKey: readableCitationKey }; return; }
  var dialog, activePaper, savedBib = '', baselineBib = '', baselineKey = '', busy = false;
  var savedKey = '', previousBib = '', previousKey = '';
  var recognizeCurrentCitation = null;
  var keyGenerated = true;
  var citationRecords = [];
  var windowPosition = null;
  function positionCitationWindow(left, top) {
    var rect = dialog.getBoundingClientRect(), gap = 8;
    left = Math.max(gap, Math.min(left, window.innerWidth - rect.width - gap));
    top = Math.max(gap, Math.min(top, window.innerHeight - Math.min(rect.height, window.innerHeight * 0.88) - gap));
    dialog.style.left = Math.round(left) + 'px';
    dialog.style.top = Math.round(top) + 'px';
    dialog.style.maxHeight = Math.floor(Math.min(window.innerHeight * 0.88, window.innerHeight - top - gap)) + 'px';
    windowPosition = { left: left, top: top };
  }
  function centerCitationWindow() {
    positionCitationWindow((window.innerWidth - dialog.getBoundingClientRect().width) / 2, window.innerHeight * 0.06);
  }
  function enableCitationDragging() {
    var heading = dialog.querySelector('.dialog-heading'), drag = null;
    heading.title = '按住标题栏拖动；双击标题栏回到中央';
    heading.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      var rect = dialog.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
      heading.setPointerCapture(e.pointerId);
      dialog.classList.add('citation-dragging'); e.preventDefault();
    });
    heading.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      positionCitationWindow(drag.left + e.clientX - drag.x, drag.top + e.clientY - drag.y);
    });
    function endDrag(e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null; dialog.classList.remove('citation-dragging');
      if (heading.hasPointerCapture(e.pointerId)) heading.releasePointerCapture(e.pointerId);
    }
    heading.addEventListener('pointerup', endDrag);
    heading.addEventListener('pointercancel', endDrag);
    heading.addEventListener('lostpointercapture', endDrag);
    heading.addEventListener('dblclick', function (e) { if (!e.target.closest('button')) centerCitationWindow(); });
    window.addEventListener('resize', function () {
      if (dialog.open && windowPosition) positionCitationWindow(windowPosition.left, windowPosition.top);
    });
    // Modeless windows allow scrolling the PDF while checking bibliographic details.
    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); $('citeClose').click(); }
    });
  }
  function changed() { return $('citeBib').value !== baselineBib || $('citeKey').value !== baselineKey; }
  function $(id) { return document.getElementById(id); }
  function message(text) { $('citeStatus').textContent = text; }
  function api(url, body) {
    return fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (v) { if (!r.ok) throw new Error(v.error || '请求失败'); return v; }); });
  }
  function run(action) {
    if (busy) return;
    busy = true; dialog.querySelectorAll('button[data-work]').forEach(function (b) { b.disabled = true; });
    return Promise.resolve().then(action).catch(function (e) { message(e.message); }).finally(function () {
      busy = false; dialog.querySelectorAll('button[data-work]').forEach(function (b) { b.disabled = false; });
    });
  }
  function download(text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'application/x-bibtex;charset=utf-8' }));
    var a = document.createElement('a'); a.href = url; a.download = 'references.bib'; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }
  function preview() {
    try {
      var e = parseBib($('citeBib').value);
      $('citePreview').textContent = [e.fields.title, e.fields.author, e.fields.year || e.fields.date, e.fields.journal || e.fields.journaltitle, e.fields.eprint ? 'arXiv: ' + e.fields.eprint : '', e.fields.note].filter(Boolean).join('\n');
      return e;
    } catch (err) { $('citePreview').textContent = err.message; throw err; }
  }
  function current() {
    var e = preview(), key = $('citeKey').value.trim();
    if (!/^[A-Za-z0-9_:.+-]+$/.test(key)) throw new Error('引用键请使用字母、数字、下划线、冒号、点或短横线。');
    e.key = key; return e;
  }
  function accept(text, preserveImportedKey) {
    var e = parseBib(text);
    $('citeBib').value = text;
    // A previously saved key must survive metadata refreshes.
    if (!savedBib) {
      if (preserveImportedKey) { $('citeKey').value = e.key; keyGenerated = false; }
      else if (keyGenerated) { e.key = readableCitationKey(e.fields); $('citeKey').value = e.key; $('citeBib').value = serialize(e); }
    }
    preview();
  }
  function renderSavedResult() {
    $('citeSavedResult').classList.toggle('hidden', !savedBib);
    $('citeUndo').classList.toggle('hidden', !previousBib);
    if (!savedBib) { $('citeSavedSummary').textContent = ''; return; }
    try {
      var fields = parseBib(savedBib).fields;
      $('citeSavedSummary').textContent = [fields.title, fields.year || fields.date, fields.doi, fields.eprint ? 'arXiv: ' + fields.eprint : '', '引用键：' + savedKey].filter(Boolean).join(' · ');
    } catch (_) { $('citeSavedSummary').textContent = '引用键：' + savedKey; }
  }
  function applySavedRecord(record) {
    savedBib = record.bib || ''; savedKey = record.key || '';
    previousBib = record.previousBib || ''; previousKey = record.previousKey || '';
    keyGenerated = !savedBib; $('citeBib').value = savedBib; $('citeKey').value = savedKey;
    if (savedBib) $('citeTitle').value = preview().fields.title.replace(/[{}]/g, '');
    baselineBib = $('citeBib').value; baselineKey = $('citeKey').value;
    citationRecords.forEach(function (r) { if (r.paper === activePaper) { r.key = savedKey; r.bib = savedBib; } });
    $('citeLibrary').querySelectorAll('input[type=checkbox]').forEach(function (box) {
      if (box.dataset.paper === activePaper) {
        box.dataset.bib = savedBib;
        var title; try { title = parseBib(savedBib).fields.title; } catch (_) { title = activePaper; }
        box.parentElement.lastChild.textContent = savedKey + ' — ' + title;
      }
    });
    renderSavedResult();
  }
  function save() {
    if (!savedBib && keyGenerated) $('citeKey').value = readableCitationKey(preview().fields);
    var e = current(), bib = serialize(e);
    return api('/api/citation', { paper: activePaper, bib: bib, key: e.key, autoKey: !savedBib && keyGenerated }).then(function (result) {
      applySavedRecord(result); e.key = savedKey;
      message(previousBib ? '已保存。覆盖前的上一版可通过“撤销上次覆盖保存”恢复。' : '已保存，可直接复制引用或导出。'); return e;
    });
  }
  function init() {
    dialog = document.createElement('dialog'); dialog.className = 'citation-dialog';
    dialog.setAttribute('aria-label', 'LaTeX 引用');
    dialog.innerHTML = '<div class="dialog-heading"><strong>LaTeX 引用 <small class="citation-drag-hint">按住这里拖动</small></strong><button id="citeClose" class="plain-icon" aria-label="关闭">×</button></div>' +
      '<details id="citeManual"><summary>手动查询或修正（自动识别不确定时使用）</summary><div class="citation-row"><input id="citeDoi" aria-label="DOI 或 arXiv 编号" placeholder="DOI、arXiv 编号或文章链接"><button id="citeLookup" data-work class="button secondary">查询编号</button></div>' +
      '<div class="citation-row"><input id="citeTitle" aria-label="论文标题或标题加作者" placeholder="没有 DOI？输入或修改论文标题"><select id="citeSearchSource" aria-label="检索来源"><option value="crossref">期刊 / 会议（Crossref）</option><option value="arxiv">arXiv 预印本</option><option value="all">两个来源</option></select><button id="citeSearch" data-work class="button secondary">按标题检索</button></div></details><div id="citeSavedResult" class="citation-result hidden"><strong>当前已保存的结果</strong><p id="citeSavedSummary"></p><div class="citation-row"><button id="citeUseSaved" data-work class="button secondary">选回已保存结果</button><button id="citeUndo" data-work class="button secondary hidden">撤销上次覆盖保存</button></div></div><div id="citeCandidates"></div><div id="citeStatus" class="citation-status" role="status"></div><div id="citeResults"></div>' +
      '<div class="citation-row"><label>引用键 <input id="citeKey" placeholder="例如 wang2025softhand"></label><button id="citeImport" data-work class="button secondary">导入单条 .bib</button><input id="citeFile" type="file" accept=".bib,text/plain" hidden></div>' +
      '<pre id="citePreview" class="citation-preview"></pre><details><summary>文献数据（高级：粘贴或编辑 BibTeX / BibLaTeX）</summary><textarea id="citeBib" spellcheck="false" aria-label="文献数据"></textarea></details>' +
      '<div class="citation-row"><label>导出方式 <select id="citeMode"><option value="bibtex">BibTeX（传统期刊模板）</option><option value="biblatex">BibLaTeX</option></select></label><label>引用命令 <select id="citeCommand"><option value="cite">\\cite</option><option value="citet">\\citet（natbib）</option><option value="citep">\\citep（natbib）</option><option value="textcite">\\textcite（biblatex）</option><option value="parencite">\\parencite（biblatex）</option></select></label></div>' +
      '<p class="attachment-hint">导出方式只影响 .bib 文件；引用命令只影响复制的正文命令。切换选项不会修改已保存信息。导出当前文献会先保存当前编辑。</p>' +
      '<div class="dialog-actions"><button id="citeSave" data-work class="button accent">保存信息</button><button id="citeCopy" data-work class="button secondary">保存并复制引用</button><button id="citeExport" data-work class="button secondary">保存并导出当前文献</button></div>' +
      '<details><summary>选择已保存的文献，导出 references.bib</summary><button id="citeRefresh" data-work class="button secondary">读取已保存文献</button><div class="citation-row"><label>按标签选择 <select id="citeTag" disabled><option value="">全部已保存文献</option></select></label><button id="citeSelectAll" data-work class="button secondary">全选当前列表</button><button id="citeSelectNone" data-work class="button secondary">取消全选</button></div><p class="attachment-hint">选择标签后，自动勾选该标签下已保存的文献，仍可取消个别条目。切换标签会重新选择；未保存书目信息的论文需先识别后再读取。</p><div id="citeLibraryStatus" class="citation-status" role="status"></div><div id="citeLibrary"></div><button id="citeExportSelected" data-work class="button accent">导出勾选文献</button></details>' +
      '<p class="attachment-hint">把 references.bib 放进本地 LaTeX 项目或上传到 Overleaf，再把引用命令粘贴进正文。citet / citep 需要 natbib；textcite / parencite 需要 biblatex。首次保存后引用键固定，手动修改已使用的键时，也需修改正文。</p>';
    document.body.appendChild(dialog);
    enableCitationDragging();
    dialog.addEventListener('cancel', function (e) { if (busy) e.preventDefault(); else if (changed() && !confirm('关闭并放弃未保存的文献信息？')) e.preventDefault(); });
    $('citeClose').onclick = function () { if (!busy && (!changed() || confirm('关闭并放弃未保存的文献信息？'))) dialog.close(); };
    $('citeUseSaved').onclick = function () {
      if (busy || !savedBib) return;
      applySavedRecord({ bib: savedBib, key: savedKey, previousBib: previousBib, previousKey: previousKey });
      $('citeResults').replaceChildren();
      message('已选回当前保存的结果，未保存的替换已放弃。');
    };
    $('citeUndo').onclick = function () {
      if (busy || !previousBib) return;
      if (changed() && !confirm('撤销会放弃当前未保存的编辑，并恢复覆盖前的上一版，继续？')) return;
      run(function () { return api('/api/citation/undo', { paper: activePaper }).then(function (record) {
        applySavedRecord(record); $('citeResults').replaceChildren(); $('citeCandidates').replaceChildren();
        message('已恢复并保存覆盖前的上一版文献信息和引用键。');
      }); });
    };
    $('citeKey').oninput = function () { keyGenerated = false; };
    $('citeBib').oninput = function () { try { preview(); } catch (_) {} };
    function lookup(value) {
      message('正在查询文献编号…');
      return api('/api/citation/lookup', { doi: value }).then(function (r) {
        accept(r.bib); message('已取得文献信息，请核对标题、作者与版本，再点“保存信息”。');
      });
    }
    function renderMatches(matches) {
      matches.forEach(function (m) {
          var card = document.createElement('div'); card.className = 'citation-result';
          var heading = document.createElement('strong'); heading.textContent = m.title; card.appendChild(heading);
          var detail = document.createElement('p'); detail.textContent = [m.authors, m.year, m.venue, m.source, m.arxiv ? 'arXiv: ' + m.arxiv : m.doi].filter(Boolean).join(' · '); card.appendChild(detail);
          var b = document.createElement('button'); b.className = 'button secondary'; b.textContent = '选用此条，待核对保存';
          b.onclick = function () { if (busy) return; try { accept(m.bib); $('citeResults').replaceChildren(); message('已选用 ' + m.source + ' 结果，请核对标题、作者、年份与版本，再保存。'); $('citePreview').scrollIntoView({block:'nearest'}); } catch(e) { message(e.message); } };
          card.appendChild(b); $('citeResults').appendChild(card);
        });
    }
    function searchTitle() {
      var query = $('citeTitle').value.trim();
      if (query.length < 4) throw new Error('请先输入论文标题；自动识别可在关闭窗口后重新打开重试。');
      message('正在按标题检索…'); $('citeResults').replaceChildren();
      return api('/api/citation/search', { query: query, source: $('citeSearchSource').value }).then(function (r) {
        message((r.warning ? r.warning + '\n' : '') + (r.matches.length ? r.hint : '没有找到结果。可缩短标题重试、切换 arXiv 来源，或导入 BibTeX。'));
        renderMatches(r.matches);
      });
    }
    $('citeLookup').onclick = function () { run(function () { return lookup($('citeDoi').value); }); };
    $('citeSearch').onclick = function () { run(searchTitle); };
    $('citeTitle').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); $('citeSearch').click(); } };
    recognizeCurrentCitation = function () {
      if (savedBib) { message('这篇论文已有保存的信息，可直接复制引用或导出。如需修正，可使用编号查询、标题检索或编辑文献数据。'); return; }
      if (changed() && !confirm('识别结果可能替换当前未保存的编辑，继续识别？')) return;
      run(function () {
        $('citeBib').disabled = true; $('citeKey').disabled = true;
        message('正在识别、核对文献信息，匹配充分时会自动保存…'); $('citeCandidates').replaceChildren(); $('citeResults').replaceChildren();
        return api('/api/citation/recognize', { paper: activePaper }).then(function (r) {
          if (r.title) $('citeTitle').value = r.title;
          if (r.status === 'saved' || r.status === 'existing') {
            $('citeManual').open = false;
            applySavedRecord(r);
            if (!r.title) $('citeTitle').value = preview().fields.title.replace(/[{}]/g, '');
          } else {
            $('citeManual').open = true;
            (r.candidates || []).forEach(function (c) {
              var b = document.createElement('button'); b.className = 'button secondary citation-candidate';
              b.textContent = (c.kind === 'arxiv' ? 'arXiv: ' : 'DOI: ') + c.doi + ' · ' + c.source; b.title = c.evidence;
              b.onclick = function () { $('citeDoi').value = c.kind === 'arxiv' ? 'arXiv:' + c.doi : c.doi; $('citeLookup').click(); };
              $('citeCandidates').appendChild(b);
            });
            renderMatches(r.matches || []);
          }
          message(r.reason + (r.warning ? '\n' + r.warning : ''));
        }).finally(function () { $('citeBib').disabled = false; $('citeKey').disabled = false; });
      });
    };
    $('citeImport').onclick = function () { $('citeFile').click(); };
    $('citeFile').onchange = function () {
      var file = this.files[0]; this.value = ''; if (!file) return;
      run(function () { if (file.size > 131072) throw new Error('请选择小于 128 KB、只包含一条文献的 .bib 文件。');
        return file.text().then(function (text) { accept(text, true); message('已导入，请核对后保存。'); }); });
    };
    $('citeSave').onclick = function () { run(save); };
    $('citeCopy').onclick = function () { run(function () { return save().then(function (e) {
      var command = '\\' + $('citeCommand').value + '{' + e.key + '}';
      return navigator.clipboard.writeText(command).then(function () { message('已复制：' + command); }).catch(function () { message('复制失败，请手动复制：' + command); });
    }); }); };
    $('citeExport').onclick = function () { run(function () { return save().then(function (e) { download(serialize(e, $('citeMode').value)); }); }); };
    function renderCitationLibrary(selectTag) {
      var tag = $('citeTag').value;
      var records = citationRecords.filter(function (r) {
        return !tag || (r.tags || []).some(function (t) { return t.toLocaleLowerCase() === tag.toLocaleLowerCase(); });
      });
      $('citeLibrary').replaceChildren();
      records.forEach(function (r) {
        var label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.dataset.bib = r.bib; box.dataset.paper = r.paper;
        box.checked = !!selectTag && !!tag;
        label.className = 'citation-choice'; label.appendChild(box);
        var title; try { title = parseBib(r.bib).fields.title; } catch (_) { title = r.paper; }
        label.appendChild(document.createTextNode(r.key + ' — ' + title)); $('citeLibrary').appendChild(label);
      });
      $('citeLibraryStatus').textContent = tag ? '标签“' + tag + '”：' + records.length + ' 条已保存文献，已全部勾选，可按需取消。' : '已读取 ' + records.length + ' 条文献，可按标签选择或手动勾选。';
    }
    $('citeRefresh').onclick = function () { run(function () {
      return api('/api/citations').then(function (records) {
        citationRecords = records;
        var previous = $('citeTag').value, tags = new Map();
        records.forEach(function (r) { (r.tags || []).forEach(function (tag) { tags.set(tag.toLocaleLowerCase(), tag); }); });
        $('citeTag').replaceChildren();
        var all = document.createElement('option'); all.value = ''; all.textContent = '全部已保存文献'; $('citeTag').appendChild(all);
        Array.from(tags.values()).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); }).forEach(function (tag) {
          var option = document.createElement('option'); option.value = tag; option.textContent = tag; $('citeTag').appendChild(option);
        });
        $('citeTag').disabled = false;
        if (Array.from(tags.values()).indexOf(previous) >= 0) $('citeTag').value = previous;
        renderCitationLibrary(true);
      });
    }); };
    $('citeTag').onchange = function () { renderCitationLibrary(true); };
    $('citeSelectAll').onclick = function () {
      $('citeLibrary').querySelectorAll('input[type=checkbox]').forEach(function (box) { box.checked = true; });
      $('citeLibraryStatus').textContent = '已全选当前列表。';
    };
    $('citeSelectNone').onclick = function () {
      $('citeLibrary').querySelectorAll('input[type=checkbox]').forEach(function (box) { box.checked = false; });
      $('citeLibraryStatus').textContent = '已取消当前列表的全部勾选。';
    };
    $('citeExportSelected').onclick = function () { run(function () {
      var checked = Array.from($('citeLibrary').querySelectorAll('input:checked'));
      if (!checked.length) throw new Error('请先读取并勾选要导出的文献。');
      download(checked.map(function (box) { return serialize(parseBib(box.dataset.bib), $('citeMode').value); }).join('\n'));
      $('citeLibraryStatus').textContent = '已导出 ' + checked.length + ' 条文献。';
    }); };
  }
  window.LiteratureCitations = { open: function (paper) {
    if (!dialog) init(); if (busy) return;
    if (dialog.open) {
      if (activePaper === paper) { $('citeClose').focus(); return; }
      if (changed() && !confirm('切换论文并放弃未保存的文献信息？')) return;
    }
    $('citeManual').open = false;
    citationRecords = []; $('citeTag').replaceChildren();
    var allTags = document.createElement('option'); allTags.value = ''; allTags.textContent = '全部已保存文献'; $('citeTag').appendChild(allTags); $('citeTag').disabled = true;
    activePaper = paper; savedBib = ''; savedKey = ''; previousBib = ''; previousKey = ''; renderSavedResult(); $('citeBib').value = ''; $('citeKey').value = ''; $('citeDoi').value = '';
    $('citePreview').textContent = ''; $('citeCandidates').replaceChildren(); $('citeResults').replaceChildren(); $('citeLibrary').replaceChildren(); $('citeLibraryStatus').textContent = ''; $('citeTitle').value = ''; $('citeSearchSource').value = 'crossref';
    if (!dialog.open) dialog.show();
    if (windowPosition) positionCitationWindow(windowPosition.left, windowPosition.top);
    else centerCitationWindow();
    var loaded = false;
    run(function () { message('正在读取文献信息…'); return api('/api/citation?paper=' + encodeURIComponent(paper)).then(function (r) {
      applySavedRecord(r); loaded = true;
      if (!savedBib) { $('citeBib').value = '@article{paper2026,\n  title = {},\n  author = {},\n  year = {},\n  journal = {}\n}'; $('citeKey').value = 'paper2026'; }
      baselineBib = $('citeBib').value; baselineKey = $('citeKey').value;
      message(savedBib ? '已读取保存的信息，可直接复制引用或导出，无需重新识别。' : '正在准备自动识别，信息不充分时会请你选择；也可手动检索。');
    }); }).then(function () {
      if (loaded && !savedBib && dialog.open && activePaper === paper && !changed()) recognizeCurrentCitation();
    });
  } };
})();
