const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-pdf-viewer-'));
 const python=process.env.PULSE_TEST_PYTHON||'python3',pdf=path.join(profile,'viewer.pdf');
 const generated=spawnSync(python,['-c',`import pymupdf as f,sys
d=f.open()
for n in range(1,7):
    p=d.new_page();p.insert_text((50,70),f'Page {n} opening line for the viewer test.',fontsize=14)
d[0].insert_text((50,120),'See the reference list for sources.',fontsize=12)
d[2].insert_text((50,120),'Methods are described on page three.',fontsize=12)
d[3].insert_text((50,120),'Findings continue on page four with selectable text.',fontsize=12)
d[4].insert_text((50,400),'References',fontsize=14)
d[0].insert_link({'kind':f.LINK_GOTO,'from':f.Rect(50,108,240,124),'page':4,'to':f.Point(50,388)})
d[0].insert_link({'kind':f.LINK_URI,'from':f.Rect(50,150,240,166),'uri':'https://example.org/data'})
d.set_toc([[1,'Introduction',1],[1,'Methods',3],[1,'References',5,{'kind':f.LINK_GOTO,'page':4,'to':f.Point(50,388)}]])
d.save(sys.argv[1])`,pdf]);
 assert.equal(generated.status,0,String(generated.stderr));
 const bytes=fs.readFileSync(pdf),identity=crypto.createHash('sha256').update(bytes).digest('hex');
 fs.mkdirSync(path.join(profile,'pdfs'));fs.writeFileSync(path.join(profile,'pdfs',identity+'.pdf'),bytes);
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers:[{id:'a',title:'Viewer paper',authors:['Ada One'],year:'2026',selected:true,mapIds:['map-1'],
  pdfAttachments:[{id:identity,name:'Viewer.pdf',pages:6,size:bytes.length}],metadataMatch:{matched:true},metadataCheckedAt:new Date().toISOString()}],maps:[{id:'map-1',name:'Map 1'}],activeMapId:'map-1'}));
 const backend=spawn(python,['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
 let browser;
 try {
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:900},deviceScaleFactor:2}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.route('**/api/papers/metrics',route=>route.fulfill({json:{citationCount:1,referenceCount:1}}));
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===1);
  const current=()=>page.evaluate(()=>Number(document.getElementById('pdfPageNumber').value));
  const waitPage=number=>page.waitForFunction(number=>document.getElementById('pdfPageNumber').value===String(number)&&document.querySelector('#pdfPageSurface>img')?.complete,number);
  const sharpness=()=>page.evaluate(()=>{const img=document.querySelector('#pdfPageSurface>img');return img.naturalWidth/img.clientWidth;});

  // Continuous scroll with only nearby pages rendered.
  await page.evaluate(()=>PulsePDF.open('a'));await page.waitForFunction(()=>document.querySelectorAll('#pdfPageSurface .pdf-text-layer span').length>3);
  assert.equal(await page.locator('#pdfPageStack .pdf-page').count(),6,'Every page has a sized place in the scroll');
  assert(await page.locator('#pdfPageStack .pdf-page>img').count()<6,'Distant pages are not rendered up front');
  assert.equal(await current(),1);
  assert(await sharpness()>=1.8,'Pages render at the screen density');
  await page.evaluate(()=>{const v=document.getElementById('pdfViewport'),p=document.querySelector('.pdf-page[data-pdf-page="4"]');v.scrollTop=p.offsetTop+document.getElementById('pdfPageStack').offsetTop+40;});
  await waitPage(4);

  // Zoom: presets, keyboard, Ctrl+wheel, fit page and fit width.
  await page.selectOption('#pdfZoom','2');await page.waitForFunction(()=>Math.abs(document.getElementById('pdfPageSurface').clientWidth-595*2)<2);
  await page.waitForFunction(()=>{const img=document.querySelector('#pdfPageSurface>img');return img.naturalWidth/img.clientWidth>=1.8;});
  assert.equal(await current(),4,'Zooming keeps the reading position');
  await page.focus('#pdfViewport');await page.keyboard.press('Control+-');assert.equal(await page.inputValue('#pdfZoom'),'1.5');
  const box=await page.locator('#pdfViewport').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+200);
  await page.keyboard.down('Control');await page.mouse.wheel(0,-60);await page.keyboard.up('Control');
  const pinched=await page.evaluate(()=>PulsePDF.context().scale);assert(pinched>1.6&&pinched<4,'Ctrl+scroll zooms in: '+pinched);
  assert.match(await page.locator('#pdfZoom option:checked').innerText(),/^\d+%$/);
  await page.selectOption('#pdfZoom','page');
  assert(await page.evaluate(()=>document.getElementById('pdfPageSurface').offsetHeight<=document.getElementById('pdfViewport').clientHeight),'Fit page shows a whole page');
  await page.keyboard.press('Control+0');assert.equal(await page.inputValue('#pdfZoom'),'fit');

  // Keyboard navigation.
  await page.focus('#pdfViewport');await page.keyboard.press('End');await waitPage(6);
  await page.keyboard.press('Home');await waitPage(1);
  await page.keyboard.press('ArrowRight');await waitPage(2);
  const before=await page.evaluate(()=>document.getElementById('pdfViewport').scrollTop);await page.keyboard.press('PageDown');
  await page.waitForFunction(before=>document.getElementById('pdfViewport').scrollTop>before+300,before);

  // Contents from bookmarks, with the current section marked.
  await page.click('[data-pdf-pane="contents"]');await page.waitForFunction(()=>document.querySelectorAll('[data-pdf-outline]').length===3);
  assert.deepEqual(await page.locator('[data-pdf-outline] span').allInnerTexts(),['Introduction','Methods','References']);
  await page.locator('[data-pdf-outline]',{hasText:'References'}).click();await waitPage(5);
  assert.equal(await page.locator('[data-pdf-outline][aria-current=true] span').innerText(),'References');
  const landed=await page.evaluate(()=>{const v=document.getElementById('pdfViewport').getBoundingClientRect(),p=document.getElementById('pdfPageSurface').getBoundingClientRect(),y=p.top+p.height*388/842;return y>v.top&&y<v.bottom;});
  assert(landed,'A bookmark scrolls its heading into view');

  // Links inside the paper.
  await page.keyboard.press('Home');await waitPage(1);
  const external=page.locator('#pdfPageSurface .pdf-link-layer a[href="https://example.org/data"]');
  assert.equal(await external.count(),1);assert.equal(await external.getAttribute('target'),'_blank');assert.equal(await external.getAttribute('rel'),'noreferrer');
  await page.locator('#pdfPageSurface .pdf-link-layer a[title^="Go to page"]').click();await waitPage(5);

  // Reading position is remembered per PDF; an explicit page still wins.
  await page.fill('#pdfPageNumber','3');await page.locator('#pdfPageNumber').press('Tab');await waitPage(3);await page.waitForTimeout(450);
  await page.click('#pdfReaderClose');await page.evaluate(()=>PulsePDF.open('a'));await waitPage(3);
  await page.click('#pdfReaderClose');await page.evaluate(()=>PulsePDF.open('a',2));await waitPage(2);

  // Drawing and selecting work on whichever page is under the pointer.
  await page.selectOption('#pdfZoom','0.5');await page.waitForFunction(()=>document.querySelector('.pdf-page[data-pdf-page="3"]>img')?.complete);
  await page.locator('[data-pdf-workspace="edit"]').click();await page.locator('[data-pdf-tool="rectangle"]').click();
  await page.evaluate(()=>{const v=document.getElementById('pdfViewport'),p=document.querySelector('.pdf-page[data-pdf-page="3"]');v.scrollTop=p.offsetTop+document.getElementById('pdfPageStack').offsetTop-v.clientHeight/2+60;});
  await page.waitForTimeout(100);assert.notEqual(await current(),3,'Page 3 is on screen but not yet current');
  const third=await page.locator('.pdf-page[data-pdf-page="3"]').boundingBox();
  await page.mouse.move(third.x+40,third.y+60);await page.mouse.down();await page.mouse.move(third.x+140,third.y+120,{steps:4});await page.mouse.up();
  await page.waitForFunction(()=>state.papers[0].pdfAnnotations?.some(a=>a.kind==='rectangle'&&a.page===3));
  assert.equal(await page.evaluate(()=>PulsePDF.context().pageNumber),3,'Drawing on a page makes it current');
  await page.locator('[data-pdf-workspace="read"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('.pdf-page[data-pdf-page="4"] .pdf-text-layer span').length>3);
  await page.evaluate(()=>{const layer=document.querySelector('.pdf-page[data-pdf-page="4"] .pdf-text-layer'),range=document.createRange();range.selectNodeContents(layer);const s=window.getSelection();s.removeAllRanges();s.addRange(range);document.getElementById('pdfPageStack').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
  assert.equal(await page.evaluate(()=>PulsePDF.context().selection?.page),4);assert.match(await page.locator('#pdfSelectedQuote').innerText(),/Findings continue/);
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'pdf-viewer-continuous.png')});}
  assert.deepEqual(errors,[]);
  console.log('PASS: continuous scroll with lazy sharp pages, zoom presets/keys/Ctrl+scroll/fit page, keyboard paging, bookmarks contents, internal and web links, remembered reading position and per-page drawing/selection.');
 }finally{await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
