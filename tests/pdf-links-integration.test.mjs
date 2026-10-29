import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [executable,label='current',expected='working']=process.argv.slice(2);
if(!executable||!process.env.PDF_LAB_MODULES)throw new Error('Pass executable, label and working/blocked; set PDF_LAB_MODULES.');
const require=createRequire(path.join(process.env.PDF_LAB_MODULES,'_links.cjs'));
const {chromium}=require('playwright'),{PDFDocument,StandardFonts,PDFName,PDFString}=require('pdf-lib');
const root=path.join(project,'tests/runtime/pdf-links',label),library=path.join(root,'library');
await mkdir(path.join(library,'links'),{recursive:true});
await mkdir(path.join(root,'state/ai-literature-reader'),{recursive:true});
await copyFile(executable,path.join(root,'PaperBench.exe'));
await writeFile(path.join(root,'state/ai-literature-reader/settings.json'),JSON.stringify({libraryRoot:library}));
const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),pdfPage=doc.addPage([612,792]);
const lines=['Highlighted external link','Plain external link','An ordinary highlighted note'];
const annotations=[];
for(const [i,text] of lines.entries()){
  const y=700-i*45,width=font.widthOfTextAtSize(text,14);
  pdfPage.drawText(text,{x:50,y,size:14,font});
  if(i<2)annotations.push(doc.context.register(doc.context.obj({Type:'Annot',Subtype:'Link',Rect:[50,y-3,50+width,y+16],Border:[0,0,0],A:{Type:'Action',S:'URI',URI:PDFString.of('https://pdf-links.test/link-'+i)}})));
}
pdfPage.node.set(PDFName.of('Annots'),doc.context.obj(annotations));
await writeFile(path.join(library,'links/source.pdf'),await doc.save());
const hostPath=path.join(root,'TestHost.exe');
execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:exe',`/out:${hostPath}`,path.join(project,'tests/PdfReaderTestHost.cs')],{windowsHide:true});
const host=spawn(hostPath,[path.join(root,'PaperBench.exe')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let browser;
try{
  const url=await new Promise((resolve,reject)=>{
    let output='';host.stdout.on('data',b=>{output+=b;const match=/PDF_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output);if(match)resolve(match[1]);});
    host.on('error',reject);host.on('exit',code=>reject(new Error('Host exited '+code)));
    setTimeout(()=>reject(new Error('Host startup timed out')),15000).unref();
  });
  const paper=await (await fetch(url+'/api/paper?path=links')).json();
  Object.assign(paper.review,{pdfCollapsed:false,annotations:[0,2].map(i=>({id:'note-'+i,quote:lines[i],prefix:'',suffix:'',comment:'Comment '+i,kind:'note'}))});
  assert.ok((await fetch(url+'/api/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({paperPath:'links',review:paper.review})})).ok);
  browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1600,height:1000}}),page=await context.newPage(),opened=[];
  await context.route('https://pdf-links.test/**',route=>route.fulfill({contentType:'text/html',body:'Link test destination'}));
  context.on('page',popup=>popup.on('domcontentloaded',()=>opened.push(popup.url())));
  await page.route('**/assets/zcs/ai-chat.js',route=>route.fulfill({contentType:'application/javascript',body:'window.AILiteratureChat={mount:async()=>{},setPaper:async()=>{},focus:()=>{}};'}));
  await page.addInitScript(()=>{localStorage.setItem('ai-literature-reader.ai-collapsed','true');localStorage.setItem('ai-literature-reader.notes-collapsed','false');});
  await page.goto(url);await page.locator('.tree-row.paper[data-paper="links"]').click();
  const frame=await (await page.locator('#pdfFrame').elementHandle()).contentFrame();
  await frame.waitForSelector('.annotationLayer a[href="https://pdf-links.test/link-0"]');
  await frame.waitForSelector('.pb-highlight-target[data-annotation-id="note-0"]');
  const results=[];
  for(let i=0;i<2;i++){
    const anchor=frame.locator(`.annotationLayer a[href="https://pdf-links.test/link-${i}"]`);
    const hit=await anchor.evaluate(el=>{
      const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {onLink:el===target||el.contains(target),target:target?.outerHTML.slice(0,180),textZ:getComputedStyle(document.querySelector('.textLayer')).zIndex,linkZ:getComputedStyle(el.closest('.annotationLayer')).zIndex};
    });
    const r=await anchor.boundingBox();await page.mouse.click(r.x+r.width/2,r.y+r.height/2);await page.waitForTimeout(350);
    results.push({highlighted:i===0,...hit,opened:opened.includes('https://pdf-links.test/link-'+i)});
    assert.equal(hit.onLink,expected==='working');assert.equal(results.at(-1).opened,expected==='working');
  }
  if(expected==='working'){
    await frame.locator('.pb-highlight-target[data-annotation-id="note-2"]').waitFor();
    const text=frame.locator('.textLayer span').filter({hasText:lines[2]}).first(),r=await text.boundingBox();
    await page.mouse.click(r.x+15,r.y+r.height/2);await page.waitForSelector('.annotation-card.active[data-id="note-2"]');
    await page.mouse.move(r.x+15,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+100,r.y+r.height/2,{steps:8});await page.mouse.up();
    assert.ok(await frame.evaluate(()=>window.getSelection().toString().length>0));
  }
  await writeFile(path.join(root,'results.json'),JSON.stringify({label,expected,results},null,2));
  console.log(JSON.stringify({label,expected,results},null,2));
}finally{if(browser)await browser.close();host.kill();}
