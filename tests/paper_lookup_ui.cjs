const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');

(async()=>{
  const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-concept-ui-'));
  const backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['pulse_backend.py'],{
    cwd:path.join(root,'local-web/pulse-backend'),env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
  let browser;
  try{
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Backend did not start')),20000);
      backend.stdout.on('data',chunk=>{const found=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(found){clearTimeout(timer);resolve(found[0]);}});
      backend.on('exit',code=>{clearTimeout(timer);reject(Error('Backend exited: '+code));});
    });
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1547,height:1031}}),errors=[],requests=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);await page.waitForFunction(()=>state.autosaveReady);
    const invalid=await page.evaluate(async()=>{
      const response=await fetch(backendUrl('/api/search/paper'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({query:'ordinary keywords'})});
      return {status:response.status,body:await response.json()};
    });
    assert.equal(invalid.status,400);assert.match(invalid.body.error,/DOI/);
    const result={title:'Host-Derived Reactive Oxygen Species in the Gut Epithelium',authors:['Pranaya Kansakar'],year:'2025',doi:'10.3390/antiox14101156',doiVerified:true,abstract:'A verified paper.',score:null,paperLookup:true,matchLabel:'Exact lookup',sourceList:['Crossref'],discoveryBadges:['Exact lookup'],branches:['paperLookup']};
    let fail=false;
    await page.route('**/api/search/paper',async route=>{
      const request=route.request().postDataJSON();requests.push(request);
      await route.fulfill(fail?{status:404,json:{error:'No paper found at this link.'}}:{json:{status:'complete',ok:true,searchMode:'paper',recommendations:[result],sourceCounts:{paperLookup:1},branchesExecuted:['paperLookup'],rankingNotice:'Exact paper lookup · no similarity ranking applied',errors:{}}});
    });
    let conceptRequests=0;
    await page.route('**/api/discovery/start',async route=>{conceptRequests++;await route.fulfill({json:{status:'complete',recommendations:[],errors:{}}});});
    // Identifier punctuation bypasses keyword/tag parsing, and no enabled topic source is required.
    await page.evaluate(()=>{state.discoverySearchScope='online';state.discoverySearchTags=['old-filter'];state.discoverySearchSources={semanticScholar:false,europePmc:false,core:false,arxiv:false};});
    const references=['10.3390/antiox14101156','https://doi.org/10.3390/antiox14101156','https://journal.example/article?paper=123&key=100%25#section','doi: 10.1234/example;part','doi.org/10.3390/antiox14101156'];
    for(const [index,reference] of references.entries()){
      await page.locator('#discoveryResearchQuestion').fill(reference);
      if(index%2)await page.locator('#unifiedSearchButton').click();else await page.locator('#discoveryResearchQuestion').press('Enter');
      await page.waitForFunction(()=>!state.discoveryLoading&&state.discoveryResults.length===1);
      assert.equal(requests.at(-1).query,reference.startsWith('doi.org/')?'https://'+reference:reference);assert.equal(conceptRequests,0);
      assert.equal(await page.locator('#discoveryModalTitle').innerText(),'Paper lookup');
      assert.match(await page.locator('#discoveryModalEyebrow').innerText(),/DOI or article link/i);
      assert.match(await page.locator('#discoveryPaperList').innerText(),/Host-Derived Reactive/);
      assert.equal(await page.evaluate(()=>state.papers.length),0,'Lookup does not silently import a record');
      await page.locator('#discoveryModalCloseButton').click();
    }
    fail=true;await page.locator('#discoveryResearchQuestion').fill('https://journal.example/missing');await page.locator('#unifiedSearchButton').click();
    await page.waitForFunction(()=>!state.discoveryLoading);
    assert.equal(await page.locator('#discoveryModal').isVisible(),false);
    assert.equal(await page.evaluate(()=>state.papers.length),0);
    fail=false;await page.locator('#discoveryResearchQuestion').fill(references[0]);await page.locator('#unifiedSearchButton').click();await page.waitForFunction(()=>!state.discoveryLoading&&state.discoveryResults.length===1);
    await page.locator('.discovery-item-checkbox').first().check();await page.locator('#discoveryAddSelectedMapBtn').click();
    assert.equal(await page.evaluate(()=>state.papers.length),1,'The user can explicitly add the lookup result');
    assert.equal(await page.evaluate(()=>state.papers[0].doi),result.doi);
    await page.locator('#discoveryResearchQuestion').fill(references[0]);await page.locator('#unifiedSearchButton').click();await page.waitForFunction(()=>!state.discoveryLoading);
    assert.equal(await page.evaluate(()=>state.discoveryQueue),'library');
    assert.match(await page.locator('#discoveryPaperList').innerText(),/Host-Derived Reactive/,'An already-saved exact lookup stays visible');
    assert.equal(await page.evaluate(()=>state.papers.length),1);
    await page.locator('#discoveryModalCloseButton').click();
    // Library scope searches DOI/URL fields exactly and survives workspace persistence.
    await page.evaluate(()=>{state.discoverySearchScope='library';state.discoverySearchTags=[];});
    await page.locator('#discoveryResearchQuestion').fill('https://doi.org/10.3390/antiox14101156');await page.locator('#discoveryResearchQuestion').press('Enter');
    assert.equal(await page.locator('.library-table tbody tr.library-table-row').count(),1);
    await page.evaluate(()=>saveLibrary());await page.reload();await page.waitForFunction(()=>state.autosaveReady);
    assert.equal(await page.evaluate(()=>state.librarySearchTerms.reference),'https://doi.org/10.3390/antiox14101156');
    await page.evaluate(()=>{if(!state.libraryFullscreen)setLibraryFullscreen(true);});
    assert.equal(await page.locator('.library-table tbody tr.library-table-row').count(),1);
    const before=requests.length;await page.locator('#discoveryResearchQuestion').fill('10.1234/not-in-library');await page.locator('#discoveryResearchQuestion').press('Enter');
    assert.equal(await page.locator('.library-table tbody tr.library-table-row').count(),0);
    assert.equal(requests.length,before,'Library lookups remain local');
    const local=await page.evaluate(()=>{
      const query={reference:'https://journal.example/article?id=1&utm_source=mail'};
      return [localSearchMatches({url:'https://journal.example/article?id=1'},query),localSearchMatches({url:'https://journal.example/article?id=2'},query),localSearchMatches({url:'https://journal.example/article?id=1'},{reference:'https://journal.example/%broken'})];
    });
    assert.deepEqual(local,[true,false,false]);
    assert.deepEqual(errors,[]);
    console.log('PASS: DOI and article-link lookup by Enter or button, no keyword search, disabled-source independence, error recovery, explicit import and exact local-library matches.');
  }finally{await browser?.close();if(backend.exitCode===null){const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill('SIGTERM');await stopped;}fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
