import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const build=path.join(project,'tests/runtime/pdf-features');
const root=path.join(build,'run-'+Date.now());
const require=createRequire(path.join(process.env.PDF_LAB_MODULES,'_test.cjs'));
const {chromium}=require('playwright'),{PDFDocument,StandardFonts,rgb}=require('pdf-lib');
await mkdir(root,{recursive:true});
await copyFile(path.join(build,'PaperBench.exe'),path.join(root,'PaperBench.exe'));
const library=path.join(root,'library');
for(const name of ['only','dual','foreign','empty','roundtrip','fail-parse'])await mkdir(path.join(library,name),{recursive:true});
const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
for(let i=0;i<2;i++){
  const page=doc.addPage([612,792]);page.drawText(`Synthetic page ${i+1} complete text.`,{x:50,y:720,size:14,font});
  page.drawRectangle({x:50,y:440,width:240,height:180,color:rgb(.9,.1,.1)});
}
const bytes=await doc.save();
for(const name of ['only','dual','foreign','roundtrip','fail-parse'])await writeFile(path.join(library,name,'source.pdf'),bytes);
const empty=await PDFDocument.create();empty.addPage();await writeFile(path.join(library,'empty/source.pdf'),await empty.save());
await writeFile(path.join(library,'dual/markdown.md'),'# Synthetic parsed paper\n\n![figure](images/parsed.png)\n');
await mkdir(path.join(library,'dual/images'),{recursive:true});
await writeFile(path.join(library,'dual/images/parsed.png'),'disposable parsed fixture');
await writeFile(path.join(library,'dual/images/personal.png'),'personal image must survive');
await writeFile(path.join(library,'dual/structured_content.json'),'{}');
await writeFile(path.join(library,'foreign/pdf-text.txt'),'User-owned text');
await mkdir(path.join(root,'state/ai-literature-reader'),{recursive:true});
await writeFile(path.join(root,'state/ai-literature-reader/settings.json'),JSON.stringify({libraryRoot:library}));
const csc=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
// Exercise the real staging/publishing lifecycle without starting MinerU models.
const runtime=path.join(root,'fake-mineru'),scripts=path.join(runtime,'Scripts');
await mkdir(scripts,{recursive:true});
const fake=path.join(root,'FakeParser.cs');
await writeFile(fake,`using System;using System.IO;class FakeParser{static int Main(string[] args){
 if(args[1].Contains("fail-parse"))return 2;
 string output=args[Array.IndexOf(args,"--output")+1];Directory.CreateDirectory(Path.Combine(output,"images"));
 File.WriteAllText(Path.Combine(output,"markdown.md"),"# Fine fixture\\n\\n![Figure](images/generated.png)");
 File.WriteAllText(Path.Combine(output,"structured_content.json"),"{}");
 File.WriteAllText(Path.Combine(output,"images/generated.png"),"synthetic fixture");
 Console.WriteLine("{}");return 0;}}`);
