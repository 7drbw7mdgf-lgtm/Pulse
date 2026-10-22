// Exercise the same modular frontend and Python entry point shipped in the DMG.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
(async () => {
  const root = path.resolve(process.env.PULSE_BENCHMARK_SOURCE || path.join(__dirname, '../..'));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-library-benchmark-'));
  const backend = spawn('python3', ['-B', 'local-web/pulse-backend/pulse_backend.py'], {
    cwd: root, env: {...process.env, PYTHONDONTWRITEBYTECODE:'1', PULSE_CONFIG_DIR:config,
      PULSE_PORT:'0', PULSE_DISABLE_BUNDLED_OLLAMA:'1'}, stdio:['ignore','pipe','pipe']
  });
  let browser;
  try {
    const url = await new Promise((resolve,reject) => {
      const timer=setTimeout(() => reject(Error('Backend startup timed out')),15000);
      backend.stdout.on('data', chunk => {const match=String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});
      backend.on('exit',code=>reject(Error('Backend exited '+code)));
    });
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:950}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===url ? route.continue() : route.abort());
    await page.goto(url);
    await page.waitForFunction(()=>typeof state!=='undefined' && state.autosaveReady);
    await page.evaluate(()=>{state.autosaveReady=false;enrichLibraryAutomatically=()=>{};warmDiscoveryForPaper=()=>{};});
    const results=[];
    for (const count of (process.env.PULSE_BENCHMARK_COUNTS || '336,1000').split(',').map(Number)) {
      const activeCount=Math.min(count,Number(process.env.PULSE_BENCHMARK_ACTIVE || 4));
      const metrics=await page.evaluate(async ({count,activeCount})=>{
        state.papers=Array.from({length:count},(_,i)=>normalizeImportedPaper({
          id:'benchmark-'+i,title:`Synthetic topic ${i%16} observation ${i}`,authors:['Example Researcher'],
          year:String(1990+i%37),selected:i<activeCount,paperKeywords:['topic'+(i%16)],
          text:Array.from({length:100},(_,word)=>`observation${i%16}section${word}`).join(' '),
          abstract:`Synthetic measurements for topic ${i%16}.`,metadataCheckedAt:new Date().toISOString()
        },'benchmark'));
        state.maps=[{id:'map-1',name:'Map 1'}];state.activeMapId='map-1';
        state.centerId=null;state.selectedId=null;state.areas=[];state.mode='network';
        const start=performance.now();render();const renderReturnMs=performance.now()-start;
        await state.graphAnalysisPromise;await state.graphLayoutPromise;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        // Worker callbacks can schedule a final render. One cache hit ensures final DOM.
        render();await state.graphLayoutPromise;
        const coldReadyMs=performance.now()-start;
        const revision=state.graphAnalysisRevision;
        const positions=state.papers.slice(0,4).map(p=>[p.x,p.y]);
        const warm=[];
        for(let i=0;i<3;i++){const tick=performance.now();render();warm.push(performance.now()-tick);}
        const selectionStart=performance.now();inspectPaper(state.papers[1].id);const selectMs=performance.now()-selectionStart;
        const data={count,renderReturnMs,coldReadyMs,warmRenderMs:warm.sort((a,b)=>a-b)[1],selectMs,
          links:state.links.length,clusters:state.clusters.length,
          libraryRows:document.querySelectorAll('#paperList [data-paper]').length,
          revisionUnchanged:revision===state.graphAnalysisRevision,
          positionsUnchanged:JSON.stringify(positions)===JSON.stringify(state.papers.slice(0,4).map(p=>[p.x,p.y])),
          activeNodes:document.querySelectorAll('#map .node').length,drawnEdges:document.querySelectorAll('#map .edge').length};
        if(typeof setTrendsVisible==='function') {
          setTrendsVisible(true);await state.graphAnalysisPromise;
          const model=trendsUi.model;
          const tick=performance.now();setTrendsVisible(false);setTrendsVisible(true);
          data.trendsReopenMs=performance.now()-tick;
          data.trendsModelReused=model===trendsUi.model;
          data.trendsPaperCards=document.querySelectorAll('[data-trends-paper]').length;
          data.trendsTotal=trendsUi.model.total;
          // Topic groups are computed once per analysis; time a cold computation.
          trendsGroupCache.key='';const groupTick=performance.now();const groups=trendsGroupData(trendsUi.model);
          data.trendsGroupsMs=performance.now()-groupTick;data.trendsGroupedPapers=groups?groups.groups.reduce((sum,group)=>sum+group.papers.length,0):0;
          setTrendsVisible(false);
        }
        return data;
      },{count,activeCount});
      assert.equal(metrics.activeNodes,activeCount,'Only papers on the active map are drawn');
      if(!process.env.PULSE_BENCHMARK_BASELINE){
        assert(metrics.revisionUnchanged,'Unchanged renders reuse relationship analysis');
        assert(metrics.positionsUnchanged,'Unchanged renders preserve settled graph positions');
        assert(metrics.libraryRows<=110,'Library DOM stays bounded');
        assert(metrics.drawnEdges<=Math.max(1800,activeCount),'Dense graph drawings stay bounded without dropping saved links');
        assert(metrics.trendsModelReused,'Trends reopening reuses its model');
        assert.equal(metrics.trendsTotal,count);
        assert(metrics.trendsPaperCards<=24);
        assert.equal(metrics.trendsGroupedPapers,count,'Every paper is in a topic group');
      }
      results.push(metrics);
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({source:root,results},null,2));
    if(process.env.PULSE_BENCHMARK_OUTPUT)fs.writeFileSync(process.env.PULSE_BENCHMARK_OUTPUT,JSON.stringify(results,null,2)+'\n');
  } finally {
    if(browser)await browser.close();backend.kill();fs.rmSync(config,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
