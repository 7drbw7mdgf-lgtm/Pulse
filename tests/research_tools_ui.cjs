const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-research-tools-'));
 const papers=[
  {id:'seed',title:'Synthetic therapy seed',doi:'10.1234/seed',year:'2024',abstract:'A seed study.',text:'A seed study.',selected:true},
  {id:'local',title:'Synthetic microscopy study',doi:'10.1234/local',year:'2023',abstract:'A short abstract.',text:'Methods\nWe used microscopy on human cells.\nResults\nWe found a 24% improvement in survival [1].\nDiscussion\nA limitation is the small sample size.\nReferences\n[1] Example (2024). Synthetic therapy seed. doi:10.1234/seed',evidencePassages:[
    {page:2,section:'Methods',source:'Local PDF',text:'We used microscopy on human cells.'},
    {page:3,section:'Results',source:'Local PDF',text:'We found a 24% improvement in survival [1].'},
    {page:4,section:'Discussion',source:'Local PDF',text:'A limitation is the small sample size.'},
    {page:5,section:'References',source:'Local PDF',text:'[1] Example (2024). Synthetic therapy seed. doi:10.1234/seed'}]},
  {id:'other',title:'Synthetic cohort study',doi:'10.1234/other',year:'2022',abstract:'We used a cohort survey in adult patients. We found reduced mortality.'}
 ];
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers,threshold:.75}));
 let backend,browser,url;
 async function start(){
  backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
  url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',chunk=>{const found=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(found){clearTimeout(timer);resolve(found[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
 }
 async function stop(){if(backend){const exit=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await exit;backend=null;}}
 try{
  await start();browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.route('**/api/metadata/**',route=>route.fulfill({json:{ok:true,matched:false,metadata:{}}}));
  const ready=async()=>{await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===3&&document.getElementById('screeningToggle'));await page.evaluate(()=>{enrichLibraryAutomatically=()=>{};warmDiscoveryForPaper=()=>{};});};
  const review=async()=>page.evaluate(()=>{
   const seed=state.papers.find(p=>p.id==='seed');
   const records=state.papers.filter(p=>p.id!=='seed').map((p,i)=>({...p,score:85-i*5,rank:i+1,matchLabel:'Related'}));
   const configuration={...discoveryConfiguration(),researchQuestion:'synthetic therapy',branches:{citationGraph:false,citationNetwork:false,citationCoCitation:false,semanticSearch:false,lexicalSearch:true},searchSources:{semanticScholar:false,europePmc:true,core:true,arxiv:false}};
   const runContext={researchQuestion:'synthetic therapy',seedPapers:[citationPaperPayload(seed)],searchMode:'related',configuration};
   state.discoveryResearchQuestion='synthetic therapy';state.discoveryRunContext=runContext;
   state.discoveryRunInfo.set('research-test',{id:'original-run',sourceCounts:{europePmc:2},branchesExecuted:['europePmc','core'],errors:{core:'CORE returned HTTP 429'},runContext});
   state.recommendations.set('research-test',records);state.discoverySearchErrors ||= new Map();state.discoverySearchErrors.set('research-test',{core:'CORE returned HTTP 429'});
   state.discoveryHideLibrary=false;openDiscoveryModal(records,seed,'research-test');state.discoveryQueue='all';renderDiscoveryModal();
  });
  await ready();await review();
  assert.equal(await page.locator('#screeningControls').isVisible(),false,'Screening remains opt-in');
  assert.match(await page.locator('#searchCompleteness').innerText(),/Limited coverage/);
  await page.click('#screeningToggle');await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('0 screened'));
  await page.click('[data-dv-focus="doi:10.1234/local"]');await page.keyboard.press('r');
  await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('1 included'));
  await page.click('[data-dv-focus="doi:10.1234/local"]');await page.keyboard.press('m');
  await page.locator('dialog[open] textarea').fill('Check microscopy protocol <script>unsafe</script>');await page.locator('dialog[open] button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('screeningRecord').textContent.includes('microscopy protocol'));
  assert.equal(await page.locator('#screeningRecord script').count(),0);
  await page.keyboard.press('t');await page.locator('dialog[open] input').fill('methods, follow-up');await page.locator('dialog[open] button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('screeningRecord').textContent.includes('follow-up'));
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForFunction(()=>!document.getElementById('screeningRecord').textContent.includes('follow-up'));
  assert.match(await page.locator('#screeningRecord').innerText(),/microscopy protocol/);
  await page.selectOption('#screeningStage','full-text');await page.click('[data-dv-focus="doi:10.1234/local"]');await page.keyboard.press('n');
  await page.locator('dialog[open] input').fill('Wrong outcome');await page.locator('dialog[open] button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('1 excluded'));
  await page.click('[data-dv-focus="doi:10.1234/other"]');await page.keyboard.press('n');await page.locator('dialog[open] [data-cancel]').click();
  await page.waitForFunction(()=>!document.getElementById('screeningStatus').textContent.includes('Saving'));
  assert.equal(await page.evaluate(()=>discoveryRating(state.discoveryResults.find(p=>p.doi==='10.1234/other'))),undefined,'Cancelling reason entry restores relevance');
  await page.selectOption('#screeningExportFormat','prisma');
  const download=page.waitForEvent('download');await page.click('#screeningExport');const item=await download;
  const prisma=JSON.parse(fs.readFileSync(await item.path(),'utf8'));assert.equal(prisma.reportsExcluded,1);assert.equal(prisma.recordsIdentified,null);
  // Local comparison goes through the real backend and retains PDF page provenance.
  await page.evaluate(async()=>{document.getElementById('compareUseOpenAccess').checked=false;await openDiscoveryCompareDialog(state.papers.filter(p=>p.id!=='seed'));});
  await page.locator('[data-evidence-cell="0"][data-evidence-column="method"]').click();
  assert.match(await page.locator('[data-evidence-label]').innerText(),/Local PDF.*Methods.*Page 2/);
  assert.match(await page.locator('[data-evidence-context] mark').innerText(),/microscopy/);
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.notEqual(await page.locator('#evidenceSourceDialog').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)','Source evidence respects the dark theme');
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'research-evidence-dark.png')});}
  await page.evaluate(()=>document.documentElement.dataset.theme='light');
  await page.locator('#evidenceSourceDialog button').click();await page.locator('#discoveryCompareDialog').press('Escape');
  await page.click('[data-dv-focus="doi:10.1234/local"]');await page.locator('[data-verify-citation]').click();
  await page.locator('#evidenceSourceDialog[open]').waitFor();assert.match(await page.locator('#evidenceSourceDialog h2').innerText(),/Synthetic therapy seed/);
  assert.match(await page.locator('[data-evidence-label]').innerText(),/Page 3/);await page.locator('#evidenceSourceDialog button').click();
  const order=await page.evaluate(()=>state.discoveryResults.map(p=>p.doi));
  await page.evaluate(()=>state.discoveryResearchQuestion='"an unfinished edit');
  await page.route('**/api/discovery/start',route=>{requests.push(route.request().postDataJSON());return route.fulfill({json:{status:'completed',id:'retry-run',recommendations:[{id:'fresh',doi:'10.1234/fresh',title:'Fresh source candidate',score:99}],branchesExecuted:['core'],sourceCounts:{core:1},errors:{}}});});
  await page.click('#retryIncompleteSources');await page.waitForFunction(()=>!state.discoveryLoading&&state.discoveryResults.length===3);
  assert.deepEqual(requests[0].retryBranches,['core']);assert.equal(requests[0].researchQuestion,'synthetic therapy','Retry uses original options, not unfinished edits');assert.deepEqual(await page.evaluate(()=>state.discoveryResults.slice(0,2).map(p=>p.doi)),order);
  assert.equal(await page.evaluate(()=>state.discoveryResults[2].score),null);assert.match(await page.locator('#searchCompleteness').innerText(),/Existing order is preserved/);
  assert.equal(await page.evaluate(()=>state.discoveryFocusKey),'doi:10.1234/local');
  // Failed retries keep the current workspace and results.
  await page.evaluate(()=>{const info=state.discoveryRunInfo.get('research-test');info.errors.core='Unavailable';state.discoverySearchErrors.set('research-test',info.errors);renderDiscoveryModal({preservePosition:true});});
  await page.route('**/api/discovery/start',route=>route.fulfill({status:503,json:{error:'Synthetic source failure'}}));
  await page.click('#retryIncompleteSources');await page.waitForFunction(()=>!state.discoveryLoading);
  assert.equal(await page.locator('#discoveryModal').isVisible(),true);assert.equal(await page.evaluate(()=>state.discoveryResults.length),3);
  await page.route('**/api/discovery/start',route=>route.fulfill({json:{status:'cancelled',recommendations:[]}}));
  await page.click('#retryIncompleteSources');await page.waitForFunction(()=>!state.discoveryLoading);
  assert.equal(await page.locator('#discoveryModal').isVisible(),true);assert.equal(await page.evaluate(()=>state.discoveryResults.length),3,'Cancelled retry preserves prior results');
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'research-screening.png')});}
  await page.evaluate(()=>{closeDiscoveryModal();setSettingsOpen(true);setSettingsTab('search');});
  assert.equal(await page.locator('#adaptiveCitationToggle').isChecked(),false);assert.equal(await page.locator('#biomedicalRouterToggle').isChecked(),false);
  await page.check('#adaptiveCitationToggle');await page.selectOption('#adaptiveCitationIntent','focused');await page.check('#biomedicalRouterToggle');await page.click('#saveRankingExperiments');
  await page.waitForFunction(()=>!document.getElementById('saveRankingExperiments').disabled);
  assert.match(await page.locator('#rankingExperimentStatus').innerText(),/optional biomedical model/);
  await page.click('#cleanSearchCache');await page.waitForFunction(()=>document.getElementById('searchCacheStatus').textContent.includes('cached responses'));
  if(process.env.PULSE_UI_SCREENSHOTS){await page.locator('#saveRankingExperiments').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'research-settings.png')});}
  await page.evaluate(async()=>{setSettingsOpen(false);await saveLibrary();});
  // Restart the backend and reopen persisted project, settings, notes and reasons.
  await stop();await start();await ready();await review();await page.click('#screeningToggle');
  await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('1 included'));
  await page.click('[data-dv-focus="doi:10.1234/local"]');assert.match(await page.locator('#screeningRecord').innerText(),/microscopy protocol/);
  await page.selectOption('#screeningStage','full-text');assert.match(await page.locator('#screeningStatus').innerText(),/1 excluded/);
  await page.click('#screeningUndo');await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('0 excluded'));
  assert.equal(await page.evaluate(()=>discoveryRating(state.discoveryResults.find(p=>p.doi==='10.1234/local'))),2,'Restarted undo restores the previous relevance decision');
  // Bulk decisions use one durable action and one reason prompt, then undo together.
  await page.check('.discovery-item-checkbox[data-paper-key="doi:10.1234/local"]');
  await page.check('.discovery-item-checkbox[data-paper-key="doi:10.1234/other"]');
  await page.click('[data-dv-action="bulk-not"]');
  await page.locator('dialog[open] input').fill('Batch wrong outcome');await page.locator('dialog[open] button[type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('2 excluded'));
  await page.click('#screeningUndo');await page.waitForFunction(()=>document.getElementById('screeningStatus').textContent.includes('0 excluded'));
  assert.equal(await page.evaluate(()=>discoveryRating(state.discoveryResults.find(p=>p.doi==='10.1234/local'))),2);
  assert.equal(await page.evaluate(()=>discoveryRating(state.discoveryResults.find(p=>p.doi==='10.1234/other'))),undefined);
  await page.setViewportSize({width:760,height:850});
  assert.equal(await page.locator('#screeningControls').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Screening toolbar wraps on narrow windows');
  if(process.env.PULSE_UI_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'research-screening-narrow.png')});
  await page.evaluate(()=>{closeDiscoveryModal();setSettingsOpen(true);setSettingsTab('search');});
  assert.equal(await page.locator('#adaptiveCitationToggle').isChecked(),true);assert.equal(await page.locator('#adaptiveCitationIntent').inputValue(),'focused');
  assert.deepEqual(errors,[]);
  console.log('PASS: opt-in screening, keyboard decisions, memo/tags, durable undo/restart, reason cancellation, PRISMA unknowns, local PDF provenance, exact citation context, retained source retries, experimental settings and narrow toolbar.');
 }finally{await browser?.close();await stop();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
