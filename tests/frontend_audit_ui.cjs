const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-frontend-audit-'));
 const papers=Array.from({length:24},(_,i)=>({id:'paper-'+i,title:['Oxidative stress','Host immunity','Membrane transport'][i%3]+' study '+i,authors:['Fixture Author'],year:String(2000+i),abstract:'Bacterial host immunity and oxidative stress mechanisms.',text:'bacterial host immunity oxidative stress membrane transport',paperKeywords:[['stress','immune response','membrane transport'][i%3]],selected:i<8,mapIds:[i<8?'map-1':'map-2'],addedAt:i===0?'2026-10-01T12:00:00Z':i===1?'2026-10-20T13:00:00Z':'',metadataMatch:{matched:true},metadataCheckedAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers,maps:[{id:'map-1',name:'Map 1'},{id:'map-2',name:'Map 2'}],activeMapId:'map-1',view:{x:50000,y:50000,width:1000,height:700},threshold:.05}));
 const backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
 let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>reject(Error('Backend exit '+code)));});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1031}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&document.querySelectorAll('#map .node').length===8);
  const visibleNodes=()=>page.evaluate(()=>[...document.querySelectorAll('#map .node')].filter(node=>{const a=node.getBoundingClientRect(),b=els.map.getBoundingClientRect();return a.x+a.width>b.x&&a.x<b.x+b.width&&a.y+a.height>b.y&&a.y<b.y+b.height;}).length);
  assert.equal(await visibleNodes(),8,'An off-screen saved camera is recovered on launch');
  await page.click('[data-action="switch-map-tab"][data-map-id="map-2"]');await page.waitForFunction(()=>document.querySelectorAll('#map .node').length===16&&!state.graphLayoutPending);
  assert.equal(await visibleNodes(),16,'Switching maps fits the active map');
  await page.evaluate(()=>{state.view.x=50000;state.view.y=50000;els.map.setAttribute('viewBox',`${state.view.x} ${state.view.y} ${state.view.width} ${state.view.height}`);});
  await page.click('#mapToolsMenu > summary');await page.click('#mapFitViewButton');assert.equal(await visibleNodes(),16,'Fit map updates the canvas immediately');
  const camera=await page.evaluate(()=>({...state.view}));await page.evaluate(()=>render());assert.deepEqual(await page.evaluate(()=>({...state.view})),camera,'A redraw preserves fitted zoom');
  await page.click('#mapToolsMenu > summary');await page.click('#openTimelineProgression');assert.equal(await page.locator('#mapTimelineControl').isVisible(),true);assert.equal(await page.locator('#openTimelineProgression').getAttribute('aria-expanded'),'true');
  await page.click('#mapToolsMenu > summary');await page.click('#openTimelineProgression');assert.equal(await page.locator('#mapTimelineControl').isVisible(),false);
  await page.click('#mapToolsMenu > summary');const svgReady=page.waitForEvent('download');await page.click('#exportMapSvgButton');const svg=await svgReady;assert.match(fs.readFileSync(await svg.path(),'utf8'),/<svg/);
  await page.evaluate(()=>inspectPaper('paper-9'));
  for(const width of [1440,1261,976]){
   await page.setViewportSize({width,height:1031});
   for(const selector of ['#networkSearch','#networkSearchCount','#networkSearchLinks']){
    const size=await page.locator(selector).evaluate(el=>[el.scrollWidth,el.clientWidth]);assert(size[0]<=size[1]+1,selector+' stays readable at '+width);
   }
   assert.equal(await page.locator('#networkSearch #openTimelineProgression').count(),0,'Secondary actions do not crowd search');
  }
  const output=process.env.PULSE_UI_SCREENSHOTS;
  async function screenshot(name){if(output){fs.mkdirSync(output,{recursive:true});await page.mouse.move(2,2);await page.waitForFunction(()=>!document.getElementById('toast')||Number(getComputedStyle(document.getElementById('toast')).opacity)<.01);await page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});}}
  await screenshot('network-repaired');
  await page.setViewportSize({width:1440,height:1031});await page.click('[data-rail="bibliography"]');
  await page.locator('[data-table-sort="addedAt"]').click();
  assert.equal(await page.locator('.library-col-addedAt').getAttribute('aria-sort'),'descending');
  const ids=()=>page.locator('.library-table-row').evaluateAll(rows=>rows.map(row=>row.dataset.paper));
  assert.deepEqual((await ids()).slice(0,2),['paper-1','paper-0']);
  assert.equal(await page.locator('[data-paper="paper-2"] .library-addedAt-cell').innerText(),'—','Older records have no invented add date');
  await page.locator('[data-table-sort="addedAt"]').click();assert.deepEqual((await ids()).slice(0,2),['paper-0','paper-1']);
  assert.equal(await page.locator('[data-paper="paper-0"] time').getAttribute('datetime'),'2026-10-01T12:00:00.000Z');
  const csv=path.join(profile,'new-paper.csv');fs.writeFileSync(csv,'Title,Authors,Year\nA newly added library paper,Fixture Author,2026\n');
  const before=Date.now();await page.setInputFiles('#importInput',csv);await page.waitForFunction(()=>state.papers.some(p=>p.title==='A newly added library paper'));
  const imported=await page.evaluate(()=>{const p=state.papers.find(p=>p.title==='A newly added library paper');return {id:p.id,addedAt:p.addedAt};});
  assert(Date.parse(imported.addedAt)>=before-1000,'A new import records its actual add time');
  const merge=await page.evaluate(()=>addParsedPapers([normalizeImportedPaper({title:'A newly added library paper',authors:['Fixture Author'],year:'2026'},'Duplicate fixture')]));assert.equal(merge.merged,1);
  assert.equal(await page.evaluate(id=>state.papers.find(p=>p.id===id).addedAt,imported.id),imported.addedAt,'Duplicate import preserves the original add date');
  await page.evaluate(()=>saveLibrary());await page.reload();await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===25);
  assert.equal(await page.evaluate(id=>state.papers.find(p=>p.id===id).addedAt,imported.id),imported.addedAt,'Add dates survive SQLite save and reload');
  assert.equal(await page.evaluate(()=>state.papers.find(p=>p.id==='paper-2').addedAt),'');
  await page.click('[data-rail="bibliography"]');assert.equal(await page.locator('.library-col-addedAt').getAttribute('aria-sort'),'ascending','The chosen Date added sort survives reload');await page.locator('[data-table-sort="addedAt"]').click();await screenshot('library-date-added');
  for(const [theme,view] of [['light','trends'],['sepia','trends'],['dark','timeline']]){
   await page.click(`[data-rail="${view}"]`);await page.evaluate(theme=>applyFrankTheme(theme),theme);
   const selector=view==='trends'?'#trendsView':'#timelineView';await page.locator(selector).waitFor({state:'visible'});
   if(view==='trends')await page.waitForFunction(()=>TrendsMap.scene.list.length&&TrendsMap.scene.list.every(n=>n.size>=n.target*.9));
   for(const width of [1440,976]){
    await page.setViewportSize({width,height:1031});
    await page.waitForFunction(selector=>{const el=document.querySelector(selector);return el.scrollWidth<=el.clientWidth+1;},selector);
    await screenshot(view+'-'+theme+'-'+width);
   }
  }
  await page.click('[data-rail="network"]');
  for(const width of [768,420]){
   await page.setViewportSize({width,height:800});await page.evaluate(()=>PulseWhatsNew.show(true));
   const size=await page.locator('#whatsNewSplashDialog').evaluate(el=>[el.scrollWidth,el.clientWidth]);assert(size[0]<=size[1]+1,'Release dialog fits '+width);
   await screenshot('whats-new-'+width);await page.click('#whatsNewDismissBtn');
  }
  await page.evaluate(()=>saveLibrary());await page.close();
  async function freshDesktopSession(){
   const next=await browser.newPage({viewport:{width:1280,height:900}});next.on('pageerror',e=>errors.push(e.message));
   await next.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>false}));
   await next.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
   await next.goto(url);await next.waitForFunction(()=>state.autosaveReady);return next;
  }
  let restarted=await freshDesktopSession();assert.equal(await restarted.locator('#whatsNewSplashDialog[open]').count(),0,'A fresh desktop session respects the saved dismissal');
  await restarted.evaluate(()=>{state.lastSeenRelease='0.0.0';return saveLibrary();});await restarted.close();
  restarted=await freshDesktopSession();await restarted.getByRole('dialog',{name:"What's New in Pulse",exact:true}).waitFor({state:'visible'});
  await restarted.keyboard.press('Escape');await restarted.waitForFunction(()=>state.lastSeenRelease==='2.1.9');await restarted.evaluate(()=>saveLibrary());await restarted.close();
  restarted=await freshDesktopSession();assert.equal(await restarted.locator('#whatsNewSplashDialog[open]').count(),0,'Escape dismissal survives a fresh desktop session');await restarted.close();
  assert.deepEqual(errors,[]);
  console.log('PASS: off-screen camera recovery, active-map fit and zoom retention, unclipped map controls, timeline/SVG actions, sortable persisted Date added, unknown legacy dates, duplicate imports, Trends/Timeline themes, responsive release dialog and durable dismissal including Escape across fresh desktop sessions.');
 }finally{await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
