const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-research-workflow-'));
 const fixture={papers:[
  {id:'one',title:'Outer membrane vesicles and biofilm formation',doi:'10.1000/one',authors:['Example One'],year:'2024',abstract:'Vesicles support biofilm formation.',userTags:['Immunity'],paperKeywords:['biofilm'],readingStatus:'to-read',text:'Private synthetic full text',selected:false},
  {id:'two',title:'Transport systems in bacteria',doi:'10.1000/two',authors:['Example Two'],year:'2023',abstract:'Cellular transport mechanisms.',userTags:['Transport'],paperKeywords:['transport'],readingStatus:'read',selected:false}
 ],threshold:.75};
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify(fixture));
 const root=path.resolve(__dirname,'..');
 const backend=spawn(process.env.PULSE_TEST_PYTHON||(process.platform==='win32'?'python':'python3'),['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'},stdio:['ignore','pipe','pipe']});
 let browser;
 try {
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server startup timeout')),15000);backend.stdout.on('data',chunk=>{const m=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});backend.on('exit',code=>reject(Error('Server exited '+code)));});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===2&&document.getElementById('readingQueueToggle'));
  await page.evaluate(()=>{enrichLibraryAutomatically=()=>{};warmDiscoveryForPaper=()=>{};});
  const openSearchOptions=async()=>{if(!await page.locator('#searchOptionsMenu').evaluate(el=>el.open))await page.click('#searchOptionsSummary');};
  const toggleSearchMenu=async(id)=>{await openSearchOptions();await page.click('#'+id+' summary');};
  const openSearchMenu=async(id)=>{await openSearchOptions();if(!await page.locator('#'+id).evaluate(el=>el.open))await page.click('#'+id+' summary');};
  const setSearchOption=async(id,value)=>{await openSearchOptions();await page.selectOption('#'+id,value);};
  await page.focus('#searchOptionsSummary');await page.keyboard.press('Enter');
  assert.equal(await page.locator('#searchOptionsMenu').evaluate(el=>el.open),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#searchOptionsMenu').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#searchOptionsSummary').evaluate(el=>el===document.activeElement),true);
  await openSearchMenu('searchTagsMenu');await page.focus('#searchTagsFilter');await page.keyboard.press('Escape');
  assert.equal(await page.locator('#searchTagsMenu').evaluate(el=>el.open),false);
  assert.equal(await page.locator('#searchOptionsMenu').evaluate(el=>el.open),true);
  await page.click('#discoveryResearchQuestion');assert.equal(await page.locator('#searchOptionsMenu').evaluate(el=>el.open),false);
  await setSearchOption('searchScopeSelect','library');await page.fill('#discoveryResearchQuestion','vesicles, biofilm');await page.click('#unifiedSearchButton');
  await page.waitForFunction(()=>libraryDisplayPapers().length===1);
  assert.equal(await page.locator('#searchOptionsState').innerText(),'Library · All');
  assert.equal(await page.locator('#libraryBulkBar').isVisible(),false,'No empty bulk toolbar');
  const geometry=await page.evaluate(()=>({header:document.querySelector('.col-library-header').getBoundingClientRect().height,tools:document.querySelector('.library-compact-toolbar').getBoundingClientRect().height,first:document.querySelector('#paperList tbody [data-paper]').getBoundingClientRect().top,head:document.querySelector('#paperList thead').getBoundingClientRect().bottom}));
  assert(geometry.header+geometry.tools<120,'Compact library heading and filters');
  assert(geometry.first>=geometry.head-1,'The first paper must remain below the table header');
  assert((await page.locator('#paperList').innerText()).includes('Outer membrane vesicles'));assert(!(await page.locator('#paperList').innerText()).includes('Transport systems'));
  await setSearchOption('searchMatchSelect','any');await page.fill('#discoveryResearchQuestion','vesicles, transport');await page.click('#unifiedSearchButton');
  await page.waitForFunction(()=>libraryDisplayPapers().length===2);
  await page.fill('#discoveryResearchQuestion','#Immunity');await page.click('#unifiedSearchButton');
  await page.waitForFunction(()=>libraryDisplayPapers().length===1);
  assert.equal(await page.evaluate(()=>libraryDisplayPapers()[0].id),'one');
  await page.fill('#discoveryResearchQuestion','');await toggleSearchMenu('searchTagsMenu');
  await page.check('[data-search-tag="Immunity"]');await toggleSearchMenu('searchTagsMenu');await page.click('#unifiedSearchButton');
  assert.equal(await page.evaluate(()=>libraryDisplayPapers()[0].id),'one');assert.equal(await page.evaluate(()=>libraryDisplayPapers().length),1);
  await toggleSearchMenu('searchTagsMenu');await page.uncheck('[data-search-tag="Immunity"]');await toggleSearchMenu('searchTagsMenu');
  await page.click('#clearResearchFilter');await page.click('#readingQueueToggle');
  assert.equal(await page.evaluate(()=>libraryDisplayPapers()[0].id),'one');await page.check('#librarySelectVisible');assert.equal(await page.evaluate(()=>libraryBulkPapers().length),1);assert.equal(await page.locator('#libraryBulkBar').isVisible(),true);
  await page.click('#clearResearchFilter');
  await setSearchOption('searchScopeSelect','online');await setSearchOption('searchMatchSelect','all');await page.fill('#discoveryResearchQuestion','"outer membrane vesicles", biofilm');
  await toggleSearchMenu('savedSearchesMenu');await page.fill('#savedSearchName','Vesicle watch');await page.click('#saveCurrentSearch');
  assert.equal(await page.locator('[data-saved-load]').innerText(),'Vesicle watch');
  await page.check('[data-saved-watch]');
  let runs=0, requests=[];
  await page.route('**/api/discovery/start',route=>{
    requests.push(route.request().postDataJSON());runs++;
    const records=[{...fixture.papers[0],score:88,rank:1,matchLabel:'Strong match',strongMatchEligible:true}];
    if(runs>1)records.push({id:'new',title:'New outer membrane vesicles biofilm study',doi:'10.1000/new',abstract:'Outer membrane vesicles in biofilm.',score:85,rank:2,matchLabel:'Related'});
    return route.fulfill({json:{status:'completed',recommendations:records,errors:{},candidateCount:records.length}});
  });
  await openSearchMenu('savedSearchesMenu');await page.click('[data-saved-run]');await page.waitForFunction(()=>!state.discoveryLoading&&state.savedSearches[0].baseline);
  assert.deepEqual(requests[0].queryKeywords,['outer membrane vesicles','biofilm']);assert.equal(requests[0].rankingMode,'fast');assert.equal(requests[0].queryMatch,'all');
  await page.evaluate(()=>closeDiscoveryModal());
  await openSearchMenu('savedSearchesMenu');await page.click('[data-saved-run]');await page.waitForFunction(()=>!state.discoveryLoading&&state.savedSearches[0].newCount===1);
  assert.equal(await page.evaluate(()=>state.discoveryLastRun.recommendations.length),1);
  assert.equal(await page.evaluate(()=>state.discoveryLastRun.recommendations[0].doi),'10.1000/new');
  await page.evaluate(async()=>{closeDiscoveryModal();await saveLibrary();});await page.reload();
  await page.waitForFunction(()=>state.autosaveReady&&state.savedSearches?.[0]?.seenKeys?.length===2);
  assert.equal(await page.evaluate(()=>state.papers[0].text),'Private synthetic full text');
  await toggleSearchMenu('savedSearchesMenu');await page.click('[data-saved-remove]');assert.equal(await page.locator('[data-saved-load]').count(),0);
  await page.click('[data-saved-restore]');assert.equal(await page.locator('[data-saved-load]').count(),1);
  await page.fill('#discoveryResearchQuestion','"unfinished');await page.click('#unifiedSearchButton');assert.match(await page.locator('#toast').innerText(),/Close the quotation/);
  assert.equal(runs,2,'Invalid input and editing must not run searches');assert.deepEqual(errors,[]);
  assert(fs.existsSync(path.join(profile,'library.sqlite3')));
  for(const width of [1261,976,600,420]){
    await page.setViewportSize({width,height:900});await openSearchOptions();
    const bounds=await page.locator('#searchBuilder').boundingBox();
    assert(bounds.x>=0&&bounds.x+bounds.width<=width,'Search options stay inside a '+width+'px window');
    await page.click('#searchOptionsClose');
  }
  if(process.env.PULSE_UI_SCREENSHOTS){
    fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});
    await page.setViewportSize({width:1440,height:1000});
    await page.fill('#discoveryResearchQuestion','"outer membrane vesicles", biofilm, #Immunity');
    await openSearchMenu('savedSearchesMenu');
    await page.evaluate(()=>{setLibraryFullscreen(false);document.documentElement.dataset.theme='light';document.getElementById('toast').hidden=true;});
    await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'Pulse-2.1.0-search-light.png')});
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
    await toggleSearchMenu('searchTagsMenu');
    await page.locator('[data-search-tag="Immunity"]').waitFor();
    await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'Pulse-2.1.0-search-dark.png')});
  }
  console.log('PASS: multi-phrase All/Any search, #tags, reading queue and bulk scope, saved watchlists, new-match tracking, reload persistence, undo removal, invalid input and no page errors.');
 } finally {if(browser)await browser.close();backend.kill();await new Promise(resolve=>backend.once('exit',resolve));fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
