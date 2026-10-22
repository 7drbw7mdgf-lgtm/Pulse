const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawn} = require('node:child_process'), {chromium} = require('playwright');

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-map-toolbar-'));
  fs.writeFileSync(path.join(profile, 'library.json'), JSON.stringify({papers:[
    {id:'a', title:'Bacterial stress responses', authors:['Example Author'], year:'2024', selected:true, text:'bacterial immune response stress host'},
    {id:'b', title:'Host defence mechanisms', authors:['Second Author'], year:'2023', selected:true, text:'bacterial immune response stress host'}
  ], threshold:.05}));
  const backend = spawn(process.env.PULSE_TEST_PYTHON || 'python3', ['-B', 'local-web/pulse-backend/pulse_backend.py'], {
    cwd:root, env:{...process.env, PULSE_CONFIG_DIR:profile, PULSE_PORT:'0', PULSE_DISABLE_BUNDLED_OLLAMA:'1'}
  });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Backend timeout')), 15000);
      backend.stdout.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      backend.once('exit', code => { clearTimeout(timer); reject(Error('Backend exited '+code)); });
    });
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1031}}), errors = [], reportedErrors=[];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request',request=>{if(request.url().endsWith('/api/crash-reports/record'))reportedErrors.push(request.postDataJSON());});
    await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    await page.route('**/api/metadata/**', route => route.fulfill({json:{ok:true,matched:false,metadata:{}}}));
    await page.goto(url);
    await page.waitForFunction(() => state.autosaveReady && document.querySelectorAll('#map .node').length === 2);
    assert.equal(await page.locator('.canvas-dock-modern #metricPapers').count(),0,'Map totals sit outside the controls');
    assert.equal(await page.locator('.map-totals-pill #metricPapers').innerText(),'2');
    assert.equal(await page.locator('#app > .pulse-nav-rail').count(),0,'The vertical sidebar is removed');
    const navigation=page.locator('.map-controls-footer nav[aria-label="Workspace navigation"]');
    assert.equal(await navigation.locator('[data-rail]').first().getAttribute('data-rail'),'library','Library comes first in the bottom navigation');
    assert((await page.locator('#colLibrary').boundingBox()).x<=1,'The paper list occupies the left edge of the window');
    await page.click('#railLibraryBtn');
    await page.waitForFunction(()=>document.getElementById('colLibrary').classList.contains('is-swiped-hidden'));
    await page.click('#railLibraryBtn');
    await page.waitForFunction(()=>!document.getElementById('colLibrary').classList.contains('is-swiped-hidden'));
    for(const [rail,view] of [['trends','#trendsView'],['timeline','#timelineView']]){
      await navigation.locator(`[data-rail="${rail}"]`).click();
      assert.equal(await page.locator(view).isVisible(),true);
      assert.equal(await navigation.locator(`[data-rail="${rail}"]`).getAttribute('aria-current'),'page');
    }
    await page.click('#railBibliographyBtn');
    assert.equal(await page.locator('#app').evaluate(el=>el.classList.contains('library-fullscreen')),true);
    assert.equal(await navigation.isVisible(),true,'Bottom navigation remains usable in full-width Bibliography');
    await navigation.locator('[data-rail="network"]').click();
    assert.equal(await page.locator('.pulse-col-canvas').isVisible(),true);
    await page.click('#railSettingsBtn');
    assert.equal(await page.locator('#settingsPanel').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settingsPanel').isVisible(),false);
    const chooserReady = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+i');
    assert.equal((await chooserReady).isMultiple(),true,'Import shortcut still opens the file chooser without rail buttons');
    const exportReady = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    const exported = await exportReady;
    assert.equal(exported.suggestedFilename(),'paper-linkage-map.json');
    assert.equal(JSON.parse(fs.readFileSync(await exported.path(),'utf8')).papers.length,2,'Export shortcut still saves the library');
    const menu = page.locator('#mapToolsMenu'), trigger = page.locator('#mapToolsMenu > summary');
    assert.equal(await page.locator('#graphButton').isVisible(), false);
    await trigger.press('Enter');
    assert.equal(await page.locator('#graphButton').isVisible(), true, 'Enter opens the native disclosure');
    await page.selectOption('#labelModeInput', 'full');
    assert.equal(await page.evaluate(() => state.graphStyle.labelMode), 'full');
    await page.keyboard.press('Escape');
    assert.equal(await menu.getAttribute('open'), null);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true, 'Escape returns focus to Tools');
    await trigger.click();
    await page.click('#networkSearchInput');
    assert.equal(await menu.getAttribute('open'), null, 'Clicking outside dismisses the disclosure');
    await trigger.click();
    await page.locator('#aiButton').focus(); await page.keyboard.press('Tab');
    assert.equal(await menu.getAttribute('open'), null, 'Tab leaving Tools dismisses it');
    for (const [button, panel, close] of [
      ['graphButton','graphPanel','graphCloseButton'], ['areaButton','areaPanel','areaCloseButton'],
      ['linkageButton','linkagePanel','linkageCloseButton'], ['aiButton','aiPanel','aiCloseButton']
    ]) {
      await trigger.click(); await page.click('#'+button);
      assert.equal(await menu.getAttribute('open'), null);
      assert.equal(await page.locator('#'+panel).isVisible(), true, button+' still opens its panel');
      assert.equal(await page.locator('#'+panel).evaluate(el => el.contains(document.activeElement)), true);
      await page.click('#'+close);
    }
    const spacing = await page.evaluate(() => state.graphStyle.spacing || 1);
    await trigger.click(); await page.click('#blowUpButton');
    await page.waitForFunction(before => state.graphStyle.spacing > before, spacing);
    const expanded = await page.evaluate(() => state.graphStyle.spacing);
    await trigger.click(); await page.click('#compressButton');
    await page.waitForFunction(before => state.graphStyle.spacing < before, expanded);
    await page.click('#mapModeSelect');
    assert.equal(await page.locator('#mapModeSelect').getAttribute('aria-pressed'), 'true');
    await page.click('#mapModePan');
    assert.equal(await page.locator('#mapModePan').getAttribute('aria-pressed'), 'true');
    await page.click('#mapClearAll');
    assert.equal(await page.locator('#map .node').count(), 0);
    assert.equal(await page.locator('.map-totals-pill #metricPapers').innerText(),'0','Separate totals update when the map is cleared');
    assert.equal(await page.locator('#mapClearAll .dock-btn-label').innerText(), 'Undo');
    await page.click('#mapClearAll');
    await page.waitForFunction(() => document.querySelectorAll('#map .node').length === 2);
    assert.equal(await page.locator('.map-totals-pill #metricPapers').innerText(),'2','Separate totals update after undo');
    assert.equal(await page.locator('#mapClearAll .dock-btn-label').innerText(), 'Clear');
    await page.selectOption('#canvasLayoutSelect', 'radial');
    assert.equal(await page.evaluate(() => state.mode), 'radial');
    await page.selectOption('#canvasLinksSelect', 'citation');
    assert.equal(await page.evaluate(() => state.linkTypeFilter), 'citation');
    await page.selectOption('#canvasLinksSelect', 'all');
    await page.locator('#threshold').focus(); await page.keyboard.press('Home');
    assert.equal(await page.locator('#thresholdValue').innerText(), '1%');
    await page.setViewportSize({width:1457,height:1031});
    await page.evaluate(()=>els.app.style.setProperty('--library-width','220px'));
    await page.waitForFunction(()=>Math.abs(document.getElementById('colLibrary').getBoundingClientRect().width-220)<1);
    const controls=['#canvasLayoutSelect','#canvasLinksSelect','#threshold','#mapModePan','#mapModeSelect','#mapClearAll','#mapToolsMenu > summary'];
    const centers=[];
    for(const selector of controls){const box=await page.locator(selector).boundingBox();centers.push(box.y+box.height/2);}
    assert(Math.max(...centers)-Math.min(...centers)<=4,'Map controls share the first row');
    const fields=await page.locator('.dock-map-controls').boundingBox(), actions=await navigation.boundingBox();
    assert(actions.y>=fields.y+fields.height+6,'Workspace navigation occupies the second row');
    assert((await page.locator('#canvasLayoutSelect').boundingBox()).width<=64,'Layout field is compact');
    assert((await page.locator('#canvasLinksSelect').boundingBox()).width<=74,'Links field is compact');
    const compactMap=await page.locator('.map-viewport').boundingBox(), compactTotals=await page.locator('.map-totals-pill').boundingBox();
    assert(Math.abs(compactTotals.y-compactMap.y-12)<=1 && Math.abs(compactMap.x+compactMap.width-compactTotals.x-compactTotals.width-12)<=1,'Map totals sit at the top right of the map');
    await page.setViewportSize({width:1261,height:1031});
    await page.waitForFunction(()=>{
      const map=document.querySelector('.map-viewport').getBoundingClientRect(),dock=document.querySelector('.canvas-dock-modern').getBoundingClientRect();
      return dock.left>=map.left && dock.right<=map.right && dock.bottom<=map.bottom && dock.top>map.top;
    });
    assert.equal(await page.locator('.pulse-workspace-cols > .map-controls-footer').count(),1,'Controls use the map overlay without a separate bottom strip');
    if(process.env.PULSE_UI_SCREENSHOTS){
      fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});
      await page.locator('#networkSearchInput').focus();
      await page.waitForFunction(()=>Number(getComputedStyle(document.getElementById('toast')).opacity)<.01);
      await page.locator('.map-controls-footer').screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'bottom-navigation-controls.png')});
      await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'bottom-navigation-workspace.png')});
    }
    await page.click('#inspectorToggle');
    for (const size of [{width:1440,height:1031},{width:976,height:1031},{width:800,height:720}]) {
      await page.setViewportSize(size);
      const dock = await page.locator('.canvas-dock-modern').boundingBox();
      const footer = await page.locator('.map-controls-footer').boundingBox();
      const map = await page.locator('#map').boundingBox();
      await page.waitForFunction(()=>{
        const map=document.querySelector('.map-viewport').getBoundingClientRect(),dock=document.querySelector('.canvas-dock-modern').getBoundingClientRect();
        return dock.left>=map.left && dock.right<=map.right && dock.bottom<=map.bottom && dock.top>map.top;
      });
      const overlay=await page.locator('.canvas-dock-modern').boundingBox();
      assert(overlay.y>=map.y && overlay.y+overlay.height<=map.y+map.height,'Controls float inside the map');
      assert(footer.y + footer.height <= size.height, 'The toolbar stays on screen');
      assert.equal(await page.locator('.map-controls-footer').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Toolbar fits '+size.width+'px');
      const totals=await page.locator('.map-totals-pill').boundingBox(), reopen=await page.locator('#inspectorReopen').boundingBox();
      assert(totals.x+totals.width<=reopen.x-6,'Map totals leave room for the inspector button at '+size.width+'px');
      assert.equal(await page.locator('.canvas-dock-modern').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Toolbar fits '+size.width+'px');
      await trigger.click();
      await page.waitForFunction(() => document.getElementById('mapToolsPopup').getBoundingClientRect().top >= document.querySelector('.pulse-workspace-cols').getBoundingClientRect().top);
      const popup = await page.locator('#mapToolsPopup').boundingBox();
      const canvas = await page.locator('.map-viewport').boundingBox();
      assert(popup.y >= canvas.y && popup.x >= canvas.x && popup.x + popup.width <= canvas.x + canvas.width + 1, 'Tools fit within the canvas: '+JSON.stringify({size,popup,canvas}));
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(reportedErrors,[],'No browser resize warnings or unhandled errors are recorded');
    console.log('PASS: bottom navigation with Library first, all workspace views, full-width Bibliography, Settings, map tools, pointer modes, clear/undo, compact fields, top-right totals and responsive bounds.');
  } finally {
    await browser?.close();
    const stopped = new Promise(resolve => backend.once('exit', resolve)); backend.kill(); await stopped;
    fs.rmSync(profile, {recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