execFileSync(csc,['/nologo','/target:exe',`/out:${path.join(scripts,'python.exe')}`,fake],{windowsHide:true});
await writeFile(path.join(scripts,'mineru-kit.exe'),'fixture');
await writeFile(path.join(root,'state/ai-literature-reader/mineru-location.txt'),runtime);
execFileSync(csc,['/nologo','/target:exe',`/out:${path.join(root,'Host.exe')}`,path.join(project,'tests/PdfReaderTestHost.cs')],{windowsHide:true});
const host=spawn(path.join(root,'Host.exe'),[path.join(root,'PaperBench.exe')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser,page;const checks=[],errors=[];
try{
  const url=await new Promise((resolve,reject)=>{let log='';host.stdout.on('data',b=>{log+=b;const m=/PDF_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log);if(m)resolve(m[1]);});host.on('error',reject);setTimeout(()=>reject(Error('host timeout')),15000).unref();});
  const api=async(route,body)=>{const r=await fetch(url+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const data=await r.json();return {ok:r.ok,data};};
  browser=await chromium.launch({headless:true,executablePath:process.env.PDF_LAB_CHROME||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:1.25});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',()=>{throw Error('Unexpected modal dialog');});
  // Real sidebar and attachment logic, with all external AI calls replaced.
  await page.route('**/assets/zcs/ai-client.js',async route=>{
    const source=await readFile(path.join(project,'assets/ai-client.js'),'utf8');
    await route.fulfill({contentType:'application/javascript',body:source+`
      Object.assign(window.ZoteroCodexModules.CodexClient.BrowserCodexClient.prototype, {
        connect:async function(){this.process={};return this;},
        request:async function(method,params){
          window.__rpc=(window.__rpc||[]).concat([{method,params}]);
          if(method==='model/list')return {data:[{id:'test-model',model:'test-model',displayName:'Test',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}]};
          if(method==='thread/start')return {thread:{id:'fixture-thread',cwd:params.cwd,turns:[]}};
          return {data:[],nextCursor:null};
        }
      });`});
  });
  await page.route('**/assets/zcs/sidebar.js',async route=>{
    const source=await readFile(path.join(project,'assets/codex-sidebar/sidebar.js'),'utf8');
    await route.fulfill({contentType:'application/javascript',body:source+`;window.ZoteroCodexModules.Sidebar.SidebarView.prototype.send=async function(){window.__sent=(window.__sent||[]).concat([{paper:this.context.title,text:this.elements.input.value,preferred:this.context.preferredTextPath}]);};`});
  });
  await page.route('**/api/local-mineru/status?*',route=>route.fulfill({json:{available:false,state:'idle',running:0,capacity:2}}));
  await page.addInitScript(()=>{localStorage.setItem('ai-literature-reader.ai-collapsed','false');localStorage.setItem('ai-literature-reader.notes-collapsed','true');});
  await page.goto(url);
  const open=async name=>{
    await page.locator(`.tree-row.paper[data-paper="${name}"]`).click();
    await page.waitForFunction(name=>document.getElementById('paperMeta').textContent===name,name);
    await page.waitForFunction(name=>window.AILiteratureChat?.view?.contextTransitioning===false&&window.AILiteratureChat.view.context?.title===name,name);
    if(await page.locator('[data-reading-mode=pdf]').isEnabled())await page.locator('[data-reading-mode=pdf]').click();
    await page.waitForFunction(name=>document.getElementById('pdfFrame').src.includes('paper='+name),name);
    const iframe=await page.locator('#pdfFrame').elementHandle(),frame=await iframe.contentFrame();
    await frame.waitForSelector('.page[data-page-number="1"] canvas');
    return frame;
  };
  await page.waitForFunction(()=>!!window.PaperBenchPdfProcessing);
  await page.evaluate(()=>{const extract=window.PaperBenchPdfProcessing.extract;window.__extracts=[];window.PaperBenchPdfProcessing.extract=async function(paper,...args){window.__extracts.push(paper);return extract.call(this,paper,...args);};});
  let frame=await open('only');
  await page.evaluate(()=>window.PaperBenchEnsurePaperText('only'));
  const text=await readFile(path.join(library,'only/pdf-text.txt'),'utf8');
  assert.match(text,/Synthetic page 1/);assert.match(text,/Synthetic page 2/);assert.match(text,/2 \/ 2/);
  await page.locator('#mineruParse').click();await page.locator('#pdfParseMenu').waitFor({state:'visible'});
  assert.equal(await page.locator('#pdfParseText').count(),0);assert.equal(await page.locator('#mineruParse').innerText(),'解析 PDF');
  assert.match(await page.locator('#pdfTextStatus').innerText(),/准备好/);await page.keyboard.press('Escape');
  const beforeCount=await page.evaluate(()=>window.__extracts.length);
  await page.evaluate(()=>Promise.all([window.PaperBenchEnsurePaperText('only'),window.PaperBenchEnsurePaperText('only')]));
  assert.equal(await page.evaluate(()=>window.__extracts.length),beforeCount);
  checks.push('opening PDF auto extracts all pages once; ready TXT reused; no manual text button');
  await open('dual');await page.evaluate(()=>window.PaperBenchEnsurePaperText('dual'));
  assert.equal(await page.evaluate(()=>window.__extracts.includes('dual')),false);
  assert.match((await api('/api/paper?path=dual')).data.preferredTextPath,/markdown\.md$/);
  await writeFile(path.join(library,'dual/.paperbench-parsing.json'),JSON.stringify({active:'text'}));
  assert.match((await api('/api/paper?path=dual')).data.preferredTextPath,/markdown\.md$/);
  checks.push('existing Markdown prevents extraction and always wins over legacy text preference');
  await open('foreign');await page.evaluate(()=>window.PaperBenchEnsurePaperText('foreign'));
  assert.equal(await page.evaluate(()=>window.__extracts.includes('foreign')),false);
  assert.equal(await readFile(path.join(library,'foreign/pdf-text.txt'),'utf8'),'User-owned text');
  checks.push('user-provided TXT is reused without overwrite');
  // PDF signature changes invalidate only program-generated, unmodified TXT.
  const updated=await PDFDocument.create(),pg=updated.addPage([612,792]);pg.drawText('Updated PDF body for regeneration.',{x:50,y:700});
  await writeFile(path.join(library,'only/source.pdf'),await updated.save());
  assert.equal((await api('/api/pdf-processing/status?paper=only')).data.needsText,true);
  assert.equal((await api('/api/paper?path=only')).data.preferredTextPath,null);
  await page.evaluate(()=>window.PaperBenchEnsurePaperText('only'));
  assert.match(await readFile(path.join(library,'only/pdf-text.txt'),'utf8'),/Updated PDF body/);
  await writeFile(path.join(library,'only/pdf-text.txt'),'User edit');
  await writeFile(path.join(library,'only/source.pdf'),bytes);
  await page.evaluate(()=>window.PaperBenchEnsurePaperText('only'));
  assert.equal(await readFile(path.join(library,'only/pdf-text.txt'),'utf8'),'User edit');
  checks.push('PDF changes regenerate stale generated text, while edited TXT is retained');
  await open('empty');
  await page.evaluate(()=>window.PaperBenchEnsurePaperText('empty').then(()=>{throw Error('unexpected success');},()=>{}));
  await assert.rejects(access(path.join(library,'empty/pdf-text.txt')));
  await page.locator('#mineruParse').click();assert.match(await page.locator('#pdfTextStatus').innerText(),/没有可提取/);await page.keyboard.press('Escape');
  checks.push('scan/empty PDF leaves no misleading text and shows a readable preparation failure');
  await writeFile(path.join(library,'only/markdown.md'),'# Reused fine result');
  assert.equal((await api('/api/local-mineru/start',{paper:'only',removePrevious:'true'})).ok,true);
  assert.equal(await readFile(path.join(library,'only/pdf-text.txt'),'utf8'),'User edit');
  assert.match((await api('/api/paper?path=only')).data.preferredTextPath,/markdown\.md$/);
  checks.push('fine results take priority and cleanup preserves edited TXT');
  for(const name of ['roundtrip','fail-parse']){
    await page.evaluate(p=>window.PaperBenchEnsurePaperText(p),name);
    const saved=await readFile(path.join(library,name,'pdf-text.txt'),'utf8');
    await mkdir(path.join(library,name,'images'),{recursive:true});await writeFile(path.join(library,name,'images/personal.png'),'personal');
    assert.equal((await api('/api/local-mineru/start',{paper:name,removePrevious:'true'})).ok,true);
    let state='running';for(let i=0;i<100&&state==='running';i++){await new Promise(r=>setTimeout(r,100));state=(await api('/api/local-mineru/status?paper='+name)).data.state;}
    if(name==='roundtrip'){assert.equal(state,'completed');await access(path.join(library,name,'markdown.md'));await assert.rejects(access(path.join(library,name,'pdf-text.txt')));}
    else{assert.equal(state,'failed');assert.equal(await readFile(path.join(library,name,'pdf-text.txt'),'utf8'),saved);}
    await access(path.join(library,name,'images/personal.png'));
  }
  checks.push('real fine parse lifecycle: cleanup follows success; failure keeps TXT and unrelated images');
  // A background save must not override Markdown arriving during extraction.
  await mkdir(path.join(library,'race'),{recursive:true});await writeFile(path.join(library,'race/source.pdf'),bytes);
  const raceSig=(await api('/api/pdf-processing/status?paper=race')).data.signature;
  await writeFile(path.join(library,'race/markdown.md'),'# Newly completed Markdown');
  const race=await api('/api/pdf-processing/text',{paper:'race',signature:raceSig,text:'Late text',removePrevious:true});
  assert.equal(race.ok,true);assert.match(race.data.preferredTextPath,/markdown\.md$/);await assert.rejects(access(path.join(library,'race/pdf-text.txt')));
  checks.push('late text save never replaces new Markdown or deletes fine outputs');
  for(const name of ['wait-send','switch-send','citation-send']){await mkdir(path.join(library,name),{recursive:true});await writeFile(path.join(library,name,'source.pdf'),bytes);}
  await page.locator('#refreshTree').click();await page.waitForSelector('.tree-row.paper[data-paper="wait-send"]');
  await page.evaluate(()=>{const extract=window.PaperBenchPdfProcessing.extract;window.PaperBenchPdfProcessing.extract=async function(paper,...args){if(paper==='wait-send'||paper==='switch-send'||paper==='citation-send'){window.__holding=paper;await new Promise(resolve=>window.__releaseText=resolve);}return extract.call(this,paper,...args);};});
  await open('wait-send');await page.waitForFunction(()=>window.__holding==='wait-send');
  await page.evaluate(()=>Promise.race([window.PaperBenchEnsurePaperText('dual'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Ready Markdown blocked by unrelated extraction')),1000))]));
  await page.evaluate(()=>{const v=window.AILiteratureChat.view;v.elements.input.value='Summarize this whole paper';window.__pendingSend=v.send();});
  await page.waitForSelector('.paper-text-chat-status');assert.equal(await page.evaluate(()=>window.__sent?.length||0),0);
  assert.equal(await page.locator('.zcs-input').inputValue(),'Summarize this whole paper');
  await page.evaluate(()=>window.__releaseText());await page.evaluate(()=>window.__pendingSend);
  const sent=await page.evaluate(()=>window.__sent);assert.equal(sent.length,1);assert.equal(sent[0].paper,'wait-send');assert.match(sent[0].preferred,/pdf-text\.txt$/);
  await open('switch-send');await page.waitForFunction(()=>window.__holding==='switch-send');
  await page.evaluate(()=>{const v=window.AILiteratureChat.view;v.elements.input.value='Do not send to another paper';window.__pendingSend=v.send();});
  await page.waitForSelector('.paper-text-chat-status');await open('foreign');await page.evaluate(()=>window.__releaseText());await page.evaluate(()=>window.__pendingSend);
  assert.equal(await page.evaluate(()=>window.__sent.length),1);
  assert.match(await readFile(path.join(library,'switch-send/pdf-text.txt'),'utf8'),/Synthetic page/);
  assert.equal(await readFile(path.join(library,'foreign/pdf-text.txt'),'utf8'),'User-owned text');
  checks.push('full-paper send waits without losing draft; switching papers cancels pending send but saves correct TXT');
  let recognitionCalls=0;
  await page.route('**/api/citation/recognize',async route=>{
    recognitionCalls++;
    assert.match(await readFile(path.join(library,'citation-send/pdf-text.txt'),'utf8'),/Synthetic page/);
    const scan=(await api('/api/citation/scan?paper=citation-send')).data;
    await route.fulfill({json:{status:'review',title:scan.title,candidates:scan.candidates,matches:[],reason:'PDF.js citation preparation verified',warning:scan.warning}});
  });
  await open('citation-send');await page.waitForFunction(()=>window.__holding==='citation-send');
  await page.locator('#openCitations').click();await page.waitForTimeout(150);assert.equal(recognitionCalls,0);
  await page.evaluate(()=>window.__releaseText());
  await page.waitForFunction(()=>document.body.textContent.includes('PDF.js citation preparation verified'));
  assert.equal(recognitionCalls,1);await page.keyboard.press('Escape');
  checks.push('citation window waits for PDF.js text before recognizing, without external PDF tools');
  frame=await open('foreign');
  await page.locator('.zcs-capture-button').click();await frame.locator('.pb-capture-layer').waitFor();
  await frame.press('body','Escape');assert.equal(await frame.locator('.pb-capture-layer').count(),0);
  await page.locator('.zcs-capture-button').click();await frame.locator('.pb-capture-layer').waitFor();
  const box=await frame.locator('.page[data-page-number="1"]').boundingBox();
  // Known red rectangle is entirely inside the first page; screenshot uses PDF rendering.
  const ratio=box.width/612;
  await page.mouse.move(box.x+55*ratio,box.y+177*ratio);await page.mouse.down();
  await page.mouse.move(box.x+285*ratio,box.y+347*ratio,{steps:8});await page.mouse.up();
  await page.waitForFunction(()=>window.AILiteratureChat.view.images.length===1);
  const image=await page.evaluate(async()=>{
    const entry=window.AILiteratureChat.view.images[0],img=new Image();img.src=entry.url;await img.decode();
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
    return {name:entry.name,width:img.width,height:img.height,pixel:[...ctx.getImageData(img.width/2,img.height/2,1,1).data]};
  });
  assert.ok(image.width>400&&image.height>300);assert.ok(image.pixel[0]>180&&image.pixel[1]<80);
  assert.match(image.name,/第 1 页/);assert.equal(await page.locator('.zcs-send-button>svg').count(),1);
  await page.evaluate(()=>window.AILiteratureChat.view.setRunning(true));
  assert.equal(await page.locator('.zcs-send-stop').textContent(),'■');assert.equal(await page.locator('.zcs-capture-button').isDisabled(),true);
  await page.evaluate(()=>window.AILiteratureChat.view.setRunning(false));
  assert.equal(await page.locator('.zcs-send-button>svg').count(),1);
  checks.push('chat icon starts/cancels region capture; clear PNG attachment; SVG send and stop states preserved');
  await writeFile(path.join(library,'empty/.paperbench-parsing.json'),'{invalid');
  assert.equal((await api('/api/paper?path=empty')).ok,true);
  checks.push('damaged parse preference does not prevent ordinary PDF reading');
  await page.screenshot({path:path.join(root,'features.png')});
  assert.deepEqual(errors,[]);
  await writeFile(path.join(root,'results.json'),JSON.stringify({passed:true,checks,image},null,2));
  console.log(JSON.stringify({passed:true,checks,image},null,2));
}catch(error){if(page)await page.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});console.log({errors});throw error;}
finally{if(browser)await browser.close();host.kill();}
