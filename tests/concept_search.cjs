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
    assert.equal(await page.evaluate(()=>state.papers.length),0);
    assert.equal(await page.locator('#ribbonConceptSearchButton').count(),0,'Concept search runs from the search bar with Enter');

    // Real HTTP route accepts seed-free topics and validates them before spawning a job.
    const validation=await page.evaluate(async()=>{
      const response=await fetch(backendUrl('/api/discovery/start'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({searchMode:'concept',query:' '})});
      return {status:response.status,data:await response.json()};
    });
    assert.equal(validation.status,400);assert.match(validation.data.error,/concept/);
    const job=await page.evaluate(async()=>{
      const response=await fetch(backendUrl('/api/discovery/start'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({searchMode:'concept',query:'cycling infrastructure',seedPapers:[],
        fullTextSearch:true,searchSources:{semanticScholar:false,europePmc:false,core:false},semanticRerank:false,pairwiseRerank:false})});
      const data=await response.json();
      if(data.id)await fetch(backendUrl('/api/discovery/cancel'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({id:data.id})});
      return {status:response.status,data};
    });
    assert.equal(job.status,202);assert(job.data.id);

    await page.evaluate(()=>{state.discoveryBranches={citationGraph:false,citationNetwork:false,semanticSearch:false,lexicalSearch:false};syncDiscoveryControls();});
    await page.locator('#discoveryOptionsButton').click();
    assert.equal(await page.locator('[data-search-source="europePmc"]').isDisabled(),false,
      'Standalone topic sources remain configurable independently of seed methods');
    await page.locator('#discoveryOptionsDone').click();

    let keywordMode='ai';
    const papers=[{title:'Protected bicycle lanes reduce intersection injuries',authors:['Ada Brooks'],year:'2025',doi:'10.1234/cycling',abstract:'Cycling infrastructure and junction safety.',score:85,matchStrength:'related',
      discoveryBadges:['Europe PMC'],sourceList:['Europe PMC'],reason:'Matches your concept',branches:['europePmc'],retrievalEvidence:[{channel:'concepts:topic-concepts',provider:'europePmc',query:'bicycle lanes intersection injuries',rank:1}]}];
    await page.route('**/api/discovery/start',async route=>{
      const request=route.request().postDataJSON();requests.push(request);
      await route.fulfill({json:{status:'complete',ok:true,searchMode:'concept',searchQuery:request.query,seedCount:0,recommendations:papers,
        conceptSearch:{query:request.query,keywords:['bicycle lanes','intersection injuries'],aiAssisted:keywordMode==='ai',notice:'Searching your original phrase; AI keyword expansion was unavailable.'},
        sourceCounts:{europePmc:1},branchesExecuted:['europePmc'],errors:{}}});
    });
    await page.locator('#discoveryResearchQuestion').fill('How do bicycle lanes reduce intersection injuries?');
    await page.locator('#discoveryResearchQuestion').press('Enter');
    await page.waitForFunction(()=>!state.discoveryLoading&&state.discoveryResults.length===1);
    assert.equal(requests.length,1);assert.equal(requests[0].searchMode,'concept');
    assert.deepEqual(requests[0].seedPapers,[]);assert.equal(requests[0].branches.citationGraph,false);
    assert.equal(requests[0].branches.lexicalSearch,true);
    assert.equal(await page.evaluate(()=>state.discoveryBranches.lexicalSearch),false,'A topic search must not overwrite saved seed-method preferences');
    assert.match(await page.locator('#discoveryModalEyebrow').innerText(),/matching your concept/i);
    assert.match(await page.locator('#discoveryModalSubtitle').innerText(),/bicycle lanes/);
    assert.match(await page.locator('#discoveryConceptSummary').innerText(),/AI search keywords.*bicycle lanes.*intersection injuries/s);
    assert.equal(await page.evaluate(()=>state.papers.length),0,'Searching must never import the query as a paper');
    assert.equal(await page.evaluate(()=>state.discoveryRunContext.seedPapers.length),0);
    await page.locator('.discovery-item-checkbox').first().check();
    await page.locator('#discoveryAddSelectedMapBtn').click();
    assert.equal(await page.evaluate(()=>state.papers.length),1,'Only a chosen real result is imported');
    assert.equal(await page.evaluate(()=>state.papers[0].doi),'10.1234/cycling');
    assert.equal(await page.evaluate(()=>state.papers.some(p=>p.title.startsWith('How do'))),false);

    // Repeat/refine keeps the original topic even after selection and input change.
    await page.evaluate(()=>{state.selectedId=state.papers[0].id;state.discoveryResearchQuestion='A different edited topic';});
    keywordMode='fallback';await page.evaluate(()=>repeatDiscoverySearch());
    assert.equal(requests.length,2);assert.equal(requests[1].query,requests[0].query);
    assert.deepEqual(requests[1].seedPapers,[]);
    assert.match(await page.locator('#discoveryConceptSummary').innerText(),/original phrase.*unavailable/s);
    const result=await page.evaluate(()=>state.discoveryResults[0]);
    await page.evaluate(item=>labelDiscoveryPaper(item,1),result);
    await page.locator('#discoveryRefineFeedback').click();
    await page.waitForFunction(()=>!state.discoveryLoading);
    assert.equal(requests.length,3);assert.equal(requests[2].relevanceFeedback.length,1);
    assert.deepEqual(requests[2].feedbackContext.seedPapers,[]);
    assert.equal(requests[2].feedbackContext.researchQuestion,requests[0].query);

    if(process.env.PULSE_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'concept-results.png')});}
    await page.locator('#discoveryModalCloseButton').click();
    await page.locator('#discoveryResearchQuestion').fill('cycling infrastructure');
    for(const size of [{width:1547,height:1031},{width:1024,height:720},{width:600,height:720}]){
      await page.setViewportSize(size);
      assert.equal(await page.locator('#discoveryResearchQuestion').isVisible(),true);
      if(size.width>=1500){
        const widths=await page.evaluate(()=>{const input=document.getElementById('discoveryResearchQuestion');const row=input.closest('label').parentElement;
          const rect=input.getBoundingClientRect();return {bar:rect.width,others:[...row.children].filter(child=>!child.contains(input)).map(child=>child.getBoundingClientRect()).filter(other=>other.top<rect.bottom&&other.bottom>rect.top).map(other=>other.width)};});
        assert.ok(widths.bar>=Math.max(...widths.others),'The search bar uses the freed space and is the widest ribbon control');
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Search controls must fit the viewport');
    }
    if(process.env.PULSE_UI_SCREENSHOT_DIR){await page.setViewportSize({width:1547,height:1031});
      await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'concept-toolbar.png')});}
    assert.deepEqual(errors,[]);
    console.log('PASS: seed-free concept HTTP route, input/Enter search, keyword intent, original-topic repeat/refine, fallback notice, real-result import and responsive toolbar.');
  }finally{await browser?.close();if(backend.exitCode===null){const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill('SIGTERM');await stopped;}fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
