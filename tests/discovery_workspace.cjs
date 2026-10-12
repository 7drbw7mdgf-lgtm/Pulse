const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-discovery-ui-'));
  const backend = spawn(process.env.PULSE_TEST_PYTHON || 'python3', ['pulse_backend.py'], {
    cwd:path.join(root, 'local-web/pulse-backend'),
    env:{...process.env, PULSE_CONFIG_DIR:profile, PULSE_PORT:'0', PULSE_DISABLE_BUNDLED_OLLAMA:'1', PYTHONDONTWRITEBYTECODE:'1'}
  });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Backend did not start')), 20000);
      backend.stdout.on('data', chunk => {
        const found = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) {clearTimeout(timer); resolve(found[0]);}
      });
      backend.on('exit', code => {clearTimeout(timer); reject(Error('Backend exited: '+code));});
    });
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1547,height:1031}}), errors=[];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://**', route => route.fulfill({status:200,body:'Fixture paper link'}));
    await page.route('**/api/metadata/**', route => route.fulfill({json:{ok:true,matched:false,metadata:{}}}));
    const citationRequests=[];
    await page.route('**/api/metadata/citation',async route=>{
      citationRequests.push(route.request().postDataJSON());
      await route.fulfill({json:{ok:true,candidateCount:2,groups:[{citation:'Martín-González et al., 2026',candidates:[
        {title:'Synthetic indexing methods',authors:['Ana Martín-González'],year:'2026',doi:'10.1234/citation-a',doiVerified:true,metadataSource:'Crossref'},
        {title:'Synthetic retrieval evaluation',authors:['Ana Martín-González'],year:'2026',doi:'10.1234/citation-b',doiVerified:true,journal:'Retrieval Studies',volume:'2',pages:'1-9',metadataSource:'Crossref'}]}]}});
    });
    await page.goto(url); await page.waitForFunction(() => state.autosaveReady);
    assert.equal(await page.locator('#discoveryResultLimit').inputValue(),'500');
    await page.locator('#discoveryResultLimit').selectOption('2000');
    assert.equal(await page.evaluate(()=>discoveryConfiguration().limit),2000);
    await page.locator('#railAddButton').click();await page.locator('#quickSearchInput').fill('(Martín-González et al., 2026)');await page.locator('#quickSearchInput').press('Enter');
    await page.locator('[data-citation-index="1"]').waitFor();
    assert.equal(await page.evaluate(()=>state.papers.length),0,'Citation text must never become a placeholder paper');
    assert.equal(await page.locator('#citationLookupAdd').isDisabled(),true);
    assert((await page.locator('[data-citation-index="1"]').boundingBox()).width<20,'Radio control must not consume the candidate text width');
    await page.setViewportSize({width:600,height:720});assert.equal(await page.locator('#citationLookupDialog').evaluate(el=>el.scrollWidth<=el.clientWidth),true);await page.setViewportSize({width:1547,height:1031});
    await page.locator('#citationLookupDialog').press('Escape');assert.equal(await page.evaluate(()=>state.papers.length),0);
    await page.evaluate(()=>addInTextCitations('(Martín-González et al., 2026)'));
    await page.locator('#citationLookupContext').fill('retrieval');await page.locator('#citationLookupSearch').click();
    await page.locator('[data-citation-index="1"]').waitFor();
    assert.equal(citationRequests.at(-1).context,'retrieval');
    await page.locator('[data-citation-index="1"]').check();await page.locator('#citationLookupAdd').click();
    assert.equal(await page.evaluate(()=>state.papers.length),1);
    assert.equal(await page.evaluate(()=>state.papers[0].doi),'10.1234/citation-b');
    assert.equal(await page.evaluate(()=>state.papers[0].volume),'2');
    if(process.env.PULSE_UI_SCREENSHOT_DIR){
      await page.evaluate(()=>addInTextCitations('(Martín-González et al., 2026)'));
      fs.mkdirSync(process.env.PULSE_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'citation-lookup.png')});
      await page.locator('#citationLookupClose').click();
    }
    await page.evaluate(()=>setRailAddOpen(false));
    await page.locator('#discoveryOptionsButton').click();
    const dbef=page.locator('[data-method="network"]');
    assert.match(await dbef.innerText(),/DBEF.*Shared references/s);
    await dbef.click(); assert.equal(await dbef.getAttribute('aria-pressed'),'false');
    await dbef.click(); assert.equal(await dbef.getAttribute('aria-pressed'),'true');
    await page.locator('#discoveryOptionsDone').click();
    await page.evaluate(() => {
      state.papers = Array.from({length:12}, (_,i) => normalizeImportedPaper({id:'fixture-'+i,
        title:'Library indexing study '+i, authors:['Example Author'], year:'2024', doi:'10.1234/library-'+i,
        abstract:'A synthetic document retrieval study.', text:'A synthetic document retrieval study.',
        metadataMatch:{matched:true}, metadataCheckedAt:new Date().toISOString()},'Fixture'));
      state.selectedId=state.papers[0].id; render();
    });
    assert.equal(await page.locator('#railLibraryBadge').count(),0);
    assert.equal(await page.locator('#clearButton').isVisible(),false);
    await page.locator('#libraryActionsMenu > summary').click();
    await page.locator('#clearButton').click();
    assert.equal(await page.locator('#clearPapersDialog').isVisible(),true);
    await page.locator('#clearPapersCancel').click();
    assert.equal(await page.evaluate(() => state.papers.length),12);
    assert.equal(await page.locator('#clearButton').isVisible(),false);
    for (const size of [{width:1547,height:1031},{width:1024,height:720}]) {
      await page.setViewportSize(size);
      const map = await page.locator('#map').boundingBox(), dock = await page.locator('.canvas-dock-modern').boundingBox();
      assert(map.y+map.height <= dock.y+1, 'Graph controls must never overlap the SVG, even after panning');
      assert.equal(await page.locator('.map-viewport .canvas-dock-modern').count(),0);
    }
    await page.setViewportSize({width:1547,height:1031});
    await page.evaluate(() => {
      window.fixtureResults = [
        {title:'Indexing study A',doi:'10.1234/first',year:'2020',score:90,matchLabel:'Related',abstract:'A synthetic retrieval abstract.',citationCount:null},
        {title:'Indexing study B',doi:'10.1234/second',year:'2025',score:80,matchLabel:'Related',abstract:'A second synthetic retrieval abstract.',citationCount:0,citationCountSource:'OpenAlex',citationCountsBySource:{OpenAlex:0}},
        {title:'Indexing study C',doi:'10.1234/third',year:'2018',score:70,matchLabel:'Explore',abstract:'A third synthetic retrieval abstract.',citationCount:0,citationCountSource:'OpenAlex',subType:'Bibliographic coupling',rankingMethod:'DBEF-content',dbef:{score:12.3,sharedReferenceIds:['W12','W13']},whyFound:[{kind:'shared-references',label:'Shares references',detail:'Shares 2 references with your seed, weighted by specificity and content relevance.'}]}
      ];
      openDiscoverySearching(state.papers[0],'fixture-run',{branches:{citationGraph:true,citationNetwork:true,semanticSearch:true,lexicalSearch:true},searchSources:{semanticScholar:true,europePmc:true,core:true}});
      updateDiscoverySearching({recommendations:window.fixtureResults,stage:'collecting',completed:1,total:6,
        branchesExecuted:['citationGraph','citationNetwork'],sourceCounts:{citationGraph:3,citationNetwork:1},errors:{},
        notices:{citationGraph:[{code:'extra-hop-limit',message:'Extra hops stopped at the limit.'}]}});
    });
    assert.equal(await page.locator('#discoveryProgressPanel').getAttribute('class').then(c=>c.includes('is-compact')),true);
    assert.equal(await page.locator('.dv-progress-sources').count(),0);
    const sourceHeight = await page.locator('#discoverySourceStatus').boundingBox();
    assert(sourceHeight.height < 30, 'Source statuses fit on a single row');
    assert.match(await page.locator('#discoverySourceStatus').innerText(),/DBEF/);
    await page.evaluate(() => {
      const job=state.discoverySearching.job;
      state.discoveryRunInfo.set('fixture-run',job);
      openDiscoveryModal(window.fixtureResults,state.papers[0],'fixture-run');
    });
    assert.equal(await page.locator('#discoverySourceNotice').isVisible(),false);
    assert.equal(await page.locator('.dv-source.is-fail').count(),0);
    await page.locator('[data-dv-focus="doi:10.1234/second"]').click();
    await page.locator('#discoverySortBy').selectOption('year-asc');
    assert.equal(await page.locator('#discoveryPreview').getAttribute('data-paper-key'),'doi:10.1234/second');
    assert.equal(await page.locator('.dv-row.is-focused [aria-current="true"]').getAttribute('data-dv-focus'),'doi:10.1234/second');
    await page.locator('.discovery-item-checkbox[data-paper-key="doi:10.1234/third"]').check();
    assert.equal(await page.locator('#discoveryPreview').getAttribute('data-paper-key'),'doi:10.1234/third');
    const facts = await page.locator('.dv-paper-facts').innerText();
    assert.match(facts,/10\.1234\/third\s+Citation count unavailable/);
    const [doi, count] = await page.locator('.dv-paper-facts > *').evaluateAll(nodes => nodes.map(n=>({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));
    assert(doi.bottom < count.top, 'DOI and citation count occupy separate lines');
    const link = page.locator('#discoveryPreview .dv-links a').filter({hasText:'Open paper'});
    assert.equal(await link.getAttribute('href'),'https://doi.org/10.1234/third');
    const popupPromise=page.waitForEvent('popup'); await link.click();
    const popup=await popupPromise; await popup.waitForLoadState();
    assert.equal(popup.url(),'https://doi.org/10.1234/third'); await popup.close();
    if (process.env.PULSE_UI_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.PULSE_UI_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'discovery.png')});
      await page.locator('#discoveryModalCloseButton').click();
      await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'workspace.png')});
      await page.evaluate(()=>openDiscoveryModal(window.fixtureResults,state.papers[0],'fixture-run'));
    }
    await page.locator('#discoveryFilterText').fill('does not exist');
    assert.equal(await page.locator('.dv-row.is-focused').count(),0);
    assert.equal(await page.locator('#discoveryPreview').getAttribute('data-paper-key'),'');
    assert(!await page.locator('#discoveryPreview').innerText().then(t=>t.includes('Indexing study C')));
    assert.deepEqual(errors,[]);
    console.log('PASS: real-browser preview selection, resorting, clearing, successful limited searches, compact statuses, separated metadata, paper-link opening, graph space and safe Library actions.');
  } finally {
    if (browser) await browser.close();
    backend.kill();
    await new Promise(resolve => backend.exitCode !== null ? resolve() : backend.once('exit',resolve));
    fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
