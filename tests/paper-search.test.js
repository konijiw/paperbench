const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const search = require('../assets/paper-search.js');
const bib = require('../assets/citations.js');
const papers = [
  { title: '三指灵巧手', parsedTitle: 'Learning dexterous in-hand manipulation', name: '2025NMI', path: 'gradio/s42256-025-01053-3', tags: ['机器人'] },
  { title: 'Robot learning', name: 'paper2', path: 'library/paper2', tags: [] }
];
for (const query of ['DEXTEROUS', 'ｄｅｘｔｅｒｏｕｓ', 'in hand', 'in-hand', 'manipulation learning', 'dexterou', 'dexterouss', 'dexterous manipulatoin']) {
  // The library supports one insertion/deletion/substitution per English word,
  // not transpositions (two edits).
  const matches = search.filter(papers, query, true);
  assert.equal(matches.includes(papers[0]), query !== 'dexterous manipulatoin', query);
}
assert.deepEqual(search.filter(papers, '机器人', true), [papers[0]]);
assert.deepEqual(search.filter(papers, '机器人', false), []);
assert.deepEqual(search.filter(papers, 's42256 025 01053', true), [papers[0]]);
assert.deepEqual(search.filter(papers, '不存在', true), []);
assert.equal(search.filter(papers, 'learning', true)[0], papers[1]);
assert.deepEqual(search.filter(papers, '', true), papers);

// PDF-only files supplement the original fields with an opening excerpt.
search.setLibrary('library-one', papers);
search.setPdfIndex(papers[0].path, {signature:'pdf-v1',title:'A fingertip sensing study',text:'Crimson zephyr benchmark measures fingertip impedance.'});
for (const query of ['zephyr', 'ZEPhyR impedance', 'zephir', 'fingerti', 'ｉｍｐｅｄａｎｃｅ']) {
  assert.equal(search.filter(papers,query,true)[0],papers[0],query);
}
assert.equal(search.filter(papers,'zephyr',false)[0],papers[0]);
assert.equal(search.filter(papers,'robot',true)[0],papers[1], 'metadata matches rank first');
assert.equal(search.filter(papers,'sensing study',true).length,0,'PDF metadata title is not another search field');
search.setPdfIndex(papers[1].path,{signature:'bounded-opening',title:'',text:'a'.repeat(800)+'pastboundary'});
assert.equal(search.filter(papers,'pastboundary',true).length,0,'opening is capped at 800 characters');
search.setLibrary('library-one',papers.map((paper,index)=>Object.assign({},paper,{hasMarkdown:index===0})));
assert.equal(search.filter(papers,'zephyr',true).length,0,'library MD flags also guard export records without flags');
search.setPdfIndex(papers[0].path,{signature:'late-job',title:'',text:'forbiddenpdfword'});
assert.equal(search.filter(papers,'forbiddenpdfword',true).length,0,'late PDF jobs cannot affect papers gaining Markdown');
assert.equal(search.filter(papers,'dexterous',true)[0],papers[0],'original MD title search remains unchanged');
search.setLibrary('library-one',papers);
search.setPdfIndex(papers[0].path,{signature:'pdf-v2',title:'Updated',text:'Emerald benchmark'});
assert.equal(search.filter(papers,'zephyr',true).length,0,'updated PDF replaces old text');
search.setLibrary('library-two',papers);
assert.equal(search.filter(papers,'emerald',true).length,0,'root switch clears old PDF text');

// Exercise the actual citation filter with selected rows that remain in the
// list for both BibTeX export and Word export while hidden by search.
const source = fs.readFileSync(require.resolve('../assets/citations.js'), 'utf8');
const start = source.indexOf('    function filterCitationLibrary() {');
const end = source.indexOf("    $('citeLibrarySearch').oninput", start);
const first = { citationRecord: Object.assign({}, papers[0], { bib: '@article{one,title={Dexterous manipulation},author={Smith, Alice}}', key: 'one' }), style: {}, checked: true };
const second = { citationRecord: Object.assign({}, papers[1], { bib: '@article{two,title={Robot learning}}', key: 'two' }), style: {}, checked: false };
const list = { children: [first, second], appendChild(row) { this.children = this.children.filter(x => x !== row).concat(row); } };
const elements = { citeLibrary: list, citeLibrarySearch: { value: 'two' }, citeLibraryStatus: {} };
const context = { window: { PaperSearch: search }, $: id => elements[id], parseBib: bib.parse };
vm.createContext(context);
vm.runInContext(source.slice(start, end) + '\nfilterCitationLibrary();', context);
assert.equal(first.style.display, 'none');
assert.equal(second.style.display, '');
assert.equal(first.checked, true);

search.setPdfIndex(papers[1].path,{signature:'citation-pdf',title:'Extracted title',text:'A special quasar impedance result.'});
elements.citeLibrarySearch.value='quasar';
vm.runInContext('filterCitationLibrary();', context);
assert.equal(first.style.display,'none');assert.equal(second.style.display,'');assert.equal(first.checked,true);
assert.equal(list.children.length, 2);
elements.citeLibrarySearch.value = 'Alice';
vm.runInContext('filterCitationLibrary();', context);
assert.equal(first.style.display, '');
assert.equal(second.style.display, 'none');
elements.citeLibrarySearch.value = '';
vm.runInContext('filterCitationLibrary();', context);
assert.ok(list.children.every(row => row.style.display === ''));
assert.equal(first.checked, true);
console.log('Shared title/fuzzy search, citation metadata search and selection preservation passed.');
