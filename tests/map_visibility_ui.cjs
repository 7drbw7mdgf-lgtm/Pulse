const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-map-visibility-'));
 const papers=Array.from({length:144},(_,i)=>({id:'paper-'+i,title:i<2?'Reactive oxygen species in epithelial cells':'Astronomy background study '+i,
  authors:[i===0?'Zahra Sebghatollahi':'Pranaya Kansakar','Fixture Author','Third Author'],year:'2025',
  abstract:i<2?'Reactive oxygen species in epithelial cells and host immunity.':'Astronomy star formation in distant galaxies, background '+i,
  paperKeywords:i<2?['reactive oxygen species']:['galaxies'],x:[52,348,687][i%3],y:415,
  selected:i<3,mapIds:[i<3?'map-1':'map-2'],metadataMatch:{matched:true},metadataCheckedAt:new Date().toISOString()}));
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify({papers,maps:[{id:'map-1',name:'Sparse map'},{id:'map-2',name:'Other papers'}],activeMapId:'map-1',
  threshold:.75,view:{x:90,y:151,width:779,height:624},lastSeenRelease:'2.1.8'}));
 const backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
 let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>reject(Error('Backend exit '+code)));});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1261,height:1031}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);
  const ready=(count=3)=>page.waitForFunction(count=>state.autosaveReady&&document.querySelectorAll('#map .node').length===count&&!state.graphAnalysisPending&&!state.graphLayoutPending&&!isRecenteringAnimation,count);
  const bounds=()=>page.evaluate(()=>{
   const map=els.map.getBoundingClientRect(),dock=document.querySelector('.canvas-dock-modern').getBoundingClientRect();
   return [...els.map.querySelectorAll('.node,.cluster-hull-badge')].map(node=>{const r=node.getBoundingClientRect();return {name:node.dataset.id||'topic badge',left:r.left-map.left,top:r.top-map.top,right:map.right-r.right,bottom:Math.min(map.bottom,dock.top)-r.bottom};});
  });
  const assertFits=async()=>{for(const item of await bounds())for(const side of ['left','right','top','bottom'])assert(item[side]>=10,`${item.name} clipped at ${side}: ${JSON.stringify(item)}`);};
  await ready();await assertFits();
  assert.equal(await page.evaluate(()=>state.graphPerformance.workerJobs>0),true,'Exercises the background analysis used by real libraries');
  const envelope=await page.locator('.cluster-boundary').filter({has:page.locator('.cluster-hull-badge',{hasText:'Reactive Oxygen Species'})}).evaluate(el=>{
   const hull=el.querySelector('path').getBBox(),badge=el.querySelector('.cluster-hull-badge').getBoundingClientRect();
   const overlaps=[...document.querySelectorAll('#map .node-main-circle')].some(circle=>{const r=circle.getBoundingClientRect();return r.left<badge.right&&r.right>badge.left&&r.top<badge.bottom&&r.bottom>badge.top;});
   return {height:hull.height,overlaps};
  });
  assert(envelope.height>60,'A two-paper collinear group has a filled envelope');assert.equal(envelope.overlaps,false,'Topic badge clears all paper nodes');
  await page.locator('#map .node[data-id="paper-0"]').dblclick();await ready();await assertFits();
  await page.locator('#map').click({position:{x:300,y:30}});await page.waitForFunction(()=>!state.centerId&&!isRecenteringAnimation);await assertFits();
  await page.evaluate(()=>zoomCanvasAt(500,400,.88));const camera=await page.evaluate(()=>({...state.view}));await page.evaluate(()=>render());
  assert.deepEqual(await page.evaluate(()=>({...state.view})),camera,'An ordinary redraw keeps deliberate zoom');
  await page.evaluate(()=>{els.map.closest('.map-viewport').style.display='none';render();});
  assert.deepEqual(await page.evaluate(()=>({...state.view})),camera,'A temporarily hidden viewport cannot corrupt the saved camera');
  await page.evaluate(()=>{els.map.closest('.map-viewport').style.display='';render();});
  await page.evaluate(()=>fitCanvasToMap());
  await page.evaluate(()=>updateGraphStyle({nodeSize:42,labelMode:'full'}));await assertFits();
  await page.evaluate(()=>updateGraphStyle({nodeSize:22,labelMode:'short'}));await assertFits();
  for(const width of [976,1440]){await page.setViewportSize({width,height:1031});await page.waitForFunction(width=>Math.abs(document.documentElement.clientWidth-width)<2,width);await ready();await assertFits();}
  await page.evaluate(()=>saveLibrary());await page.reload();await ready();await assertFits();
  await page.click('[data-action="switch-map-tab"][data-map-id="map-2"]');await ready(141);await assertFits();
  assert.equal(await page.evaluate(()=>state.papers.length),144,'Map repair preserves the full library');assert.deepEqual(errors,[]);
  console.log('PASS: partially clipped saved camera with background analysis; labels and badges clear the floating toolbar; two-paper envelopes have area; focus/clear, styling, resize, reload and a 141-paper worker layout remain visible; manual zoom survives redraw.');
 }finally{await browser?.close();const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
