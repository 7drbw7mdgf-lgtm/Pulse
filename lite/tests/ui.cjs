const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

(async () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  const root = path.resolve(__dirname, '..');
  const backend = spawn('python3', ['pulse_backend.py'], { cwd: root, env: {...process.env, PULSE_LITE_CONFIG_DIR:config, PULSE_PORT:'0'} });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend startup timed out')), 15000);
      backend.stdout.on('data', chunk => {
        const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      backend.on('exit', code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}`)); });
    });
    browser = await chromium.launch({headless:true, ...(process.env.PULSE_BROWSER_CHANNEL ? {channel:process.env.PULSE_BROWSER_CHANNEL} : {})});
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => state.autosaveReady);
    assert.equal(await page.locator('#exportButton').isDisabled(), true);
    await page.locator('#quickSearchInput').fill('Graph methods for document retrieval');
    await page.locator('#quickAddBtn').click();
    await page.waitForFunction(() => state.papers.length === 1);
    await page.locator('#quickSearchInput').fill('Graph methods for document retrieval');
    await page.locator('#quickSearchInput').press('Enter');
    assert.equal(await page.evaluate(() => state.papers.length), 1, 'Quick Add deduplicates');
    await page.locator('#quickSearchInput').fill('Document retrieval using graph learning');
    await page.locator('#quickSearchInput').press('Enter');
    await page.waitForFunction(() => state.papers.length === 2);
    assert.equal(await page.locator('#railLibraryBadge').textContent(), '2');
    assert.equal(await page.locator('#discoveryModal').isVisible(), true);
    assert.equal(await page.locator('[data-rail="collections"]').count(), 0);
    await page.locator('[data-rail="network"]').click();
    assert.equal(await page.locator('[data-rail="network"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('.pulse-col-library').isVisible(), false);
    assert.equal(await page.locator('.pulse-col-inspector').isVisible(), false);
    await page.locator('#canvasLinksSelect').selectOption('citation');
    assert.equal(await page.locator('#map .edge').count(), 0, 'Citation filter hides similarity edges');
    await page.locator('#canvasLinksSelect').selectOption('all');
    assert.ok(await page.locator('#map .edge').count() > 0);
    await page.locator('#labelModeInput').selectOption('none');
    assert.equal(await page.locator('#map .node-label').count(), 0);
    assert.equal(await page.locator('#showLabelsToggle').isChecked(), false);
    await page.locator('#showLabelsToggle').check();
    assert.equal(await page.locator('#labelModeInput').inputValue(), 'short');
    await page.locator('[data-rail="library"]').click();
    assert.equal(await page.locator('#tableView').isVisible(), true);
    assert.equal(await page.locator('[data-rail="library"]').getAttribute('aria-current'), 'page');
    await page.locator('[data-table-filter="paper"]').fill('learning');
    assert.equal(await page.locator('[data-table-paper]').count(), 1);
    await page.locator('[data-table-filter="paper"]').fill('');
    await page.locator('[data-rail="network"]').click();
    assert.equal(await page.locator('#map').isVisible(), true);
    await page.locator('#networkFullscreenButton').click();
    const fullBox = await page.locator('.pulse-workspace-cols').boundingBox();
    assert.equal(Math.round(fullBox.width), 1280);
    assert.equal(Math.round(fullBox.height), 800);
    assert.equal(await page.locator('#networkFullscreenButton').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#networkFullscreenButton').getAttribute('aria-pressed'), 'false');
    await page.locator('#graphButton').click();
    assert.equal(await page.locator('#graphPanel').isVisible(), true);
    await page.locator('#graphCloseButton').click();
    await page.locator('#blowUpButton').click();
    await page.waitForTimeout(350);
    assert.ok(await page.evaluate(() => state.graphStyle.spacing) > 1);
    await page.locator('#compressButton').click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator('#areaButton').isVisible(), false);
    await page.locator('#linkageButton').click();
    assert.equal(await page.locator('#linkagePanel').isVisible(), true);
    await page.locator('#linkageCloseButton').click();
    await page.locator('#aiButton').click();
    assert.equal(await page.locator('#aiPanel').isVisible(), true);
    await page.locator('#aiCloseButton').click();
    await page.locator('#theme-dark').click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('#theme-light').click();
    await page.locator('#settingsButton').click();
    await page.waitForTimeout(250);
    await page.locator('#aiProviderInput').selectOption('cloud');
    assert.equal(await page.locator('#cloudSettingsStep').isVisible(), true);
    assert.equal(await page.locator('#localOllamaSettingsStep').isVisible(), false);
    await page.locator('#aiProviderInput').selectOption('local');
    await page.locator('[data-settings-tab="extraction"]').click();
    await page.locator('#autoGemmaInput').uncheck();
    await page.locator('[data-settings-tab="backend"]').click();
    await page.locator('#saveSettingsButton').click();
    await page.waitForFunction(() => !els.saveSettingsButton.disabled);
    const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
    assert.equal(settings.autoGemmaExtraction, false);
    await page.locator('#settingsCloseButton').click();
    await page.route('**/api/metadata/pmid', route => route.fulfill({json:{metadata:{title:'PubMed import fixture',pmid:'12345678',authors:['A. Researcher'],year:'2024'}}}));
    await page.locator('#quickSearchInput').fill('PMID:12345678');
    await page.locator('#quickAddBtn').click();
    await page.waitForFunction(() => state.papers.some(p => p.pmid === '12345678'));
    // Remove the fixture before checking graph discovery counts.
    await page.evaluate(() => { state.papers = state.papers.filter(p => !p.pmid); render(); });
    await page.route('**/api/test', route => route.fulfill({json:{ok:false,message:'Connection unavailable'}}));
    await page.locator('#settingsButton').click();
    await page.waitForTimeout(250);
    await page.locator('#testBackendButton').click();
    await page.waitForFunction(() => els.backendStatus.textContent.includes('Connection unavailable'));
    assert.equal(await page.locator('#testBackendButton').isDisabled(), false);
    await page.locator('#settingsCloseButton').click();
    await page.route('**/api/citations/enrich', route => route.fulfill({json:{papers:[]}}));
    await page.route('**/api/citations/seminal', route => route.fulfill({json:{recommendations:[]}}));
    await page.route('**/api/recommendations', route => route.fulfill({json:{recommendations:[]}}));
    // Check discovery wiring without relying on rate-limited providers.
    const requests = [];
    await page.route('**/api/discovery/pipeline', route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({json:{recommendations:[{title:'New graph literature paper',score:85,branch:'citationGraph',subType:'Forward',reason:'Cites seed'}]}});
    });
    await page.locator('[data-rail="discover"]').click();
    assert.equal(requests.length, 0, 'Navigation does not launch a search');
    await page.locator('[data-special="seminal"]').click();
    await page.waitForFunction(() => !state.citationLoading);
    await page.locator('[data-special="recent"]').click();
    await page.waitForFunction(() => !state.discoveryLoading && state.discoveryHasRun && state.discoveryResults.length === 1);
    assert.equal(requests.at(-1).recencyTilt, 2);
    for (const depth of ['1','2','3','iterative']) {
      const before = requests.length;
      await page.locator(`[data-depth="${depth}"]`).click();
      assert.equal(requests.length, before, 'Choosing depth does not launch a search');
      await page.locator('#discoveryRunButton').click();
      await page.waitForFunction(() => !state.discoveryLoading && state.discoveryResults.length === 1);
      assert.equal(requests.at(-1).depth, depth);
    }
    await page.locator('[data-method="concepts"]').click();
    assert.equal(await page.locator('[data-method="concepts"]').getAttribute('aria-pressed'), 'false');
    await page.locator('#discoveryRunButton').click();
    await page.waitForFunction(() => !state.discoveryLoading);
    assert.equal(requests.at(-1).branches.lexicalSearch, false);
    assert.equal(await page.locator('#discoveryAddSelectedMapBtn').isDisabled(), true, 'Candidates require explicit selection');
    await page.locator('#discoverySelectAllBtn').click();
    await page.locator('#discoveryAddSelectedMapBtn').click();
    await page.waitForFunction(() => state.papers.length === 3 && state.workspaceView === 'network');
    assert.equal(await page.evaluate(() => state.explicitLinks.length), 1);
    // Discovery from a selected map node uses that node, even after another seed was pinned.
    const nodeId = await page.evaluate(() => state.papers[1].id);
    await page.locator(`#map .node[data-id="${nodeId}"]`).click();
    assert.equal(await page.locator('.pulse-col-inspector').isVisible(), true);
    await page.locator('[data-action="run-discovery-pipeline"]').click();
    await page.waitForFunction(() => !state.discoveryLoading && state.workspaceView === 'discover');
    assert.equal(requests.at(-1).seedPapers[0].id, nodeId);
    assert.equal(await page.locator('.pulse-workspace-cols').isVisible(), false);
    // Full publication dates determine same-year ordering; undated papers remain last.
    await page.evaluate(() => {
      state.papers[0].year='2020'; state.papers[0].date='2020-12-04';
      state.papers[1].year='2020'; state.papers[1].date='2020-02-01';
      state.papers[2].year=''; state.papers[2].date=''; render();
    });
    await page.locator('[data-rail="timeline"]').click();
    const ids = await page.locator('[data-timeline-id]').evaluateAll(rows => rows.map(row => row.dataset.timelineId));
    assert.deepEqual(ids, await page.evaluate(() => [state.papers[1].id, state.papers[0].id, state.papers[2].id]));
    assert.equal(await page.locator('.timeline-year').last().textContent(), 'Undated');
    await page.evaluate(() => {state.papers[0].date=''; state.papers[0].year='2018'; render();});
    assert.equal(await page.locator('[data-timeline-id]').first().getAttribute('data-timeline-id'), ids[1], 'Year-only dates sort chronologically');
    assert.equal(await page.locator('.timeline-date').first().textContent(), '2018');
    assert.equal(await page.locator('[data-rail="timeline"]').getAttribute('aria-current'), 'page');
    assert.equal(await page.locator('#map').isVisible(), false);
    await page.locator(`[data-timeline-discover="${ids[1]}"]`).click();
    assert.equal(await page.locator('#discoverySeedSelect').inputValue(), ids[1]);
    assert.equal(await page.locator('.discovery-paper-item').count(), 0, 'Changing seed clears stale candidates');
    await page.locator('#settingsButton').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settingsPanel').isVisible(), false, 'Escape closes settings in Discover');
    assert.equal(await page.locator('#discoveryModal').isVisible(), true);
    await page.locator('#discoveryRunButton').click();
    await page.waitForFunction(() => !state.discoveryLoading);
    assert.equal(requests.at(-1).seedPapers[0].id, ids[1]);
    await page.locator('[data-rail="timeline"]').click();
    await page.evaluate(() => saveLibrary());
    await page.reload();
    await page.waitForFunction(() => state.autosaveReady && state.papers.length === 3);
    assert.equal(await page.evaluate(() => state.explicitLinks.length), 1, 'Discovery evidence survives reload');
    assert.equal(await page.locator('#timelineView').isVisible(), true, 'Workspace survives reload');
    assert.equal(await page.evaluate(() => state.discoveryBranches.lexicalSearch), false);
    const exported = page.waitForEvent('download');
    await page.locator('#exportButton').click();
    const download = await exported;
    const payload = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(payload.papers.length, 3);
    assert.equal(payload.explicitLinks.length, 1);
    const csvPromise = page.waitForEvent('download');
    await page.locator('#summaryExportButton').click();
    assert.ok(fs.readFileSync(await (await csvPromise).path(), 'utf8').includes('New graph literature paper'));
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#importButton').click();
    await (await chooser).setFiles({name:'import.ris',mimeType:'text/plain',buffer:Buffer.from('TY  - JOUR\nTI  - Imported paper about indexing\nAU  - Smith, Alice\nPY  - 2024\nER  -\n')});
    await page.waitForFunction(() => state.papers.length === 4);
    await page.locator('[data-rail="network"]').click();
    const reimport = page.waitForEvent('filechooser');
    await page.locator('#importButton').click();
    await (await reimport).setFiles({name:'map.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});
    await page.waitForFunction(() => state.pendingImportLinks?.length === 0);
    assert.equal(await page.evaluate(() => state.papers.length), 4, 'Map reimport deduplicates papers');
    assert.equal(await page.evaluate(() => state.explicitLinks.length), 1, 'Map reimport deduplicates link evidence');
    for (const width of [1440,1280,1024,768]) {
      await page.setViewportSize({width,height:800});
      assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), `No page overflow at ${width}`);
      for (const id of ['quickAddBtn','importButton','graphButton','networkFullscreenButton','aiButton']) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${id} fits at ${width}`);
      }
    }
    for (const width of [1280,1024,768]) {
      await page.setViewportSize({width,height:800});
      for (const view of ['discover','timeline']) {
        await page.locator(`[data-rail="${view}"]`).click();
        assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), `${view} has no page overflow at ${width}`);
        const panel = await page.locator(view === 'discover' ? '#discoveryModal' : '#timelineView').boundingBox();
        assert.ok(panel && panel.width > width * 0.7, `${view} fills the panel`);
      }
    }
    await page.setViewportSize({width:1280,height:800});
    if (process.env.PULSE_SCREENSHOT_PATH) await page.screenshot({path:process.env.PULSE_SCREENSHOT_PATH});
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#clearButton').click();
    await page.waitForFunction(() => state.papers.length === 0);
    await page.evaluate(() => saveLibrary());
    await page.reload();
    await page.waitForFunction(() => state.autosaveReady);
    assert.equal(await page.evaluate(() => state.papers.length), 0, 'Reset remains empty after reload');
    assert.deepEqual(errors, [], 'No uncaught JavaScript errors');
    console.log('PASS: workspace navigation, fullscreen, chronological timeline, node discovery, controls, responsive layout, imports, exports, settings, persistence, reset');
  } finally {
    if (browser) await browser.close();
    backend.kill('SIGTERM');
    fs.rmSync(config,{recursive:true,force:true});
  }
})().catch(error => { console.error(error); process.exitCode=1; });
