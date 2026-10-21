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
    const page = await browser.newPage({viewport:{width:1440,height:1031}}), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
    await page.goto(url);
    await page.waitForFunction(() => state.autosaveReady && document.querySelectorAll('#map .node').length === 2);
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
    assert.equal(await page.locator('#mapClearAll .dock-btn-label').innerText(), 'Undo');
    await page.click('#mapClearAll');
    await page.waitForFunction(() => document.querySelectorAll('#map .node').length === 2);
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
    const controls=['#canvasLayoutSelect','#canvasLinksSelect','#threshold','#mapModePan','#mapModeSelect','#mapClearAll','#mapToolsMenu > summary'];
    const centers=[];
    for(const selector of controls){const box=await page.locator(selector).boundingBox();centers.push(box.y+box.height/2);}
    assert(Math.max(...centers)-Math.min(...centers)<=4,'All map controls share one row at the annotated canvas width');
    assert((await page.locator('#canvasLayoutSelect').boundingBox()).width<=75,'Layout field is compact');
    assert((await page.locator('#canvasLinksSelect').boundingBox()).width<=100,'Links field is compact');
    if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.locator('.canvas-dock-modern').screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'map-toolbar-single-row.png')});}
    await page.click('#inspectorToggle');
    for (const size of [{width:1440,height:1031},{width:976,height:1031},{width:800,height:720}]) {
      await page.setViewportSize(size);
      const dock = await page.locator('.canvas-dock-modern').boundingBox();
      const map = await page.locator('#map').boundingBox();
      assert(map.y + map.height <= dock.y + 1, 'Controls stay outside the graph viewport');
      assert(dock.y + dock.height <= size.height, 'The complete toolbar stays on screen');
      assert.equal(await page.locator('.canvas-dock-modern').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'Toolbar fits '+size.width+'px');
      await trigger.click();
      await page.waitForFunction(() => document.getElementById('mapToolsPopup').getBoundingClientRect().top >= document.querySelector('.pulse-col-canvas').getBoundingClientRect().top);
      const popup = await page.locator('#mapToolsPopup').boundingBox();
      const canvas = await page.locator('.pulse-col-canvas').boundingBox();
      assert(popup.y >= canvas.y && popup.x >= canvas.x && popup.x + popup.width <= canvas.x + canvas.width + 1, 'Tools fit within the canvas: '+JSON.stringify({size,popup,canvas}));
      await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, []);
    console.log('PASS: map tools keyboard/outside dismissal, focus, labels, panels, spacing, pointer modes, clear/undo, layout, links, threshold and responsive toolbar bounds.');
  } finally {
    await browser?.close();
    const stopped = new Promise(resolve => backend.once('exit', resolve)); backend.kill(); await stopped;
    fs.rmSync(profile, {recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
