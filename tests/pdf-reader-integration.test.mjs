import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWithOffsets, findQuote } from '../assets/pdf-reader/quote-matcher.mjs';

assert.equal(normalizeWithOffsets('A ﬁnding in a hyphen-\nated word').value,'Afindinginahyphenatedword');
assert.equal(findQuote('samewordsameword','sameword').status,'ambiguous');
assert.equal(findQuote('beforeAsamewordbeforeBsameword','sameword','beforeB').start,22);

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(project,'tests/runtime/pdf-integration');
const modules=process.env.PDF_LAB_MODULES;
if(!modules) throw new Error('Set PDF_LAB_MODULES to the bundled node_modules directory.');
const require=createRequire(path.join(modules,'_pdf_test.cjs'));
const {chromium}=require('playwright'),{PDFDocument,StandardFonts}=require('pdf-lib');
await mkdir(root,{recursive:true});
const library=path.join(root,'library');
for(const folder of ['dual','only']) await mkdir(path.join(library,folder),{recursive:true});
const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
const shared='A shared finding links the Markdown note to the PDF.';
const fresh='Fresh PDF selection for annotation and translation.';
for(let i=0;i<2;i++){
  const p=doc.addPage([612,792]);
  p.drawText(i===0?shared:'Another PDF only excerpt for translation.',{x:50,y:700,size:12,font});
  p.drawText(i===0?fresh:'A separate observation on the second page.',{x:50,y:660,size:12,font});
  p.drawText('Repeated sentence.',{x:50,y:620,size:12,font});
}
const bytes=await doc.save();
for(const folder of ['dual','only']) await writeFile(path.join(library,folder,'source.pdf'),bytes);
await writeFile(path.join(library,'dual','markdown.md'),`# Compatibility fixture\n\n${shared}\n\n${fresh}\n\nRepeated sentence.\n`);
let realCases=[];
if(process.env.PDF_COMPAT_CASES){
  realCases=JSON.parse(await readFile(process.env.PDF_COMPAT_CASES,'utf8'));
  for(const [i,example] of realCases.entries()){
    const folder=path.join(library,'real-case-'+i);await mkdir(folder,{recursive:true});
    await copyFile(example.pdf,path.join(folder,'source.pdf'));
  }
}
const statePath=path.join(root,'state/ai-literature-reader');
await mkdir(statePath,{recursive:true});
await writeFile(path.join(statePath,'settings.json'),JSON.stringify({libraryRoot:library}));
const compiler=path.join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const hostPath=path.join(root,'TestHost.exe');
execFileSync(compiler,['/nologo','/target:exe',`/out:${hostPath}`,path.join(project,'tests/PdfReaderTestHost.cs')],{windowsHide:true});
const host=spawn(hostPath,[path.join(root,'PaperBench.exe')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser,page,url;const errors=[],checks=[];
try {
  url=await new Promise((resolve,reject)=>{
    let log='';host.stdout.on('data',b=>{log+=b;const m=/PDF_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(m)resolve(m[1]);});
    host.on('error',reject);host.on('exit',c=>reject(new Error('Host exited '+c)));
    setTimeout(()=>reject(new Error('Host startup timed out')),15000).unref();
  });
  const api=async(route,body)=>{
    const response=await fetch(url+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    assert.ok(response.ok,`${route}: ${response.status}`);return response.json();
  };
  async function getReview(folder){return (await api('/api/paper?path='+folder)).review;}
  const legacy={id:'legacy-md',quote:shared,prefix:'',suffix:'',comment:'Existing Markdown comment',kind:'note',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
  for(const folder of ['dual','only']){
    const review=await getReview(folder);
    Object.assign(review,{note:'Existing whole-paper note',annotations:folder==='dual'?[legacy]:[],pdfCollapsed:false,markdownCollapsed:false});
    await api('/api/save',{paperPath:folder,review});
  }
  for(const [i,example] of realCases.entries()){
    const folder='real-case-'+i,review=await getReview(folder);
    Object.assign(review,{note:'Read-only copy for compatibility verification',annotations:example.annotations,pdfCollapsed:false,markdownCollapsed:true});
    await api('/api/save',{paperPath:folder,review});
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.PDF_LAB_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:1.25});
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept());
  // Exercise the real translation handler and persistence without sending user
  // content or creating external AI chats. Only the AI provider is a test stub.
  await page.route('**/assets/zcs/ai-chat.js',route=>route.fulfill({contentType:'application/javascript',body:
    `window.AILiteratureChat={mount:async()=>{},setPaper:async()=>{},focus:()=>{},addTextSelection:()=>true};`}));
  await page.addInitScript(()=>{localStorage.setItem('ai-literature-reader.ai-collapsed','true');localStorage.setItem('ai-literature-reader.notes-collapsed','false');});
  await page.goto(url);
  async function open(folder){
    await page.locator(`.tree-row.paper[data-paper="${folder}"]`).click();
    await page.waitForFunction(value=>document.getElementById('paperMeta').textContent===value,folder);
    await page.waitForTimeout(500);
  }
  async function pdfFrame(){
    const iframe=await page.locator('#pdfFrame').elementHandle(),frame=await iframe.contentFrame();
    await frame.waitForSelector('.page[data-page-number="1"] .textLayer span',{timeout:30000});
    await frame.waitForTimeout(300);return frame;
  }
  async function selectPdf(frame,text){
    await frame.locator('.page[data-page-number="1"] .textLayer span').filter({hasText:text}).first().scrollIntoViewIfNeeded();
    await frame.waitForTimeout(250);
    await frame.evaluate(text=>{
      const span=[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find(s=>s.textContent===text);
      if(!span)throw new Error('Missing PDF text '+text);
      const range=document.createRange();range.selectNodeContents(span);
      window.getSelection().removeAllRanges();window.getSelection().addRange(range);
      document.getElementById('container').dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
    },text);
    await page.waitForFunction(()=>!document.getElementById('annotateSelection').disabled);
  }
  async function waitSaved(){await page.waitForFunction(()=>document.getElementById('saveState').textContent==='已保存');await page.waitForTimeout(100);}
  async function mockTranslate(mode='success'){
    await page.evaluate(mode=>{
      window.ZoteroCodexModules.CodexClient.BrowserCodexClient.prototype.translateText=function(text){
        window.__translatedText=text;
        if(mode==='failure')return Promise.reject(new Error('Simulated provider failure'));
        if(mode==='deferred')return new Promise(resolve=>{window.__finishTranslation=resolve;});
        return Promise.resolve('测试译文：'+text);
      };
    },mode);
  }
  await open('dual');let frame=await pdfFrame();
  await frame.waitForSelector('.pb-highlight-target[data-annotation-id="legacy-md"]',{timeout:30000});
  assert.equal(await page.locator('#markdownContent mark[data-annotation-id="legacy-md"]').count()>0,true);
  checks.push('legacy Markdown quote highlights in both viewers');
  const before=await getReview('dual');
  assert.equal(before.annotations[0].comment,legacy.comment);assert.equal(before.annotations[0].pdfAnchor,null);
  // The legacy matcher is transient and must not rewrite old Markdown data.
  assert.equal(before.annotations[0].prefix,'');assert.equal(before.note,'Existing whole-paper note');
  checks.push('legacy anchors and note preserved');
  await page.evaluate(()=>{window.__annotationClicks=[];window.addEventListener('message',e=>{if(e.data?.kind==='annotationClick')window.__annotationClicks.push(e.data.id);});});
  await frame.evaluate(()=>{window.__reverseLocates=0;window.addEventListener('message',e=>{if(e.data?.kind==='locate')window.__reverseLocates++;});});
  async function quotePoint(text){
    const bounds=await frame.locator('.page[data-page-number="1"] .textLayer span').filter({hasText:text}).first().boundingBox();
    return {x:bounds.x+15,y:bounds.y+bounds.height/2};
  }
  let point=await quotePoint(shared);
  const scrollBefore=await frame.locator('#container').evaluate(c=>[c.scrollLeft,c.scrollTop]);
  await page.mouse.click(point.x,point.y);
  await page.waitForSelector('.annotation-card.active[data-id="legacy-md"]');
  await page.waitForTimeout(400);
  assert.deepEqual(await frame.locator('#container').evaluate(c=>[c.scrollLeft,c.scrollTop]),scrollBefore);
  assert.equal(await frame.evaluate(()=>window.__reverseLocates),0);
  assert.ok(await page.locator('#annotationEditor').evaluate(el=>el.classList.contains('hidden')));
  await page.locator('#toggleNotes').click();await frame.waitForTimeout(350);
  point=await quotePoint(shared);await page.mouse.click(point.x,point.y);
  await page.waitForFunction(()=>!document.getElementById('notesPanel').classList.contains('collapsed'));
  assert.equal(await frame.evaluate(()=>window.__reverseLocates),0);
  checks.push('PDF highlight opens existing MD annotation card without navigating PDF or editing');
  await frame.waitForTimeout(350);point=await quotePoint(shared);
  const clickCount=await page.evaluate(()=>window.__annotationClicks.length);
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+120,point.y,{steps:8});await page.mouse.up();
  assert.ok(await frame.evaluate(()=>window.getSelection().toString().length>0));
  await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.__annotationClicks.length),clickCount);
  await frame.evaluate(()=>window.getSelection().removeAllRanges());
  await frame.evaluate(text=>{
    const span=[...document.querySelectorAll('.textLayer span')].find(s=>s.textContent===text);
    const rect=span.getBoundingClientRect(),link=document.createElement('a');link.href='#test-link';link.addEventListener('click',e=>e.preventDefault());
    Object.assign(link.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',zIndex:'100',pointerEvents:'auto'});
    document.querySelector('#container').append(link);window.__testLink=link;
  },shared);
  point=await quotePoint(shared);await page.mouse.click(point.x,point.y);await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>window.__annotationClicks.length),clickCount);
  await frame.evaluate(()=>window.__testLink.remove());
  checks.push('drag selection and PDF links do not trigger reverse annotation navigation');
  await selectPdf(frame,fresh);await frame.locator('#selectionTools [data-action=annotate]').click();
  await page.locator('#annotationText').fill('New PDF comment');await page.locator('#confirmAnnotation').click();await waitSaved();
  let review=await getReview('dual'),added=review.annotations.find(a=>a.comment==='New PDF comment');
  assert.equal(added.source,'pdf');assert.equal(added.pdfAnchor.version,1);assert.equal(added.pdfAnchor.fragments[0].page,1);
  assert.equal(added.pdfAnchor.fragments[0].textRanges[0].text,fresh);
  assert.ok(await page.locator(`#markdownContent mark[data-annotation-id="${added.id}"]`).count());
  checks.push('PDF annotation persists through C# and uses unchanged Markdown highlighting');
  await frame.waitForSelector(`.pb-highlight-target[data-annotation-id="${added.id}"]`);
  await frame.evaluate(()=>window.getSelection().removeAllRanges());
  point=await quotePoint(fresh);await page.mouse.click(point.x,point.y);
  await page.waitForSelector(`.annotation-card.active[data-id="${added.id}"]`);
  checks.push('new PDF annotation also supports reverse navigation');
  // MD-only view: clicking the PDF annotation must stay in MD.
  await page.locator('[data-reading-mode=markdown]').click();await page.waitForTimeout(300);
  await page.locator(`.annotation-card[data-id="${added.id}"] .annotation-quote`).click();
  assert.ok((await page.locator('#readingLayout').getAttribute('class')).includes('pdf-collapsed'));
  assert.ok(await page.locator(`#markdownContent mark[data-annotation-id="${added.id}"].active`).count());
  checks.push('MD-only navigation does not force PDF open');
  // PDF-only view: old MD annotations must not force MD open.
  await page.locator('[data-reading-mode=pdf]').click();
  await page.locator('.annotation-card[data-id="legacy-md"] .annotation-quote').click();
  assert.ok((await page.locator('#readingLayout').getAttribute('class')).includes('markdown-collapsed'));
  checks.push('PDF-only navigation resolves old MD annotations without opening MD');
  frame=await pdfFrame();await mockTranslate();await selectPdf(frame,shared);
  await frame.locator('#selectionTools [data-action=translate]').click();await waitSaved();
  review=await getReview('dual');
  const translation=review.annotations.find(a=>a.kind==='translation');
  assert.equal(translation.source,'pdf');assert.equal(translation.quote,shared);assert.ok(translation.pdfAnchor.fragments.length);
  assert.equal(translation.comment,'测试译文：'+shared);checks.push('PDF AI translation preserves PDF anchor');
  await frame.evaluate(()=>window.getSelection().removeAllRanges());await frame.waitForTimeout(250);
  const topmost=await frame.locator('.pb-highlight-target').evaluateAll(paths=>paths.filter(p=>['legacy-md'].includes(p.dataset.annotationId)||p.getAttribute('d')===paths.find(p=>p.dataset.annotationId==='legacy-md')?.getAttribute('d')).at(-1).dataset.annotationId);
  point=await quotePoint(shared);await page.mouse.click(point.x,point.y);
  await page.waitForSelector(`.annotation-card.active[data-id="${topmost}"]`);
  checks.push('overlapping highlights select a single annotation in paint order');
  // Source links work for PDF annotations using the existing note link syntax.
  await page.locator(`.annotation-card[data-id="${added.id}"] [data-action="note"]`).click();await waitSaved();
  assert.match((await getReview('dual')).note,/#reader-annotation=/);
  await page.locator('#paperNotePreview a.paper-note-source').click();
  assert.ok((await page.locator('#readingLayout').getAttribute('class')).includes('markdown-collapsed'));
  checks.push('existing note source links route to visible PDF');
  // Provider failure leaves the quote available to retry.
  await mockTranslate('failure');await selectPdf(frame,fresh);await frame.locator('#selectionTools [data-action=translate]').click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Simulated provider failure'));
  assert.equal(await page.locator('#translateSelection').isEnabled(),true);checks.push('failed PDF translation can retry');
  // Reopening keeps anchors and comments; PDF-only notes can use the same UI.
  await open('only');frame=await pdfFrame();await selectPdf(frame,fresh);await frame.locator('#selectionTools [data-action=annotate]').click();
  await page.locator('#annotationText').fill('PDF-only comment');await page.locator('#confirmAnnotation').click();await waitSaved();
  let only=await getReview('only');assert.equal(only.annotations[0].comment,'PDF-only comment');
  await page.locator('.annotation-card [data-action="note"]').click();await waitSaved();
  assert.match((await getReview('only')).note,/#reader-annotation=/);checks.push('PDF-only annotation editing and add-to-note');
  await mockTranslate();await selectPdf(frame,shared);await frame.locator('#selectionTools [data-action="translate"]').click();
  await page.waitForSelector('.annotation-kind');await waitSaved();
  assert.ok((await getReview('only')).annotations.find(a=>a.kind==='translation'&&a.pdfAnchor));
  checks.push('PDF-only floating selection translation');
  // A late translation must not land on another paper.
  await mockTranslate('deferred');await selectPdf(frame,fresh);await frame.locator('#selectionTools [data-action=translate]').click();
  await page.waitForFunction(()=>typeof window.__finishTranslation==='function');
  await open('dual');const count=(await getReview('dual')).annotations.length;
  await page.evaluate(()=>window.__finishTranslation('SHOULD NOT SAVE'));
  await page.waitForTimeout(800);assert.equal((await getReview('dual')).annotations.length,count);
  checks.push('late translation cannot cross paper switch');
  // Legacy Markdown selection still enters the original translation path.
  await page.locator('[data-reading-mode=markdown]').click();await page.waitForTimeout(300);
  await mockTranslate();
  await page.locator('#markdownContent').evaluate(element=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode()))if(node.nodeValue.includes('Repeated sentence.')){
      const r=document.createRange(),start=node.nodeValue.indexOf('Repeated sentence.');r.setStart(node,start);r.setEnd(node,start+18);
      window.getSelection().removeAllRanges();window.getSelection().addRange(r);element.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));break;}
  });
  await page.waitForFunction(()=>!document.getElementById('translateSelection').disabled);
  await page.locator('#translateSelection').click();await waitSaved();
  assert.ok((await getReview('dual')).annotations.find(a=>a.kind==='translation'&&a.source==='markdown'&&!a.pdfAnchor));
  checks.push('Markdown selection and translation regression');
  await page.locator('[data-reading-mode=both]').click();frame=await pdfFrame();
  // Repeated quote without distinguishing context must report ambiguity.
  await frame.evaluate(({paper,session})=>window.postMessage({type:'noop'},location.origin),{paper:'dual',session:''});
  await page.evaluate(()=>{
    const iframe=document.getElementById('pdfFrame'),u=new URL(iframe.src);
    iframe.contentWindow.postMessage({type:'paperbench-pdf-command',paper:'dual',session:u.searchParams.get('session'),kind:'locate',requestId:'ambiguous-test',annotation:{id:'ambiguous',quote:'Repeated sentence.',prefix:'',suffix:''}},location.origin);
  });
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('多个相同引文'));
  checks.push('ambiguous PDF quote does not silently choose a location');
  await page.reload();await open('dual');frame=await pdfFrame();await page.locator('[data-note-tab=annotations]').click();
  const persisted=await getReview('dual');assert.ok(persisted.annotations.find(a=>a.id===added.id&&a.pdfAnchor));
  assert.equal(persisted.annotations.find(a=>a.id==='legacy-md').comment,legacy.comment);
  checks.push('reload and server serialization preserve old and new annotations');
  // Both visible: the most recently used reader wins, without changing layout.
  await frame.evaluate(()=>{window.__locates=0;window.addEventListener('message',e=>{if(e.data?.type==='paperbench-pdf-command'&&e.data.kind==='locate')window.__locates++;});});
  await page.locator('#markdownContent').dispatchEvent('pointerdown');
  await page.locator('.annotation-card[data-id="legacy-md"] .annotation-quote').click();
  assert.equal(await frame.evaluate(()=>window.__locates),0);
  await frame.locator('#container').dispatchEvent('pointerdown',{button:0});await page.waitForTimeout(80);
  await page.locator('.annotation-card[data-id="legacy-md"] .annotation-quote').click();
  await frame.waitForFunction(()=>window.__locates===1);checks.push('both visible readers honor last active source');
  // Gestures remain scoped to the nested iframe, and search still works.
  await frame.locator('#zoom').selectOption('1.5');await frame.waitForTimeout(350);
  const iframeBounds=await page.locator('#pdfFrame').boundingBox();
  const readerBounds=await frame.locator('#container').boundingBox();
  const mouse={x:readerBounds.x+180,y:readerBounds.y+180};
  await page.mouse.move(mouse.x,mouse.y);
  const headerHeight=await page.locator('.app-header').evaluate(el=>el.getBoundingClientRect().height);
  const scaleBefore=Number(await frame.locator('#zoom').inputValue());
  await page.keyboard.down('Control');await page.mouse.wheel(0,-80);await page.keyboard.up('Control');await frame.waitForTimeout(400);
  assert.ok(Number(await frame.locator('#zoom').inputValue())>scaleBefore);
  assert.equal(await page.locator('.app-header').evaluate(el=>el.getBoundingClientRect().height),headerHeight);
  await frame.locator('#zoom').selectOption('3');await frame.waitForTimeout(350);
  await frame.locator('#container').evaluate(c=>{c.scrollLeft=100;c.scrollTop=100;});
  const panBefore=await frame.locator('#container').evaluate(c=>[c.scrollLeft,c.scrollTop]);
  await page.mouse.move(mouse.x,mouse.y);await page.mouse.down({button:'middle'});await page.mouse.move(mouse.x-60,mouse.y-50,{steps:5});await page.mouse.up({button:'middle'});
  const panAfter=await frame.locator('#container').evaluate(c=>[c.scrollLeft,c.scrollTop]);
  assert.ok(Math.abs(panAfter[0]-panBefore[0]-60)<2&&Math.abs(panAfter[1]-panBefore[1]-50)<2);
  await frame.locator('#searchToggle').click();await frame.locator('#search').fill('Fresh PDF');
  await frame.waitForSelector('.textLayer .highlight',{timeout:15000});
  await frame.locator('#searchClose').click();await frame.locator('#zoom').selectOption('page-width');await frame.waitForTimeout(300);
  checks.push('embedded reader Ctrl-wheel, middle drag and PDF search');
  await frame.locator('#zoom').selectOption('1.5');await page.locator('#pdfMoreTools summary').click();await page.locator('#rotatePdf').click();await frame.waitForTimeout(400);
  const rotated=frame.locator(`.pb-highlight-target[data-annotation-id="${added.id}"]`).first();
  await rotated.evaluate(el=>el.scrollIntoView({block:'center',inline:'center'}));await frame.waitForTimeout(100);
  const rotatedBounds=await rotated.boundingBox(),locatesBeforeClick=await frame.evaluate(()=>window.__locates);
  await page.mouse.click(rotatedBounds.x+rotatedBounds.width/2,rotatedBounds.y+rotatedBounds.height/2);
  await page.waitForSelector(`.annotation-card.active[data-id="${added.id}"]`);
  assert.equal(await frame.evaluate(()=>window.__locates),locatesBeforeClick);
  for(let i=0;i<3;i++){await page.locator('#pdfMoreTools summary').click();await page.locator('#rotatePdf').click();}
  await frame.locator('#zoom').selectOption('page-width');await frame.waitForTimeout(350);
  checks.push('reverse navigation remains accurate after PDF zoom and rotation');
  const realResults=[];
  for(const [i,example] of realCases.entries()){
    await open('real-case-'+i);frame=await pdfFrame();
    await page.evaluate(()=>{window.__realResults={};window.addEventListener('message',e=>{if(e.data?.type==='paperbench-pdf-event'&&e.data.kind==='located')window.__realResults[e.data.requestId]=e.data.status;});});
    for(const [j,annotation] of example.annotations.entries()){
      const requestId=`case-${i}-${j}`;
      await page.evaluate(({annotation,requestId})=>{
        const iframe=document.getElementById('pdfFrame'),u=new URL(iframe.src);
        iframe.contentWindow.postMessage({type:'paperbench-pdf-command',paper:u.searchParams.get('paper'),session:u.searchParams.get('session'),kind:'locate',requestId,annotation},location.origin);
      },{annotation,requestId});
      await page.waitForFunction(id=>!!window.__realResults[id],requestId,{timeout:60000});
      const result=await page.evaluate(id=>window.__realResults[id],requestId);
      realResults.push({case:i,annotation:j,status:result});
    }
    await page.screenshot({path:path.join(root,`real-case-${i}.png`)});
  }
  if(realResults.length)checks.push('existing user Markdown annotations tested against read-only PDF copies');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(root,'integrated-reader.png')});
  for(const width of [1280,1920]){
    await page.setViewportSize({width,height:1000});await page.waitForTimeout(350);
    await page.screenshot({path:path.join(root,`header-${width}.png`),clip:{x:0,y:0,width,height:100}});
  }
  await writeFile(path.join(root,'results.json'),JSON.stringify({passed:true,checks,realResults,errors},null,2));
  console.log(JSON.stringify({passed:true,checks,realResults,errors},null,2));
} catch(error){
  if(page){await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.log('PAGE_ERRORS',errors);}
  throw error;
} finally {
  if(browser)await browser.close();host.kill();
}
