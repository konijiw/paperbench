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
  await page.route('**/api/local-mineru/status?*',route=>route.fulfill({json:{available:false,state:'idle',running:0,capacity:2}}));
  await page.addInitScript(()=>{localStorage.setItem('ai-literature-reader.ai-collapsed','false');localStorage.setItem('ai-literature-reader.notes-collapsed','true');});
  await page.goto(url);
  const open=async name=>{
    await page.locator(`.tree-row.paper[data-paper="${name}"]`).click();
    await page.waitForFunction(name=>document.getElementById('paperMeta').textContent===name,name);
    await page.waitForFunction(name=>window.AILiteratureChat?.view?.contextTransitioning===false&&window.AILiteratureChat.view.context?.title===name,name);
    if(await page.locator('#pdfRail').isVisible())await page.locator('#pdfRail').click();
    await page.waitForFunction(name=>document.getElementById('pdfFrame').src.includes('paper='+name),name);
    const iframe=await page.locator('#pdfFrame').elementHandle(),frame=await iframe.contentFrame();
    await frame.waitForSelector('.page[data-page-number="1"] canvas');
    return frame;
  };
  let frame=await open('only');
  await page.locator('#mineruParse').click();await page.locator('#pdfParseMenu').waitFor({state:'visible'});
  assert.equal(await page.locator('#pdfParseFine').isDisabled(),true);
  assert.equal(await page.locator('#pdfParseText').isEnabled(),true);
  await page.screenshot({path:path.join(root,'parse-menu.png')});
  checks.push('inline chooser; unavailable MinerU disabled; text mode enabled');
  await page.locator('#pdfParseText').click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('文本已保存'));
  const text=await readFile(path.join(library,'only/pdf-text.txt'),'utf8');
  assert.match(text,/Synthetic page 1/);assert.match(text,/Synthetic page 2/);assert.match(text,/2 \/ 2/);
  assert.match(await page.evaluate(()=>window.AILiteratureChat.view.context.preferredTextPath),/pdf-text\.txt$/);
  checks.push('all PDF pages extracted to sibling TXT with physical page markers');
  // Updated file must never be overwritten on retry.
  const sig=(await api('/api/pdf-processing/status?paper=only')).data.signature;
  await writeFile(path.join(library,'only/pdf-text.txt'),'User edit');
  assert.equal((await api('/api/pdf-processing/text',{paper:'only',signature:sig,text:'replacement'})).ok,false);
  assert.equal(await readFile(path.join(library,'only/pdf-text.txt'),'utf8'),'User edit');
  const foreign=(await api('/api/pdf-processing/status?paper=foreign')).data.signature;
  assert.equal((await api('/api/pdf-processing/text',{paper:'foreign',signature:foreign,text:'replacement'})).ok,false);
  checks.push('modified and unrelated TXT files protected');
  // A failed scan extraction does not delete old results or publish empty TXT.
  await open('empty');await page.locator('#mineruParse').click();await page.locator('#pdfParseText').click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('没有可提取'));
  await assert.rejects(access(path.join(library,'empty/pdf-text.txt')));
  checks.push('image-only/empty PDF reports no text and creates no misleading TXT');
  const dualSig=(await api('/api/pdf-processing/status?paper=dual')).data.signature;
  assert.equal((await api('/api/pdf-processing/text',{paper:'dual',signature:dualSig,text:'First text extraction'})).ok,true);
  await access(path.join(library,'dual/markdown.md'));
  assert.match((await api('/api/paper?path=dual')).data.preferredTextPath,/pdf-text\.txt$/);
  await writeFile(path.join(library,'dual/structured_content.json'),'{"userEdited":true}');
  checks.push('default preserves old parse; AI context follows selected parsing mode');
  await open('dual');
  await page.locator('#mineruParse').click();await page.locator('#pdfParseCleanup').check();await page.locator('#pdfParseText').click();
  await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('文本已保存'));
  await assert.rejects(access(path.join(library,'dual/markdown.md')));
  await assert.rejects(access(path.join(library,'dual/images/parsed.png')));
  await access(path.join(library,'dual/images/personal.png'));await access(path.join(library,'dual/source.pdf'));
  assert.equal(await readFile(path.join(library,'dual/structured_content.json'),'utf8'),'{"userEdited":true}');
  checks.push('successful mode switch cleans only known old outputs; unrelated image and PDF retained');
  // Existing fine results can be selected again, retaining edited TXT.
  await writeFile(path.join(library,'only/markdown.md'),'# Reused fine result');
  assert.equal((await api('/api/local-mineru/start',{paper:'only',removePrevious:'true'})).ok,true);
  assert.equal(await readFile(path.join(library,'only/pdf-text.txt'),'utf8'),'User edit');
  checks.push('switching to existing fine result protects modified TXT');
  for(const name of ['roundtrip','fail-parse']){
    const signature=(await api('/api/pdf-processing/status?paper='+name)).data.signature;
    assert.equal((await api('/api/pdf-processing/text',{paper:name,signature,text:'Preserve until fine succeeds'})).ok,true);
    await mkdir(path.join(library,name,'images'),{recursive:true});
    await writeFile(path.join(library,name,'images/personal.png'),'personal');
    assert.equal((await api('/api/local-mineru/start',{paper:name,removePrevious:'true'})).ok,true);
    let state='running';
    for(let i=0;i<100&&state==='running';i++){
      await new Promise(r=>setTimeout(r,100));state=(await api('/api/local-mineru/status?paper='+name)).data.state;
    }
    if(name==='roundtrip'){
      assert.equal(state,'completed');await access(path.join(library,name,'markdown.md'));
      await assert.rejects(access(path.join(library,name,'pdf-text.txt')));
    }else{
      assert.equal(state,'failed');assert.equal(await readFile(path.join(library,name,'pdf-text.txt'),'utf8'),'Preserve until fine succeeds');
    }
    await access(path.join(library,name,'images/personal.png'));
  }
  checks.push('real fine-parse lifecycle with stub parser: merge existing images; cleanup after success only; failure retains TXT');
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
