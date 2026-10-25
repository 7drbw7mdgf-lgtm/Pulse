const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-simple-trends-'));
 const themes=[['Oxidative stress','reactive oxygen oxidase redox signalling'],['Epithelial barrier','epithelial junction mucus intestine barrier'],['Bacterial motility','bacterial flagella chemotaxis motility swimming']];
 const papers=Array.from({length:60},(_,i)=>({id:'p'+i,title:themes[i%3][0]+' study '+i,abstract:(themes[i%3][1]+' ').repeat(4),paperKeywords:[themes[i%3][0],i%2?'Recent methods':'Established methods'],authors:['Researcher '+i],year:String(2021+i%6),selected:true}));
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers,threshold:.3}));
 const backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'},stdio:['ignore','pipe','pipe']});let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),20000);backend.stdout.on('data',data=>{const m=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1261,height:1031}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===60);
  await page.click('#railLibraryBtn');await page.click('[data-rail="trends"]');await page.waitForFunction(()=>document.querySelectorAll('[data-trends-group]').length>1);
  assert.equal(await page.locator('[data-trends-paper]').count(),10,'Papers are visible on arrival');
  assert.equal(await page.locator('[data-trends-visuals]').evaluate(el=>el.open),false,'The charts are optional');
  assert.equal(await page.locator('[data-trends-keywords]').evaluate(el=>el.open),false,'Keyword details do not crowd the paper list');
  assert.equal(await page.locator('[data-trends-group="*"]').getAttribute('aria-pressed'),'true');
  const builds=await page.evaluate(()=>trendsCache.builds);
  await page.click('[data-trends-more-papers]');assert.equal(await page.locator('[data-trends-paper]').count(),30,'Show more adds another batch without expanding the whole library');
  const button=page.locator('[data-trends-group]:not([data-trends-group="*"])').first(),group=await button.getAttribute('data-trends-group');
  await button.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-trends-group="'+group+'"]').getAttribute('aria-pressed'),'true');
  const expected=await page.evaluate(group=>[...trendsGroupData(trendsUi.model).members.get(group)],group);
  const listed=await page.locator('[data-trends-paper]').evaluateAll(elements=>elements.map(el=>el.dataset.trendsPaper));
  assert(listed.length&&listed.every(id=>expected.includes(id)),'A topic selects its own papers');
  const period=await page.evaluate(()=>{const record=trendsFilterPapers(trendsUi.model,{members:trendsGroupData(trendsUi.model).members.get(trendsUi.group)})[0];return trendsUi.model.bins.find(bin=>trendsInPeriod(record,bin.key,trendsUi.model)).key;});
  await page.selectOption('[data-trends-period-select]',period);
  const filtered=await page.evaluate(()=>trendsFilterPapers(trendsUi.model,{members:trendsGroupData(trendsUi.model).members.get(trendsUi.group),period:trendsUi.period}).map(r=>r.paper.id));
  const visible=await page.locator('[data-trends-paper]').evaluateAll(elements=>elements.map(el=>el.dataset.trendsPaper));assert(visible.length&&visible.every(id=>filtered.includes(id)));
  await page.click('[data-trends-keywords]>summary');await page.locator('[data-trends-topic]').first().click();
  assert(await page.evaluate(()=>Boolean(trendsUi.topic)));
  await page.click('[data-trends-reset]');assert.equal(await page.locator('[data-trends-paper]').count(),10);assert.equal(await page.locator('[data-trends-period-select]').inputValue(),'');
  assert.equal(await page.evaluate(()=>trendsUi.group+trendsUi.topic+trendsUi.period),'');
  await page.click('[data-trends-keywords]>summary');
  await page.click('[data-trends-visuals]>summary');await page.waitForFunction(()=>TrendsMap.scene.list.some(node=>node.size>10));
  assert.equal(await page.locator('.trends-map canvas').isVisible(),true);
  await page.click('[data-trends-play]');await page.waitForFunction(()=>trendsUi.playing);
  assert.equal(await page.locator('[data-trends-visuals]').evaluate(el=>el.open),true,'Chart selections preserve the open section');
  await page.click('[data-trends-visuals]>summary');await page.waitForFunction(()=>!trendsUi.playing&&!trendsUi.period);
  assert.equal(await page.locator('[data-trends-visuals]').evaluate(el=>el.open),false);
  await page.click('[data-trends-visuals]>summary');await page.waitForFunction(()=>TrendsMap.scene.list.some(node=>node.size>10));
  await page.click('[data-trends-visuals]>summary');
  assert.equal(await page.evaluate(()=>trendsCache.builds),builds,'Browsing reuses the cached model');
  await page.waitForFunction(()=>!document.querySelector('[data-trends-visuals]').open&&!trendsUi.visualsOpen);
  await page.evaluate(()=>renderTrends({refresh:false}));
  assert.equal(await page.locator('[data-trends-visuals]').evaluate(el=>el.open),false,'A background redraw must preserve a closed section');
  for(const width of [1261,976,650,420]){
   await page.setViewportSize({width,height:1031});
   const bounds=await page.locator('#trendsView').evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth,controls:[...el.querySelectorAll('.trends-toolbar select,.trends-group')].map(e=>e.getBoundingClientRect().toJSON())}));
   assert(bounds.scroll<=bounds.client+1,'No sideways page scroll at '+width);
   for(const box of bounds.controls)assert(box.x>=0&&box.right<=width,'Controls fit in '+width+'px');
  }
  await page.setViewportSize({width:1261,height:1031});await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  assert.equal(await page.locator('#trendsView').evaluate(el=>getComputedStyle(el).getPropertyValue('--ink').trim()),await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--ink').trim()),'Trends follows the app theme');
  await page.evaluate(()=>document.documentElement.dataset.theme='light');await page.locator('#trendsView').evaluate(el=>{el.scrollTop=0;});
  assert.deepEqual(errors,[]);
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'simple-trends.png')});}
  console.log('PASS: immediate papers, selected topics, keyboard browsing, composed year/keyword filters, clear filters, optional map/playback/reopen, cached browsing, theme inheritance and narrow layouts.');
 }finally{await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
