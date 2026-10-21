const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-network-search-'));
 const fixture={papers:[
  {id:'a',title:'Bacterial stress responses',authors:['Ada One'],year:'2024',abstract:'Host response mechanisms.',selected:true,text:'bacterial immune response stress host'},
  {id:'b',title:'Host defence signalling',authors:['Ben Two'],year:'2023',abstract:'Oxidative stress drives immune defence.',selected:true,text:'bacterial immune response stress host'},
  {id:'c',title:'Cellular transport systems',authors:['José García'],year:'2022',abstract:'Marine membrane trafficking.',userTags:['Transport'],notes:'Specialmemo observation',selected:true,text:'membrane transport response host'},
  {id:'off',title:'Stress outside this map',authors:[],year:'2021',selected:false,text:'bacterial immune response stress host'}
 ],threshold:.05};
 fs.writeFileSync(path.join(profile,'library.json'),JSON.stringify(fixture));
 const root=path.resolve(__dirname,'..');
 const backend=spawn(process.env.PULSE_TEST_PYTHON||(process.platform==='win32'?'python':'python3'),['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'},stdio:['ignore','pipe','pipe']});
 let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exited '+code));});});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1247,height:1031}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&document.querySelectorAll('#map .node').length===3);
  await page.evaluate(()=>{
   enrichLibraryAutomatically=()=>{};warmDiscoveryForPaper=()=>{};
   state.links=[{source:'a',target:'b',score:.9,type:'citation'},{source:'b',target:'c',score:.8,type:'similarity'},{source:'a',target:'off',score:.7,type:'bibliographic'}];render();
  });
  await page.waitForFunction(()=>document.querySelectorAll('#map .edge').length===2);
  const search=page.locator('#networkSearchInput');
  const matches=()=>page.locator('#map .node.is-network-match').evaluateAll(nodes=>nodes.map(node=>node.dataset.id).sort());
  const find=async(query,count)=>{await search.fill(query);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve())));await page.waitForFunction(expected=>document.querySelectorAll('#map .node.is-network-match').length===expected,count);};
  await page.waitForFunction(()=>document.getElementById('networkSearchCount').textContent==='3 papers');
  await page.evaluate(()=>{window.searchOriginalNodes=[...document.querySelectorAll('#map .node')];window.searchOriginalPositions=state.papers.map(p=>[p.id,p.x,p.y]);window.searchOriginalPerformance={...state.graphPerformance};window.searchOriginalSelection=state.selectedId;});
  await find('stress',2);assert.deepEqual(await matches(),['a','b']);
  assert.equal(await page.locator('#map .edge.is-network-match').count(),1);
  assert.equal(await page.locator('#map .edge.is-network-match').getAttribute('data-type'),'citation');
  assert.equal(await page.locator('#map .node.is-network-dimmed').count(),1);
  assert.equal(await page.locator('#networkSearchLinks').innerText(),'1 link');
  await find('stress, transport',3);assert.equal(await page.locator('#map .edge.is-network-match').count(),2);
  await page.selectOption('#networkSearchMatch','all');await page.waitForFunction(()=>document.getElementById('networkSearchCount').textContent==='No matches');
  await find('stress bacterial',1);assert.deepEqual(await matches(),['a']);
  await find('"oxidative stress"',1);assert.deepEqual(await matches(),['b']);
  await find('cell',0);await find('cellular',1);assert.deepEqual(await matches(),['c']);
  await find('garcia',1);assert.deepEqual(await matches(),['c']);
  await find('specialmemo',1);assert.deepEqual(await matches(),['c']);
  await find('#Transport',1);assert.deepEqual(await matches(),['c']);
  await find('stress',2);
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#map .node')].every((node,index)=>node===window.searchOriginalNodes[index])),true,'Typing keeps the existing SVG nodes');
  assert.deepEqual(await page.evaluate(()=>state.papers.map(p=>[p.id,p.x,p.y])),await page.evaluate(()=>window.searchOriginalPositions),'Typing does not move the graph');
  assert.deepEqual(await page.evaluate(()=>state.graphPerformance),await page.evaluate(()=>window.searchOriginalPerformance),'Typing does not recompute relationships or layouts');
  assert.equal(await page.evaluate(()=>state.selectedId),await page.evaluate(()=>window.searchOriginalSelection),'Searching preserves the inspected paper');
  await search.press('Enter');assert.deepEqual(await matches(),['a','b']);
  await page.selectOption('#canvasLayoutSelect','radial');await page.waitForFunction(()=>document.querySelectorAll('#map .node.is-network-match').length===2);
  await page.locator('#map .node[data-id=a]').click({force:true});assert.deepEqual(await matches(),['a','b']);
  await page.evaluate(()=>{state.papers.find(p=>p.id==='b').abstract='Unrelated experimental study';render();});
  await page.waitForFunction(()=>document.querySelectorAll('#map .node.is-network-match').length===1);assert.deepEqual(await matches(),['a'],'Edited abstracts invalidate the search index');
  await page.click('[data-rail=timeline]');assert.equal(await page.locator('#networkSearch').isVisible(),false);
  await page.click('[data-rail=network]');await page.waitForFunction(()=>document.querySelectorAll('#map .node.is-network-match').length===1);assert.equal(await search.inputValue(),'stress');
  await search.press('Escape');await page.waitForFunction(()=>!document.getElementById('map').classList.contains('network-search-active'));
  assert.equal(await search.inputValue(),'');assert.equal(await page.locator('#map .is-network-dimmed').count(),0);
  await search.fill('"unfinished');await page.waitForFunction(()=>document.getElementById('networkSearchInput').getAttribute('aria-invalid')==='true');
  assert.match(await page.locator('#networkSearchStatus').getAttribute('aria-label'),/quotation mark/);
  await page.click('#networkSearchClear');await page.waitForFunction(()=>document.getElementById('networkSearchInput').value==='');
  await find('stress',1);await page.locator('#ribbonNewMapTabBtn').click();await page.waitForFunction(()=>document.querySelectorAll('#map .node').length===0);
  await page.waitForFunction(()=>document.getElementById('networkSearchCount').textContent==='No matches');
  await page.locator('[data-action="switch-map-tab"][data-map-id="map-1"]').click();await page.waitForFunction(()=>document.querySelectorAll('#map .node.is-network-match').length===1);
  await page.setViewportSize({width:976,height:1031});
  assert.equal(await page.locator('#networkSearch').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'The controls fit a narrow canvas');
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'network-search.png')});}
  assert.deepEqual(errors,[]);
  console.log('PASS: active-map keyword/phrase/tag/author/note matching, Any/All, matching-endpoint links, whole words, accent folding, no layout or analysis work while typing, edits, redraws, selection, map switching, empty results, Escape and responsive controls.');
 }finally{await browser?.close();backend.kill();await new Promise(resolve=>backend.once('exit',resolve));fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
