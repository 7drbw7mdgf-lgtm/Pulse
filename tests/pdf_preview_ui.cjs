const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-pdf-preview-'));
 const python=process.env.PULSE_TEST_PYTHON||'python3';
 const pdf=path.join(profile,'fixture.pdf');
 const generated=spawnSync(python,['-c',"import pymupdf,sys;d=pymupdf.open();p=d.new_page();p.insert_text((50,70),'This open paper contains a verified passage.',fontsize=14);p=d.new_page();p.insert_text((50,70),'A limitation is the small sample size.',fontsize=14);d.save(sys.argv[1])",pdf]);
 assert.equal(generated.status,0,String(generated.stderr));
 const bytes=fs.readFileSync(pdf),identity=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
 fs.mkdirSync(path.join(profile,'pdf-previews'));fs.writeFileSync(path.join(profile,'pdf-previews',identity+'.pdf'),bytes);
 const long='averylongunbrokencitationorkeyword'.repeat(18);
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers:[
  {id:'open',title:'Open paper: '+long,authors:['Example Researcher'],year:'2026',journal:'Open journal',abstract:('Abstract text '+long+' ').repeat(12),notes:long,userTags:[long],selected:true,mapIds:['map-1'],metadataMatch:{matched:true},metadataCheckedAt:new Date().toISOString()},
  {id:'closed',title:'Paper without an open PDF',selected:true,mapIds:['map-1'],metadataMatch:{matched:true},metadataCheckedAt:new Date().toISOString()},
  {id:'slow',title:'Slow lookup',selected:true,mapIds:['map-1'],metadataMatch:{matched:true},metadataCheckedAt:new Date().toISOString()}
 ],maps:[{id:'map-1',name:'Map 1'}],activeMapId:'map-1'}));
 const backend=spawn(python,['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
 let browser;
 try {
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.route('**/api/papers/metrics',route=>route.fulfill({json:{citationCount:10,referenceCount:20}}));
  await page.route('**/api/metadata/resolve',route=>route.fulfill({json:{matched:false,metadata:{}}}));
  const file={id:identity,name:'Open paper.pdf',size:bytes.length,pages:2,preview:true,url:'https://open.example.org/paper.pdf',source:'OpenAlex'};
  let lookups=0,slowStarted=false;
  await page.route('**/api/reader/preview',async route=>{
   lookups++;const paper=route.request().postDataJSON().paper;
   if(paper.title.startsWith('Slow')){slowStarted=true;await new Promise(resolve=>setTimeout(resolve,450));return route.fulfill({json:file}).catch(()=>{});}
   if(paper.title.startsWith('Paper without'))return route.fulfill({status:404,json:{error:'No accessible open PDF was found. Attach a PDF you have access to.'}});
   return route.fulfill({json:file});
  });
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===3);
  await page.evaluate(()=>{state.selectedId='open';renderDetails();});
  for(const width of [260,300,380]){
   await page.evaluate(width=>els.app.style.setProperty('--inspector-width',width+'px'),width);
   for(const tab of ['overview','connections','notes']){
    await page.evaluate(tab=>{setInspectorTab(tab);renderDetails();},tab);
    const dimensions=await page.evaluate(()=>({panel:[els.details.scrollWidth,els.details.clientWidth],content:[els.detailsContent.scrollWidth,els.detailsContent.clientWidth]}));
    for(const [name,[scroll,client]]of Object.entries(dimensions))assert(scroll<=client+1,`${name} must not scroll sideways at ${width}px in ${tab}: ${scroll}/${client}`);
    const actions=await page.locator('.insp-actions').evaluate(el=>[...el.children].map(child=>({top:child.offsetTop,height:child.getBoundingClientRect().height})));
    assert(actions[0].height<75&&actions[2].height<75,'Action labels must remain readable, not squeeze into vertical letters');
    assert(actions[2].top>actions[0].top,'Discover related belongs on the second action row');
   }
  }
  await page.evaluate(()=>{setInspectorTab('overview');renderDetails();els.detailsContent.scrollTop=200;});
  assert(await page.evaluate(()=>els.detailsContent.scrollTop)>0,'Details scroll vertically');
  await page.click('[data-read-pdf]');await page.waitForFunction(()=>document.querySelectorAll('.pdf-text-layer span').length>3);
  assert.equal(await page.locator('#pdfReadMode').innerText(),'Preview');assert.equal(await page.locator('#pdfAnnotationSidebar').isVisible(),false);
  assert.equal(await page.evaluate(()=>state.papers.find(p=>p.id==='open').pdfAttachments.length),0);
  assert.equal(fs.existsSync(path.join(profile,'pdfs')),false,'Preview must not retain an attachment');
  const denied=await page.evaluate(async id=>{const response=await fetch(backendUrl('/api/reader/passage'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({id,page:1,quote:'This open paper contains a verified passage.'})});return response.status;},identity);
  assert.equal(denied,409,'Backend also enforces read-only preview');
  assert.equal((await fetch(url+'/api/reader/file/'+identity)).status,403,'PDF downloads require the app session');
  await page.click('#pdfNextPage');await page.waitForFunction(()=>document.querySelector('.pdf-text-layer')?.textContent.includes('limitation'));
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'open-pdf-preview.png')});}
  const download=page.waitForEvent('download');await page.click('#pdfDownloadCopy');const saved=await download;
  assert.equal(saved.suggestedFilename(),'Open paper.pdf');assert.equal(fs.readFileSync(await saved.path()).subarray(0,5).toString(),'%PDF-');
  await page.waitForFunction(()=>document.getElementById('pdfReadMode').textContent==='Local copy');
  assert.equal(await page.locator('#pdfAnnotationSidebar').isVisible(),true);assert.equal(fs.existsSync(path.join(profile,'pdfs',identity+'.pdf')),true);
  await page.evaluate(()=>{const layer=document.querySelector('.pdf-text-layer'),range=document.createRange();range.selectNodeContents(layer);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.getElementById('pdfPageSurface').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});
  await page.fill('#pdfAnnotationMemo',long);await page.click('#pdfSaveHighlight');await page.waitForFunction(()=>state.papers.find(p=>p.id==='open').pdfAnnotations.length===1);
  const sidebar=await page.locator('#pdfAnnotationSidebar').evaluate(el=>[el.scrollWidth,el.clientWidth]);assert(sidebar[0]<=sidebar[1]+1,'Reader sidebar wraps long text');
  await page.click('#pdfReaderClose');await page.evaluate(()=>saveLibrary());await page.reload();await page.waitForFunction(()=>state.autosaveReady);
  const before=lookups;await page.evaluate(()=>PulsePDF.open('open',2));await page.waitForFunction(()=>document.querySelectorAll('.pdf-text-layer span').length>3);
  assert.equal(lookups,before,'Saved copy reopens locally');assert.equal(await page.locator('.pdf-highlights span').count()>0,true);
  await page.click('#pdfReaderClose');await page.evaluate(()=>PulsePDF.open('closed'));assert.match(await page.locator('#pdfReaderStatus').innerText(),/No accessible open PDF/);
  assert.equal(await page.locator('#pdfDownloadCopy').isVisible(),false);assert.equal(await page.locator('#pdfAttachInput').isEnabled(),true);assert.equal(await page.locator('#pdfFindOpen').isEnabled(),true);
  await page.evaluate(()=>{PulsePDF.open('slow');});await page.waitForTimeout(80);assert(slowStarted);
  await page.evaluate(()=>PulsePDF.open('closed'));await page.waitForTimeout(600);
  assert.equal(await page.locator('#pdfReaderTitle').innerText(),'Paper without an open PDF');assert.equal(await page.locator('.pdf-page img').count(),0,'A stale result cannot replace another paper');
  await page.click('#pdfReaderClose');await page.setViewportSize({width:976,height:720});await page.evaluate(()=>{state.selectedId='open';setInspectorTab('overview');renderDetails();els.detailsContent.scrollTop=0;});
  const narrow=await page.evaluate(()=>[els.detailsContent.scrollWidth,els.detailsContent.clientWidth]);assert(narrow[0]<=narrow[1]+1);
  if(process.env.PULSE_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'paper-details-vertical.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: read-only open PDF preview, paging, download and local annotation, retained offline copy, unavailable sources, stale lookup protection, authenticated file transfer and vertical-only detail/reader sidebars.');
 }finally{await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
