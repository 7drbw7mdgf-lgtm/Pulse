const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-options-'));
 let backend,browser,url;
 const appearance=()=>JSON.parse(fs.readFileSync(path.join(profile,'appearance.json'),'utf8')).theme;
 async function start(){
  backend=spawn(process.env.PULSE_TEST_PYTHON||'python3',['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
  url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Backend timeout')),15000);backend.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.once('exit',code=>{clearTimeout(timer);reject(Error('Backend exit '+code));});});
 }
 async function stop(){if(backend){const exit=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await exit;backend=null;}}
 try{
  await start();browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'light'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&document.getElementById('themePreferenceStatus').textContent.includes('saved'));
  await page.click('#railSettingsBtn');
  assert.equal(await page.locator('#settingsTitle').innerText(),'Pulse Options');assert.equal(await page.locator('#settingsPageTitle').innerText(),'General');
  assert.equal(await page.locator('.theme-choice').count(),5);
  const bounds=await page.locator('.options-window').boundingBox();assert(bounds.width>=1000);assert(bounds.height>=700);
  await page.selectOption('#settingsTheme','sepia');await page.waitForFunction(()=>document.getElementById('themePreferenceStatus').textContent.includes('Appearance saved'));
  assert.equal(appearance(),'sepia');assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  assert.equal(await page.locator('input[name=pulseTheme][value=sepia]').isChecked(),true);
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--canvas').trim()),'#f7efdf');
  // Return to the previously saved theme while an earlier save is in flight.
  await page.route('**/api/appearance',async route=>{if(route.request().postDataJSON().theme==='dark')await new Promise(resolve=>setTimeout(resolve,180));await route.continue();});
  const started=page.waitForRequest(request=>request.url().endsWith('/api/appearance')&&request.postDataJSON().theme==='dark');
  await page.selectOption('#settingsTheme','dark');await started;await page.selectOption('#settingsTheme','sepia');
  await page.waitForFunction(()=>document.getElementById('themePreferenceStatus').textContent.includes('Appearance saved')&&state.pendingLibraryWrites.size===0);
  assert.equal(appearance(),'sepia','A slower previous request must not replace the latest theme');
  await page.unroute('**/api/appearance');let failAppearance=true;
  await page.route('**/api/appearance',route=>{if(failAppearance){failAppearance=false;return route.fulfill({status:503,json:{error:'Synthetic save failure'}});}return route.continue();});
  await page.check('input[name=pulseTheme][value=contrast]');assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.waitForFunction(()=>!document.getElementById('settingsThemeRetry').hidden);assert.equal(appearance(),'sepia','A failed save preserves the previous preference');
  await page.click('#settingsThemeRetry');await page.waitForFunction(()=>document.getElementById('themePreferenceStatus').textContent.includes('Appearance saved'));assert.equal(appearance(),'contrast');
  failAppearance=true;await page.selectOption('#settingsTheme','light');await page.waitForFunction(()=>!document.getElementById('settingsThemeRetry').hidden);
  await page.selectOption('#settingsTheme','contrast');assert.equal(await page.locator('#settingsThemeRetry').isVisible(),false,'Returning to the saved theme clears an earlier save error');
  assert.equal(await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--ink').trim()),'#fff');
  await page.selectOption('#settingsTheme','system');await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.emulateMedia({colorScheme:'light'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
  assert.equal(await page.locator('html').getAttribute('data-pulse-theme'),'system');
  await page.fill('#settingsSearch','semantic scholar');await page.locator('.options-search-result').first().click();
  assert.equal(await page.locator('#settingsPageTitle').innerText(),'Search & discovery');assert.equal(await page.locator('#semanticScholarKeyInput').isVisible(),true);
  await page.fill('#semanticScholarKeyInput','fixture-options-key');await page.check('#adaptiveCitationToggle');await page.selectOption('#adaptiveCitationIntent','focused');
  await page.click('#settingsApplyButton');await page.waitForFunction(()=>document.getElementById('settingsFooterStatus').textContent==='Preferences saved.');
  const stored=JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8'));assert.equal(stored.searchAdaptiveStructure,true);assert.equal(stored.searchStructuralIntent,'focused');assert(stored.semanticScholarApiKey.startsWith('enc:v1:'));
  await page.click('[data-settings-tab=extraction]');await page.uncheck('#autoGemmaExtractionInput');await page.click('#settingsApplyButton');await page.waitForFunction(()=>document.getElementById('settingsFooterStatus').textContent==='Preferences saved.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).autoGemmaExtraction,false);
  for(const [key,title,selector] of [['managers','Reference managers','#settingsMendeleyClientId'],['sync','Sync & privacy','#syncStartButton'],['storage','Storage & recovery','#storagePaperCount'],['updates','Updates','#pulseUpdateStatus']]){
   await page.click(`[data-settings-tab=${key}]`);assert.equal(await page.locator('#settingsPageTitle').innerText(),title);assert.equal(await page.locator(selector).isVisible(),true);assert.equal(await page.locator('#settingsApplyButton').isVisible(),false);
   if(key==='storage'){await page.click('#settingsOpenRecovery');await page.locator('#libraryRecoveryDialog[open]').waitFor();await page.click('#libraryRecoveryClose');}
  }
  await page.locator('[data-settings-tab=general]').focus();await page.keyboard.press('ArrowDown');assert.equal(await page.locator('[data-settings-tab=search]').getAttribute('aria-selected'),'true');
  await page.keyboard.press('ControlOrMeta+f');assert.equal(await page.locator('#settingsSearch').evaluate(el=>el===document.activeElement),true);
  await page.fill('#settingsSearch','<img src=x onerror=alert(1)>');assert.match(await page.locator('#settingsSearchResults').innerText(),/No matching/);assert.equal(await page.locator('#settingsSearchResults img').count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#settingsPanel').isVisible(),true);assert.equal(await page.locator('#settingsSearch').inputValue(),'');
  await page.locator('#settingsDoneButton').focus();await page.keyboard.press('Tab');assert.equal(await page.locator('#settingsCloseButton').evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#settingsPanel').isVisible(),false);assert.equal(await page.locator('#railSettingsBtn').evaluate(el=>el===document.activeElement),true);
  await page.click('#railSettingsBtn');await page.click('[data-settings-tab=general]');await page.selectOption('#settingsTheme','sepia');
  await page.waitForFunction(()=>state.pendingLibraryWrites.size===0);
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({animations:'disabled',path:path.join(process.env.PULSE_UI_SCREENSHOTS,'options-sepia.png')});}
  for(const width of [760,600,420]){
   await page.setViewportSize({width,height:800});
   assert.equal(await page.locator('.options-window').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,`${width}px options window must fit`);
   const footer=await page.locator('.options-footer').boundingBox();assert(footer.y+footer.height<=800);
   if(width===420&&process.env.PULSE_UI_SCREENSHOTS)await page.screenshot({animations:'disabled',path:path.join(process.env.PULSE_UI_SCREENSHOTS,'options-narrow.png')});
  }
  // A fresh backend origin restores the preference from the private profile.
  await stop();await start();await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&document.documentElement.dataset.pulseTheme==='sepia');
  assert.equal(await page.evaluate(()=>window.__PULSE_THEME_PREFERENCE__),'sepia');
  await page.setViewportSize({width:1440,height:1000});await page.click('#railSettingsBtn');assert.equal(await page.locator('#settingsTheme').inputValue(),'sepia');
  await page.selectOption('#settingsTheme','dark');await page.waitForFunction(()=>state.pendingLibraryWrites.size===0);
  if(process.env.PULSE_UI_SCREENSHOTS)await page.screenshot({animations:'disabled',path:path.join(process.env.PULSE_UI_SCREENSHOTS,'options-dark.png')});
  assert.deepEqual(errors,[]);
  console.log('PASS: Word-style categories, five live themes, OS appearance, save-race protection, restart persistence, safe settings search, global Apply, existing connection controls, keyboard focus and responsive layouts.');
 }finally{await browser?.close();await stop();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
