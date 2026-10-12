const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-evidence-ui-'));
 const backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['pulse_backend.py'],{cwd:path.join(root,'local-web/pulse-backend'),env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 let browser;
 try{
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend startup timeout')),20000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.on('exit',code=>reject(Error('Backend exited '+code)));});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1547,height:1031}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/papers/status',route=>route.fulfill({json:{available:true,metadata:{publicationStatus:{status:'retracted',source:'Crossref',checkedAt:new Date().toISOString()},isRetracted:true,
   publicationNotices:[{type:'retraction',doi:'10.1234/notice',relation:'updated-by',date:'2026-02-04',source:'Crossref'}],publicationRelations:[{type:'has-preprint',doi:'10.1234/preprint'}]}}}));
  await page.route('**/api/papers/metrics',route=>route.fulfill({json:{ok:true,available:false}}));
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady);
  await page.evaluate(()=>{state.papers=[normalizeImportedPaper({id:'status-fixture',title:'Synthetic paper with a publication update',doi:'10.1234/original',doiVerified:true,authors:['Ada Brooks'],year:'2026'},'Fixture')];state.selectedId=state.papers[0].id;render();});
  await page.waitForFunction(()=>state.papers[0].isRetracted===true);
  assert.match(await page.locator('#detailsContent .publication-notices').innerText(),/Retracted/);
  assert.equal(await page.locator('#detailsContent .publication-notices a').count(),2);
  const saved=await page.evaluate(()=>serializeMap());assert.equal(saved.papers[0].isRetracted,true);assert.equal(saved.papers[0].publicationNotices[0].doi,'10.1234/notice');
  await page.evaluate(()=>applyFrankTheme('dark'));
  const color=await page.locator('#detailsContent .publication-notices').evaluate(node=>getComputedStyle(node).backgroundColor);assert.equal(color,'rgb(56, 27, 36)');
  if(process.env.PULSE_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'publication-notices.png')});}
  await page.goto(url+'/benchmark-review.html');await page.locator('#questions button').nth(39).waitFor();
  assert.equal(await page.locator('#questions button').count(),40);assert.match(await page.locator('.review-note').innerText(),/Unjudged papers are not automatically irrelevant/);
  await page.locator('#questions button').nth(20).click();assert.equal(await page.locator('#case select').first().inputValue(),'');
  await page.locator('#reviewer').fill('Test reviewer');await page.locator('#case select').first().selectOption('2');await page.locator('#case input[type="checkbox"]').first().check();
  assert.match(await page.locator('#reviewCount').innerText(),/1 paper judgments reviewed/);
  const downloadPromise=page.waitForEvent('download');await page.locator('#exportReview').click();const download=await downloadPromise;
  const review=JSON.parse(fs.readFileSync(await download.path(),'utf8'));const entry=review.cases.find(c=>c.id==='g01');
  assert.equal(entry.targets[0].reviewState,'reviewed');assert.equal(entry.targets[0].landmarkReviewState,'reviewed');assert.equal(entry.targets[0].landmark,true);
  assert.equal(entry.targets[1].reviewState,'provisional','Unreviewed distractors must not be silently promoted');
  assert.equal(review.provenance.review.reviewer,'Test reviewer');
  if(process.env.PULSE_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOT_DIR,'benchmark-review.png')});
  const expectedQuestion=entry.question;await page.locator('#case > a').click();await page.waitForFunction(()=>typeof state!=='undefined'&&state.autosaveReady);
  assert.equal(await page.locator('#discoveryResearchQuestion').inputValue(),expectedQuestion);
  assert.equal(await page.evaluate(()=>state.discoveryLoading),false,'Opening a question prefills it; searches require a user action');
  assert.deepEqual(errors,[]);console.log('PASS: source-backed notice links, preserved publication metadata, dark theme, 40-case review, explicit reviewed labels/export and topic-prefill without automatic searches.');
 }finally{await browser?.close();backend.kill('SIGTERM');fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
