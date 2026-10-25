const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-trends-command-'));
 const themes=[['oxidase','Oxidative stress','reactive oxygen oxidase signalling redox'],['barrier','Epithelial barrier','epithelial junction barrier mucus intestine'],['motility','Bacterial motility','bacterial flagella chemotaxis motility swimming']];
 const papers=[];
 for(let i=0;i<90;i++){
  const recent=i>=45,t=recent?(i<75?0:i<80?1:2):(i<5?0:i<30?1:2),theme=themes[t];
  papers.push({id:'p'+i,title:theme[1]+' study '+i,abstract:(theme[2]+' ').repeat(4),paperKeywords:[theme[1],theme[0]],authors:['Researcher '+i],year:String((recent?2024:2021)+i%3),selected:true});
 }
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers,threshold:.3}));
 const backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'},stdio:['ignore','pipe','pipe']});
 let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),20000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1261,height:1031}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===90);
  await page.click('#railLibraryBtn');await page.click('[data-rail="trends"]');await page.locator('.trends-map canvas').waitFor();
  assert.equal(await page.locator('.trends-signal').count(),3);
  assert.equal(await page.locator('.trends-stat strong').first().innerText(),'90');
  assert(await page.locator('.trends-signal-shift .trends-signal-value').count(),'The fixture has a supported share shift');
  const theme=await page.locator('html').getAttribute('data-theme');
  const surface=await page.locator('#trendsView').evaluate(el=>getComputedStyle(el).getPropertyValue('--surface').trim());
  assert.equal(surface,'#0d1a2b');assert.notEqual(theme,'dark','Dashboard styling must not change the app theme');
  const source=await page.locator('.trends-signal-focus').getAttribute('data-trends-signal-group');
  await page.locator('.trends-signal-focus').focus();await page.keyboard.press('Enter');
  await page.waitForFunction(group=>trendsUi.group===group,source);
  const ids=await page.locator('[data-trends-paper]').evaluateAll(els=>els.map(el=>el.dataset.trendsPaper));
  const members=await page.evaluate(()=>[...trendsGroupData(trendsUi.model).members.get(trendsUi.group)]);
  assert(ids.length>0&&ids.every(id=>members.includes(id)),'The focus card opens only its source papers');
  const peak=await page.locator('.trends-signal-activity').getAttribute('data-trends-signal-period');
  await page.locator('.trends-signal-activity').click();await page.waitForFunction(key=>trendsUi.period===key&&trendsUi.group==='*',peak);
  const records=await page.evaluate(()=>trendsFilterPapers(trendsUi.model,{period:trendsUi.period}).map(r=>r.paper.id));
  const shown=await page.locator('[data-trends-paper]').evaluateAll(els=>els.map(el=>el.dataset.trendsPaper));
  assert(shown.length>0&&shown.every(id=>records.includes(id)),'The publication card opens the exact period counted');
  await page.click('[data-trends-reset]');
  const builds=await page.evaluate(()=>trendsCache.builds);await page.selectOption('[data-trends-sort]','recent');assert.equal(await page.evaluate(()=>trendsCache.builds),builds);
  await page.click('[data-trends-play]');await page.waitForFunction(()=>trendsUi.playing&&Boolean(trendsUi.period));await page.click('[data-trends-play]');assert.equal(await page.evaluate(()=>trendsUi.playing),false);
  for(const width of [1261,976,650,420]){
   await page.setViewportSize({width,height:1031});
   const bounds=await page.locator('#trendsView').evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth,map:el.querySelector('canvas').getBoundingClientRect().toJSON(),controls:[...el.querySelectorAll('select,.trends-signal')].map(e=>e.getBoundingClientRect().toJSON())}));
   assert(bounds.scroll<=bounds.client+1,'No horizontal dashboard scroll at '+width+' '+bounds.scroll+'/'+bounds.client);
   assert(bounds.map.width>250&&bounds.map.height>200,'The constellation remains visible');
   for(const box of bounds.controls)assert(box.x>=0&&box.right<=width,'Dashboard controls fit at '+width);
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:1261,height:1031});
  assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
  assert.deepEqual(errors,[]);
  await page.waitForFunction(()=>TrendsMap.scene.list.every(node=>Math.abs(node.size-node.target)<1));
  await page.locator('#trendsView').evaluate(el=>{el.scrollTop=0;});
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'trends-command-dashboard.png')});}
  console.log('PASS: source-backed briefing cards, keyboard drill-down, exact period filters, cached sorting, playback, scoped dashboard palette, readable map and responsive bounds.');
 }finally{await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
