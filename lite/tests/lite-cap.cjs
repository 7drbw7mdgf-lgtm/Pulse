const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
(async()=>{
  const config=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-lite-cap-'));
  const root=path.resolve(__dirname,'..');
  const backend=spawn('python3',['pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_LITE_CONFIG_DIR:config,PULSE_PORT:'0'}});
  let browser;
  try {
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Backend startup timeout')),15000);
      backend.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      backend.on('exit',code=>{clearTimeout(timer);reject(new Error(`Backend exited ${code}`));});
    });
    browser=await chromium.launch({headless:true,...(process.env.PULSE_BROWSER_CHANNEL?{channel:process.env.PULSE_BROWSER_CHANNEL}:{})});
    const page=await browser.newPage({viewport:{width:1280,height:800}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(url);await page.waitForFunction(()=>state.autosaveReady);
    const health=await page.evaluate(async()=> (await fetch(backendUrl('/api/health'),{headers:apiHeaders()})).json());
    assert.equal(health.backend,'pulse-lite');assert.equal(health.paperLimit,15);
    for(let i=0;i<15;i++){
      await page.locator('#quickSearchInput').fill(`Manual paper ${i}`);await page.locator('#quickAddBtn').click();
      await page.waitForFunction(n=>state.papers.length===n,i+1);
    }
    assert.equal(await page.locator('#litePaperCount').textContent(),'15 / 15 papers');
    await page.locator('#quickSearchInput').fill('Sixteenth manual paper');await page.locator('#quickAddBtn').click();
    assert.equal(await page.evaluate(()=>state.papers.length),15);assert.equal(await page.locator('#quickSearchInput').inputValue(),'Sixteenth manual paper');
    await page.locator('#quickSearchInput').fill('Manual paper 0');await page.locator('#quickAddBtn').click();
    assert.equal(await page.evaluate(()=>state.papers.length),15,'Duplicates do not consume slots');
    await page.locator('[data-rail="library"]').click();await page.locator('[data-action="table-remove"]').first().click();
    assert.equal(await page.evaluate(()=>state.papers.length),14,'Visible Library removal frees a slot');
    await page.locator('#quickSearchInput').fill('Replacement paper');await page.locator('#quickAddBtn').click();
    assert.equal(await page.evaluate(()=>state.papers.length),15);
    const seed=async(n=14)=>page.evaluate(n=>{applyMapPayload({papers:Array.from({length:n},(_,i)=>({id:`seed-${i}`,title:`Seed paper ${i}`,year:String(2000+i)})),workspaceView:'discover',selectedId:'seed-0',pinnedSeedId:'seed-0'});state.discoveryResults=[];state.discoverySelectedKeys=new Set();render();},n);
    const importFile=async(name,mimeType,text)=>page.locator('#fileInput').setInputFiles({name,mimeType,buffer:Buffer.from(text)});
    const formats=[
      ['cap.json','application/json',JSON.stringify({papers:Array.from({length:20},(_,i)=>({id:`new-${i}`,title:`Imported paper ${i}`})),explicitLinks:[{source:'new-0',target:'new-1',score:0.8,type:'citation'}]})],
      ['cap.ris','text/plain',Array.from({length:20},(_,i)=>`TY  - JOUR\nTI  - Imported paper ${i}\nPY  - 2024\nER  -\n`).join('\n')],
      ['cap.bib','text/plain',Array.from({length:20},(_,i)=>`@article{record${i}, title={Imported paper ${i}}, year={2024}}`).join('\n')],
      ['cap.csv','text/csv','Title,Year\n'+Array.from({length:20},(_,i)=>`Imported paper ${i},2024`).join('\n')]
    ];
    for(const [name,mime,text] of formats){
      await seed();await importFile(name,mime,text);await page.waitForFunction(()=>state.papers.length===15);
      assert.equal(await page.evaluate(()=>state.papers.filter(p=>p.title.startsWith('Imported paper')).length),1,`${name} uses only the remaining slot`);
      await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Skipped 19'));
      assert.equal(await page.evaluate(()=>state.explicitLinks.length),0,'Links to skipped papers are dropped');
    }
    const merged=await page.evaluate(()=>addParsedPapers([normalizeImportedPaper({title:'Seed paper 0',abstract:'Merged metadata'},'test')]));
    assert.equal(merged.merged,1);assert.equal(merged.added,0);assert.equal(await page.evaluate(()=>state.papers.length),15);
    for(const target of ['Map','Library']){
      await seed();await page.evaluate(()=>openDiscoveryModal(Array.from({length:20},(_,i)=>({title:`Discovered paper ${i}`,score:85,branch:'citationGraph',reason:'Related to seed'})),state.papers[0]));
      await page.locator('#discoverySelectAllBtn').click();await page.locator(`#discoveryAddSelected${target}Btn`).click();
      assert.equal(await page.evaluate(()=>state.papers.length),15);
      assert.equal(await page.evaluate(()=>state.explicitLinks.length),target==='Map'?1:0);
      await page.locator('[data-rail="discover"]').click();
      assert.equal(await page.locator('#discoveryAddSelectedMapBtn').isDisabled(),true,'Discovery additions disabled at cap');
    }
    for(const direction of ['backward','forward','network','chase']){
      await seed();const added=await page.evaluate(direction=>{const result=addCitationPapersToMap(state.papers[0],Array.from({length:20},(_,i)=>({title:`Citation ${direction} ${i}`})),direction);render();return result;},direction);
      assert.equal(added,1);assert.equal(await page.evaluate(()=>state.papers.length),15);
    }
    await seed();assert.equal(await page.evaluate(()=>addRecommendationTrailToMap(state.papers[0],Array.from({length:20},(_,i)=>({title:`Trail ${i}`})),20)),1);
    assert.equal(await page.evaluate(()=>state.papers.length),15);
    await seed();await page.evaluate(()=>{state.seminalSuggestions=[{title:'Seminal one'},{title:'Seminal two'}];addSeminalPaperToMap(0);addSeminalPaperToMap(1);});
    assert.equal(await page.evaluate(()=>state.papers.length),15);
    await seed();await page.evaluate(()=>{const key=recommendationKey(selectedPapersForRecommendation());state.recommendations.set(key,[{title:'Recommended one'},{title:'Recommended two'}]);addRecommendedPaperToMap(0);state.selectedId='seed-0';addRecommendedPaperToMap(1);});
    assert.equal(await page.evaluate(()=>state.papers.length),15);assert.equal(await page.evaluate(()=>state.explicitLinks.length),1);
    await page.route('**/api/metadata/pmid',route=>{const id=route.request().postDataJSON().pmid;return route.fulfill({json:{metadata:{title:`PMID fixture ${id}`,pmid:id}}});});
    await seed();await page.evaluate(()=>Promise.all([addPaperFromInput('PMID:111'),addPaperFromInput('PMID:222')]));
    assert.equal(await page.evaluate(()=>state.papers.length),15,'Concurrent lookups cannot exceed cap');
    let doiLookups=0;await page.route('**/api/metadata/doi',route=>{doiLookups++;return route.fulfill({json:{metadata:{title:'DOI fixture',doi:'10.1234/lite'}}});});
    await seed();await page.evaluate(()=>addPaperFromInput('10.1234/lite'));assert.equal(await page.evaluate(()=>state.papers.length),15);
    const beforeLookups=doiLookups;await page.evaluate(()=>addPaperFromInput('10.1234/overflow'));assert.equal(doiLookups,beforeLookups,'No unnecessary DOI lookup at cap');
    const beforeIds=await page.evaluate(()=>state.papers.map(p=>p.id));
    assert.equal(await page.evaluate(()=>applyMapPayload({papers:Array.from({length:16},(_,i)=>({title:String(i)}))})),false);
    assert.deepEqual(await page.evaluate(()=>state.papers.map(p=>p.id)),beforeIds,'Oversized restored payload does not mutate the current library');
    await page.evaluate(()=>{clearTimeout(state.autosaveTimer);return saveLibrary();});
    await page.reload();await page.waitForFunction(()=>state.autosaveReady&&state.papers.length===15);
    const savedBefore=fs.readFileSync(path.join(config,'library.json'),'utf8');
    const blocked=await page.evaluate(async()=>{const response=await fetch(backendUrl('/api/library'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({papers:Array.from({length:16},(_,i)=>({title:String(i)})),paperLimit:999})});return response.status;});
    assert.equal(blocked,413);assert.equal(fs.readFileSync(path.join(config,'library.json'),'utf8'),savedBefore,'Rejected API save preserves existing data');
    const downloadPromise=page.waitForEvent('download');await page.locator('#exportButton').click();const download=await downloadPromise;
    const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(exported.papers.length,15);assert.equal(exported.edition,'lite');assert.equal(exported.paperLimit,15);
    await page.locator('[data-rail="timeline"]').click();assert.equal(await page.locator('[data-timeline-id]').count(),15);
    await page.locator('[data-rail="network"]').click();assert.equal(await page.locator('.pulse-col-library').isVisible(),false);
    if(process.env.PULSE_LITE_SCREENSHOT_PATH) await page.screenshot({path:process.env.PULSE_LITE_SCREENSHOT_PATH});
    await page.evaluate(()=>{clearTimeout(state.autosaveTimer);state.autosaveReady=false;});
    const oversized=JSON.stringify({papers:Array.from({length:16},(_,i)=>({title:`Saved ${i}`}))});fs.writeFileSync(path.join(config,'library.json'),oversized);
    await page.reload();await page.waitForFunction(()=>state.libraryRestoreBlocked&&!state.autosaveReady);
    assert.equal(await page.evaluate(()=>state.papers.length),0);assert.equal(fs.readFileSync(path.join(config,'library.json'),'utf8'),oversized,'Over-cap disk library preserved');
    await page.locator('#settingsButton').click();await page.locator('[data-settings-tab="storage"]').click();await page.locator('#clearAppToDefaultButton').click();
    await page.waitForFunction(()=>state.autosaveReady&&!state.libraryRestoreBlocked);
    await page.evaluate(()=>saveLibrary());assert.equal(JSON.parse(fs.readFileSync(path.join(config,'library.json'),'utf8')).papers.length,0);
    assert.deepEqual(errors,[]);
    console.log('PASS: Lite 15-paper cap, imports, duplicates, discovery/citation/seminal/recommendation additions, concurrent lookups, slot release, API limits, export/reload and oversized-file preservation');
  }finally{if(browser)await browser.close();backend.kill('SIGTERM');fs.rmSync(config,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
