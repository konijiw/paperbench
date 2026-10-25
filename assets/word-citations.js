(function () {
  'use strict';
  var assetsPromise, host, parseBib, getCurrent, timer, revision = 0, output = null;
  var customStyle = '', customName = '';
  var presets = [
    ['gbt-numeric', '国标 GB/T 7714—2015（顺序编码）'],
    ['gbt-author-date', '国标 GB/T 7714—2015（著者—出版年）'],
    ['apa', 'APA 第 7 版'], ['ieee', 'IEEE'], ['nature', 'Nature'], ['science', 'Science']
  ];
  function $(id) { return document.getElementById(id); }
  function status(text) { $('wordStatus').textContent = text; }
  function loadAssets() {
    if (!assetsPromise) assetsPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script'); script.src = '/assets/csl-bundle.js';
      script.onload = function () { resolve(window.CitationStyleAssets); };
      script.onerror = function () { script.remove(); assetsPromise = null; reject(new Error('样式资源读取失败，请关闭后重试。')); };
      document.head.appendChild(script);
    });
    return assetsPromise;
  }
  function plain(value) {
    var accents = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', 'c': '\u0327', 'v': '\u030c', 'u': '\u0306', 'H': '\u030b' };
    var symbols = { ae:'æ', AE:'Æ', oe:'œ', OE:'Œ', aa:'å', AA:'Å', o:'ø', O:'Ø', ss:'ß', l:'ł', L:'Ł', LaTeX:'LaTeX', TeX:'TeX', textendash:'–', textemdash:'—', textquotedblleft:'“', textquotedblright:'”', alpha:'α', beta:'β', gamma:'γ', delta:'δ', mu:'μ' };
    return String(value || '')
      .replace(/\\(["'`^~=.cv uH])\s*\{?([A-Za-zı])\}?/g, function (_, accent, letter) { return letter.replace('ı', 'i') + (accents[accent] || ''); })
      .replace(/\\([A-Za-z]+)(?:\{\})?/g, function (_, name) { return Object.prototype.hasOwnProperty.call(symbols, name) ? symbols[name] : ''; })
      .replace(/\\([&%_#$ {}])/g, '$1').replace(/[{}]/g, '').replace(/~/g, ' ')
      .replace(/---/g, '—').replace(/--/g, '–').replace(/\s+/g, ' ').trim().normalize('NFC');
  }
  function splitNames(value) {
    // Braced organizations may contain the word "and".
    var names = [], start = 0, depth = 0, text = String(value || '');
    for (var i = 0; i < text.length; i++) {
      if (text[i] === '\\') { i++; continue; }
      if (text[i] === '{') depth++;
      if (text[i] === '}') depth--;
      var separator = !depth && /^\s+and\s+/i.exec(text.slice(i));
      if (separator) { names.push(text.slice(start, i)); i += separator[0].length - 1; start = i + 1; }
    }
    names.push(text.slice(start));
    return names.filter(function (name) { return name.trim(); }).map(function (name) {
      name = name.trim();
      if (name.toLowerCase() === 'others') return { literal: 'et al.' };
      if (name[0] === '{' && name[name.length - 1] === '}') return { literal: plain(name) };
      var parts = name.split(',').map(plain), result;
      if (parts.length > 1) { result = { family: parts[0], given: parts[parts.length - 1] }; if (parts.length > 2) result.suffix = parts[1]; }
      else {
        var words = plain(name).split(/\s+/), family = words.pop();
        while (words.length && /^(von|van|de|der|den|del|da|di|la|le)$/i.test(words[words.length - 1])) family = words.pop() + ' ' + family;
        result = { family: family, given: words.join(' ') };
      }
      return result;
    });
  }
  function itemFromBib(bib, id) {
    var entry = parseBib(bib), f = entry.fields;
    var types = { article:'article-journal', book:'book', booklet:'book', inproceedings:'paper-conference', conference:'paper-conference', proceedings:'book', incollection:'chapter', inbook:'chapter', phdthesis:'thesis', mastersthesis:'thesis', thesis:'thesis', techreport:'report', report:'report', online:'webpage', manual:'book', unpublished:'manuscript', misc:'article' };
    var item = { id: id, type: types[entry.type] || 'article', title: plain(f.title) };
    var fields = { journal:'container-title', journaltitle:'container-title', booktitle:'container-title', shortjournal:'container-title-short', volume:'volume', number:'issue', issue:'issue', pages:'page', publisher:'publisher', institution:'publisher', school:'publisher', address:'publisher-place', location:'publisher-place', edition:'edition', doi:'DOI', url:'URL', isbn:'ISBN', issn:'ISSN', note:'note', series:'collection-title', language:'language', type:'genre' };
    Object.keys(fields).forEach(function (field) { if (f[field]) item[fields[field]] = plain(f[field]); });
    if (f.author) item.author = splitNames(f.author);
    if (f.editor) item.editor = splitNames(f.editor);
    var date = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(plain(f.date || f.year));
    if (date) {
      var parts = [Number(date[1])];
      var month = Number(date[2] || f.month);
      if (!month && f.month) month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(plain(f.month).slice(0, 3).toLowerCase()) + 1;
      if (month >= 1 && month <= 12) { parts.push(month); if (date[3]) parts.push(Number(date[3])); }
      item.issued = { 'date-parts': [parts] };
    }
    if (!item.language) item.language = /[\u3400-\u9fff]/.test(item.title) ? 'zh-CN' : 'en-US';
    if (f.eprint) {
      item.number = plain(f.eprint); item.archive = plain(f.archiveprefix || f.eprinttype || 'arXiv'); item.archive_location = item.number;
      if (!item.URL && /arxiv/i.test(item.archive)) item.URL = 'https://arxiv.org/abs/' + encodeURIComponent(item.number);
      if (!item['container-title'] && /arxiv/i.test(item.archive)) item['container-title'] = 'arXiv';
    }
    if (f.urldate && /^\d{4}-\d{2}-\d{2}$/.test(f.urldate)) item.accessed = { 'date-parts': [f.urldate.split('-').map(Number)] };
    return item;
  }
  function selectedBibs() {
    if ($('wordSource').value === 'current') {
      var bib = getCurrent();
      if (!bib) throw new Error('当前文献尚未保存，请先完成识别或保存信息。');
      return [bib];
    }
    var selected = Array.from($('citeLibrary').querySelectorAll('input:checked'));
    if (!selected.length) throw new Error('请展开上方“选择已保存的文献”，读取并勾选文献，也可按标签选择。');
    return selected.map(function (box) { return box.dataset.bib; });
  }
  function validateStyle(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('样式不能包含外部实体或文档类型声明。');
    var xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror') || xml.documentElement.localName !== 'style' || xml.documentElement.namespaceURI !== 'http://purl.org/net/xbiblio/csl') throw new Error('这不是有效的 CSL 样式文件。');
    if (!xml.getElementsByTagNameNS('*', 'bibliography').length) throw new Error('该文件不包含参考文献排版规则。请下载对应的独立样式（含 bibliography），而不是依赖父样式的快捷文件。');
    var title = xml.getElementsByTagNameNS('*', 'title')[0];
    return title ? title.textContent : '自定义样式';
  }
  function compose(result) {
    var params = result[0], entries = result[1], container = document.createElement('div'), plainEntries = [];
    entries.forEach(function (html) {
      var scratch = document.createElement('div');
      scratch.innerHTML = DOMPurify.sanitize(html, { ALLOWED_TAGS: ['div','span','i','b','em','strong','sup','sub','a','br'], ALLOWED_ATTR: ['class','style','href'] });
      var left = scratch.querySelector('.csl-left-margin');
      if (left) left.appendChild(document.createTextNode('\u00a0 '));
      var paragraph = document.createElement('p');
      paragraph.style.cssText = 'margin:0 0 ' + (Number(params.entryspacing || 0) * 12 + 6) + 'pt 0;line-height:' + Math.max(1, Math.min(3, Number(params.linespacing || 1))) + ';';
      if (params.hangingindent || params['second-field-align']) { paragraph.style.marginLeft = '24pt'; paragraph.style.textIndent = '-24pt'; }
      // Flatten citeproc layout divs so Word receives actual bibliography paragraphs.
      Array.from(scratch.querySelectorAll('div')).reverse().forEach(function (div) {
        var span = document.createElement('span'); span.style.cssText = div.style.cssText;
        while (div.firstChild) span.appendChild(div.firstChild);
        div.replaceWith(span);
      });
      paragraph.innerHTML = scratch.innerHTML;
      plainEntries.push(paragraph.textContent.trim()); container.appendChild(paragraph);
    });
    return { html: container.innerHTML, text: plainEntries.join('\r\n'), count: entries.length };
  }
  async function render() {
    var token = ++revision; output = null; $('wordCopy').disabled = true; $('wordDownload').disabled = true;
    try {
      var bibs = selectedBibs(); status('正在按所选样式排版…');
      var assets = await loadAssets(); if (token !== revision) return;
      var items = {}, ids = [], warnings = [];
      bibs.forEach(function (bib, index) {
        var id = 'ref-' + index, item = itemFromBib(bib, id); items[id] = item; ids.push(id);
        if (!item.author || !item.issued) warnings.push(index + 1);
      });
      var style = $('wordStyle').value === 'custom' ? customStyle : assets.styles[$('wordStyle').value];
      var locale = /^gbt-/.test($('wordStyle').value) ? 'zh-CN' : 'en-US';
      var missingLocales = new Set();
      var processor = new CSL.Engine({
        retrieveLocale: function (language) {
          var key = /^zh(?:-|$)/i.test(language) ? 'zh-CN' : 'en-US';
          if (!/^(en|zh)(?:-|$)/i.test(language)) missingLocales.add(language);
          return assets.locales[key];
        },
        retrieveItem: function (id) { return items[id]; }
      }, style, locale);
      processor.setOutputFormat('html'); processor.updateItems(ids);
      var result = processor.makeBibliography();
      if (!result || !result[1].length) throw new Error('该样式没有生成参考文献，请检查样式与文献信息。');
      if (result[0].bibliography_errors && result[0].bibliography_errors.length) throw new Error('部分文献无法按此样式生成，请核对文献信息或更换样式。');
      output = compose(result); $('wordPreview').innerHTML = output.html;
      $('wordCopy').disabled = false; $('wordDownload').disabled = false;
      status('已生成 ' + output.count + ' 条；顺序由所选样式决定，无排序规则时沿用勾选列表顺序。' + (warnings.length ? '其中 ' + warnings.length + ' 条缺少作者或年份，请核对。' : '') + (missingLocales.size ? '该样式请求的 ' + Array.from(missingLocales).join('、') + ' 语言未内置，已使用英文术语，请核对或改用中英文样式。' : ''));
    } catch (e) {
      if (token !== revision) return;
      $('wordPreview').replaceChildren(); status(e.message || '排版失败，请更换样式重试。');
    }
  }
  function changed() {
    if (!host) return;
    ++revision; output = null; $('wordCopy').disabled = true; $('wordDownload').disabled = true;
    clearTimeout(timer);
    if (host.open) timer = setTimeout(render, 180);
  }
  function documentHtml(html) { return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>参考文献</title></head><body>' + html + '</body></html>'; }
  async function copy() {
    if (!output) return;
    var content = output;
    try {
      if (!navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') throw new Error('fallback');
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([documentHtml(content.html)], { type: 'text/html' }), 'text/plain': new Blob([content.text], { type: 'text/plain' }) })]);
      status('已复制 ' + content.count + ' 条参考文献。到 Word 中粘贴并选择“保留源格式”；正文编号需自行维护。');
    } catch (_) {
      var success = false;
      function onCopy(e) { if (e.clipboardData) { e.clipboardData.setData('text/html', documentHtml(content.html)); e.clipboardData.setData('text/plain', content.text); e.preventDefault(); success = true; } }
      document.addEventListener('copy', onCopy);
      try { success = document.execCommand('copy') && success; } catch (_) { success = false; }
      finally { document.removeEventListener('copy', onCopy); }
      if (success) status('已复制参考文献，到 Word 中粘贴并选择“保留源格式”。');
      else { var range = document.createRange(); range.selectNodeContents($('wordPreview')); var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); status('自动复制不可用，已选中预览，请按 Ctrl+C，或保存 Word 可打开的 HTML 文件。'); }
    }
  }
  function mount(options) {
    parseBib = options.parse; getCurrent = options.current;
    host = document.createElement('details'); host.id = 'citeWord'; host.className = 'citation-section citation-disclosure citation-word';
    host.innerHTML = '<summary><span>复制参考文献到 Word</span><small>按需使用</small></summary><div class="citation-disclosure-body">' +
      '<p class="attachment-hint">生成排好格式的文末参考文献列表。不会修改已保存信息，也不会自动关联 Word 正文编号。</p>' +
      '<div class="citation-output-options"><label>文献来源<select id="wordSource"><option value="current">当前已保存文献</option><option value="selected">上方勾选的已保存文献</option></select></label><label>参考文献样式<select id="wordStyle"></select></label></div>' +
      '<div class="citation-row citation-word-tools"><button id="wordChoose" class="button secondary" type="button">选择批量文献</button><button id="wordImport" class="button secondary" type="button">导入 .csl 样式</button><input id="wordStyleFile" type="file" accept=".csl,application/xml,text/xml" hidden><button id="wordClearStyle" class="button secondary hidden" type="button">移除自定义样式</button></div>' +
      '<p id="wordStatus" class="citation-library-status" role="status" aria-live="polite"></p><div id="wordPreview" class="citation-word-preview" aria-label="参考文献排版预览" tabindex="0"></div>' +
      '<div class="dialog-actions citation-actions"><button id="wordDownload" class="button secondary" type="button" disabled>保存为 HTML</button><button id="wordCopy" class="button accent" type="button" disabled>复制参考文献</button></div>' +
      '<p class="attachment-hint">内置样式可离线使用；支持导入含完整排版规则的中英文 CSL 独立样式，保留最近导入的一种。HTML 文件也可用 Word 打开。</p>' +
      '<p class="citation-word-credit">© Frank Bennett · <a href="https://citationstyles.org/" target="_blank" rel="noopener noreferrer">citeproc-js implements the Citation Style Language</a> · <a href="https://github.com/citation-style-language/styles" target="_blank" rel="noopener noreferrer">CSL 样式及贡献者</a> · <button id="wordLicenses" type="button">开源声明</button></p></div>';
    options.dialog.appendChild(host);
    presets.forEach(function (pair) { var option = document.createElement('option'); option.value = pair[0]; option.textContent = pair[1]; $('wordStyle').appendChild(option); });
    function addCustom() {
      var option = $('wordStyle').querySelector('[value="custom"]');
      if (!option) { option = document.createElement('option'); option.value = 'custom'; $('wordStyle').appendChild(option); }
      option.textContent = '自定义：' + customName; $('wordClearStyle').classList.remove('hidden');
    }
    try { customStyle = localStorage.getItem('literature.wordStyle') || ''; if (customStyle) { customName = validateStyle(customStyle); addCustom(); } } catch (_) { customStyle = ''; }
    try { var last = localStorage.getItem('literature.wordPreset'); if (Array.from($('wordStyle').options).some(function (o) { return o.value === last; })) $('wordStyle').value = last; } catch (_) {}
    host.ontoggle = function () { if (host.open) render(); };
    $('wordSource').onchange = changed;
    $('wordStyle').onchange = function () { try { localStorage.setItem('literature.wordPreset', this.value); } catch (_) {} changed(); };
    $('wordChoose').onclick = function () { $('wordSource').value = 'selected'; $('citeBatch').open = true; $('citeBatch').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); changed(); };
    $('wordImport').onclick = function () { $('wordStyleFile').click(); };
    $('wordStyleFile').onchange = async function () {
      var file = this.files[0]; this.value = ''; if (!file) return;
      try {
        if (file.size > 524288) throw new Error('请选择小于 512 KB 的 .csl 样式文件。');
        var text = await file.text(), name = validateStyle(text);
        customStyle = text; customName = name; addCustom(); $('wordStyle').value = 'custom';
        try { localStorage.setItem('literature.wordStyle', text); localStorage.setItem('literature.wordPreset', 'custom'); }
        catch (_) { status('样式可在本次使用，但本地存储空间不足，未能记住此样式。'); }
        changed();
      } catch (e) { status(e.message); }
    };
    $('wordClearStyle').onclick = function () {
      customStyle = ''; customName = ''; var option = $('wordStyle').querySelector('[value="custom"]'); if (option) option.remove();
      $('wordStyle').value = 'gbt-numeric'; this.classList.add('hidden');
      try { localStorage.removeItem('literature.wordStyle'); localStorage.setItem('literature.wordPreset', 'gbt-numeric'); } catch (_) {} changed();
    };
    $('wordCopy').onclick = copy;
    $('wordDownload').onclick = function () {
      if (!output) return;
      var url = URL.createObjectURL(new Blob([documentHtml(output.html)], { type: 'text/html;charset=utf-8' }));
      var a = document.createElement('a'); a.href = url; a.download = '参考文献.html'; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    };
    $('wordLicenses').onclick = async function () {
      try {
        var assets = await loadAssets(), text = Object.keys(assets.licenses).map(function (name) { return name + '\n\n' + assets.licenses[name]; }).join('\n\n');
        var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
        a.href = url; a.download = '引用排版开源声明.txt'; a.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      } catch (e) { status(e.message); }
    };
  }
  window.LiteratureWordCitations = { mount: mount, changed: changed, reset: function () { if (host) { host.open = false; $('wordPreview').replaceChildren(); changed(); } } };
})();
