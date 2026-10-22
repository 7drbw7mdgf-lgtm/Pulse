const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-features-')),root=path.resolve(__dirname,'..');
 const python=process.env.PULSE_TEST_PYTHON||'python3';
 const fixture={papers:[
  {id:'a',title:'Campylobacter stress responses',authors:['Ada One'],year:'2024',abstract:'Campylobacter responds to oxidative stress.',notes:'First memo',userTags:['host'],readingStatus:'to-read',mapIds:['map-1'],selected:true,text:'bacterial host oxidative stress defence'},
  {id:'b',title:'Campylobacter immune defence',authors:['Ben Two'],year:'2023',abstract:'Oxidative stress drives immunity.',readingStatus:'read',mapIds:['map-1'],selected:true,text:'bacterial host oxidative stress defence'},
  {id:'c',title:'Membrane transport',authors:['Cyd Three'],year:'2022',abstract:'Cell trafficking systems.',readingStatus:'',mapIds:['map-1'],selected:true,text:'membrane transport mechanisms'},
  {id:'duplicate',title:'Campylobacter stress responses',authors:['Ada One'],year:'2023',abstract:'Campylobacter responds to oxidative stress.',notes:'Second memo',userTags:['bacteria'],mapIds:['map-2'],selected:false,text:'bacterial host oxidative stress defence'}
 ],maps:[{id:'map-1',name:'Map 1'},{id:'map-2',name:'Map 2'}],activeMapId:'map-1',threshold:.05};
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify(fixture));
 const pdf=path.join(profile,'reader-fixture.pdf');
 const generated=spawnSync(python,['-c',"import pymupdf,sys;d=pymupdf.open();p=d.new_page();p.insert_text((50,70),'Campylobacter responds to oxidative stress.',fontsize=14);p=d.new_page();p.insert_text((50,70),'A limitation is the small sample size.',fontsize=14);d.save(sys.argv[1])",pdf]);
 assert.equal(generated.status,0,String(generated.stderr));
 const backend=spawn(python,['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
 let browser;
 try {
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',chunk=>{const found=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(found){clearTimeout(timer);resolve(found[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1031}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&document.querySelectorAll('#map .node').length===3);
  assert.equal(await page.locator('#details').isVisible(),false,'Map details start closed');
  await page.click('#focusMapButton');await page.click('#focusMapButton');assert.equal(await page.locator('#details').isVisible(),false,'Focus mode preserves a closed details panel');
  await page.click('#inspectorReopen');
  await page.click('#focusMapButton');assert.equal(await page.locator('#colLibrary').isVisible(),false);assert.equal(await page.locator('#details').isVisible(),false);
  await page.click('#focusMapButton');assert.equal(await page.locator('#colLibrary').isVisible(),true);assert.equal(await page.locator('#details').isVisible(),true);
  const library=await page.locator('#colLibrary').boundingBox(),handle=await page.locator('.workspace-resizer[data-panel=library]').boundingBox();
  await page.mouse.move(handle.x+2,handle.y+100);await page.mouse.down();await page.mouse.move(handle.x+75,handle.y+100);await page.mouse.up();
  assert((await page.locator('#colLibrary').boundingBox()).width>library.width+50);
  await page.locator('.workspace-resizer[data-panel=inspector]').focus();const oldDetails=(await page.locator('#details').boundingBox()).width;await page.keyboard.press('ArrowLeft');assert((await page.locator('#details').boundingBox()).width>oldDetails);
  await page.fill('#networkSearchInput','stress');await page.waitForFunction(()=>document.querySelectorAll('#map .node.is-network-match').length===2);
  const positions=await page.evaluate(()=>state.papers.map(p=>[p.id,p.x,p.y]));
  await page.click('#networkSearchNext');await page.waitForFunction(()=>document.getElementById('networkSearchPosition').textContent==='1 of 2');
  await page.click('#networkSearchNext');await page.waitForFunction(()=>document.getElementById('networkSearchPosition').textContent==='2 of 2');
  await page.click('#networkSearchPrev');await page.waitForFunction(()=>document.getElementById('networkSearchPosition').textContent==='1 of 2');
  await page.click('#networkSearchFit');assert.deepEqual(await page.evaluate(()=>state.papers.map(p=>[p.id,p.x,p.y])),positions);
  await page.check('#networkSearchOnly');await page.waitForFunction(()=>document.querySelectorAll('#map .node.is-network-hidden').length===1);
  await page.locator('#networkSearchResults > summary').click();assert.match(await page.locator('#networkSearchResults').innerText(),/stress \(title\)/);
  await page.click('#networkSearchClear');await page.waitForFunction(()=>document.querySelectorAll('#map .is-network-hidden').length===0);
  await page.evaluate(()=>{state.links=[{source:'a',target:'b',score:.9,type:'citation',evidence:'A cites B'},{source:'b',target:'c',score:.8,type:'bibliographic',evidence:'2 shared references'}];render();});
  await page.click('#openPaperPaths');await page.selectOption('#pathStart','a');await page.selectOption('#pathEnd','c');await page.click('#findPaperPath');
  assert.equal(await page.locator('.paper-path-steps li').count(),3);assert.match(await page.locator('#paperPathResult').innerText(),/Shared references/);
  await page.click('#viewPaperPath');assert.equal(await page.locator('#map .node.is-path-node').count(),3);
  await page.click('#openSmartCollections');await page.fill('#collectionName','Campylobacter unread');await page.fill('#collectionQuery','Campylobacter + oxidative stress');await page.selectOption('#collectionStatus','unread');await page.click('#smartCollectionForm button[type=submit]');
  const collection=await page.evaluate(()=>state.libraryFeatures.collections[0].id);await page.click(`[data-collection-use="${collection}"]`);
  assert.equal(await page.locator('#paperList .pulse-paper-card,#paperList .paper-card,#paperList .library-table-row').count(),2);
  await page.evaluate(()=>{state.papers.find(p=>p.id==='duplicate').readingStatus='read';renderPapers();});assert.equal(await page.locator('#paperList .pulse-paper-card,#paperList .paper-card,#paperList .library-table-row').count(),1,'Collections respond to reading-status changes');
  await page.selectOption('#activeSmartCollection','');
  await page.click('#openDuplicateReview');assert.equal(await page.locator('.duplicate-pairs button').count(),1);
  await page.check('[name="merge-year"][value=duplicate]');await page.click('#confirmDuplicateMerge');
  await page.waitForFunction(()=>state.papers.length===3);const merged=await page.evaluate(()=>state.papers.find(p=>p.id==='a'));
  assert.equal(merged.year,'2023');assert.match(merged.notes,/First memo/);assert.match(merged.notes,/Second memo/);assert.deepEqual(merged.userTags,['host','bacteria']);assert.deepEqual(merged.mapIds,['map-1','map-2']);
  await page.click('#undoDuplicateMerge');await page.waitForFunction(()=>state.papers.length===4);assert.equal(await page.evaluate(()=>state.papers.find(p=>p.id==='a').notes),'First memo');await page.click('#closeLibraryTools');
  await page.evaluate(()=>{state.selectedId='a';renderDetails();});await page.click('[data-read-pdf]');await page.setInputFiles('#pdfAttachInput',pdf);await page.waitForFunction(()=>document.querySelectorAll('.pdf-text-layer span').length>3);
  await page.locator('[data-pdf-workspace="comment"]').click();
  async function selectPage(){await page.evaluate(()=>{const layer=document.querySelector('#pdfPageSurface .pdf-text-layer'),range=document.createRange();range.selectNodeContents(layer);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.getElementById('pdfPageSurface').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));});}
  await selectPage();await page.fill('#pdfAnnotationMemo','Important source passage');await page.click('#pdfQuoteNotes');await page.waitForFunction(()=>state.papers.find(p=>p.id==='a').pdfQuotes?.length===1);
  assert.match(await page.evaluate(()=>state.papers.find(p=>p.id==='a').notes),/PDF p\. 1/);assert.equal(await page.locator('.pdf-highlights span').count()>0,true);
  await page.click('#pdfNextPage');await page.waitForFunction(()=>document.getElementById('pdfPageNumber').value==='2'&&document.querySelector('#pdfPageSurface .pdf-text-layer')?.textContent.includes('limitation'));
  await selectPage();await page.selectOption('#pdfEvidenceColumn','limitation');await page.click('#pdfQuoteMatrix');await page.waitForFunction(()=>state.papers.find(p=>p.id==='a').evidencePassages?.some(row=>row.evidenceColumn==='limitation'));
  const evidence=await page.evaluate(async()=>{const p=state.papers.find(p=>p.id==='a');const response=await fetch(backendUrl('/api/discovery/compare'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({papers:[p,state.papers.find(p=>p.id==='b')],columns:[{id:'limitation',name:'Limitation'}],useOpenAccess:false})});return response.json();});
  assert.equal(evidence.rows[0].cells.limitation.provenance.page,2);assert.equal(evidence.rows[0].cells.limitation.reviewerSelected,true);
  await page.click('[data-annotation-remove]');const count=await page.evaluate(()=>state.papers.find(p=>p.id==='a').pdfAnnotations.length);await page.click('#pdfUndoAnnotation');assert.equal(await page.evaluate(()=>state.papers.find(p=>p.id==='a').pdfAnnotations.length),count+1);
  await page.click('#pdfReaderClose');
  await page.getByRole('tab',{name:'Notes',exact:true}).click();
  await page.locator('[data-open-pdf-page="1"]').first().click();await page.waitForFunction(()=>document.getElementById('pdfPageNumber').value==='1'&&document.querySelectorAll('.pdf-text-layer span').length>3);await page.click('#pdfReaderClose');
  await page.evaluate(cell=>PulseEvidence.show(cell),evidence.rows[0].cells.limitation);await page.click('[data-evidence-pdf]');await page.waitForFunction(()=>document.getElementById('pdfPageNumber').value==='2'&&document.querySelectorAll('.pdf-text-layer span').length>3);await page.click('#pdfReaderClose');await page.getByRole('button',{name:'Close evidence',exact:true}).click();
  let checks=0,failCheck=false;await page.route('**/api/discovery/start',route=>{checks++;const payload=route.request().postDataJSON();assert.equal('queryKeywords' in payload,false,'A plain query must not be replaced with an empty structured query');return failCheck?route.fulfill({status:503,json:{error:'Synthetic provider outage'}}):route.fulfill({json:{status:'completed',recommendations:[{title:'New Campylobacter candidate',doi:'10.1234/new',year:'2026',abstract:'New fixture result'}],errors:{}}});});
  await page.evaluate(async()=>{state.savedSearches.push({id:'watch-test',name:'Campylobacter watch',watching:true,frequency:'daily',nextCheck:0,seenKeys:[],config:{query:'Campylobacter',tags:[],match:'all',scope:'online',sources:{europePmc:true},limit:50}});await PulseWatchlists.tick(Date.now());});
  assert.equal(checks,1);assert.equal(await page.evaluate(()=>state.libraryFeatures.inbox.length),1);
  await page.evaluate(()=>PulseWatchlists.tick(Date.now()));assert.equal(checks,1,'Due dates prevent repeated checks');
  await page.evaluate(async()=>{const item=state.savedSearches.find(row=>row.id==='watch-test');item.frequency='weekly';item.nextCheck=0;await PulseWatchlists.tick(Date.now());});
  assert.equal(checks,2);assert.equal(await page.evaluate(()=>state.savedSearches.find(row=>row.id==='watch-test').nextCheck>Date.now()+6*86400000),true,'Weekly checks wait seven days');
  failCheck=true;const beforeSeen=await page.evaluate(()=>state.savedSearches.find(row=>row.id==='watch-test').seenKeys);
  await page.evaluate(async()=>{state.savedSearches.find(row=>row.id==='watch-test').nextCheck=0;await PulseWatchlists.tick(Date.now());});
  assert.match(await page.evaluate(()=>state.savedSearches.find(row=>row.id==='watch-test').checkError),/Synthetic provider outage/);assert.deepEqual(await page.evaluate(()=>state.savedSearches.find(row=>row.id==='watch-test').seenKeys),beforeSeen);
  const afterFailure=checks;await page.evaluate(async()=>{const item=state.savedSearches.find(row=>row.id==='watch-test');item.frequency='manual';item.nextCheck=0;await PulseWatchlists.tick(Date.now());});assert.equal(checks,afterFailure,'Manual schedules never run automatically');
  await page.evaluate(()=>{state.savedSearches.find(row=>row.id==='watch-test').frequency='daily';});
  await page.click('#openWatchInbox');await page.click('[data-inbox-add]');assert.equal(await page.evaluate(()=>state.papers.find(p=>p.doi==='10.1234/new').readingStatus),'to-read');assert.deepEqual(await page.evaluate(()=>state.papers.find(p=>p.doi==='10.1234/new').mapIds),[]);await page.click('#closeLibraryTools');
  assert(await page.evaluate(()=>Number(localStorage.getItem('pulse.panelWidth.library')))>library.width+50,'The dragged width is saved before its animation settles');
  await page.evaluate(()=>saveLibrary());await page.reload();await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===5);
  await page.waitForFunction(before=>document.getElementById('colLibrary').getBoundingClientRect().width>before+50,library.width);
  assert.equal(await page.evaluate(()=>state.libraryFeatures.collections.length),1);assert.equal(await page.evaluate(()=>state.libraryFeatures.inbox[0].reviewed),true);assert.equal(await page.evaluate(()=>state.savedSearches.find(row=>row.id==='watch-test').frequency),'daily');
  await page.evaluate(()=>PulsePDF.open('a',2));await page.waitForFunction(()=>document.querySelectorAll('.pdf-text-layer span').length>3);assert.equal(await page.locator('#pdfPageNumber').inputValue(),'2');assert.equal(await page.locator('.pdf-highlights span').count()>0,true);
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'pdf-reader.png')});}
  assert.deepEqual(errors,[]);
  console.log('PASS: focus/restore, resizable panels, match navigation/fit/filter/snippets, typed graph paths, live collections, explicit duplicate merge/undo, PDF reading/highlights/page quotes/matrix provenance, scheduled watchlist inbox/due dates and persistence.');
 } finally {await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
