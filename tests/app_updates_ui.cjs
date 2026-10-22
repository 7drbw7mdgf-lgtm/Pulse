const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pulse-updates-ui-')),root=path.resolve(__dirname,'..');
 const backend=spawn(process.env.PULSE_TEST_PYTHON||(process.platform==='win32'?'python':'python3'),['-B','local-web/pulse-backend/pulse_backend.py'],{cwd:root,env:{...process.env,PULSE_CONFIG_DIR:profile,PULSE_PORT:'0',PULSE_DISABLE_BUNDLED_OLLAMA:'1'}});
 let browser;
 try {
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Server timeout')),15000);backend.stdout.on('data',data=>{const match=String(data).match(/http:\/\/127\.0\.0\.1:\d+/);if(match){clearTimeout(timer);resolve(match[0]);}});backend.on('exit',code=>reject(Error('Backend exit '+code)));});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error('Page error:',e.message);});
  await page.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
  await page.addInitScript(()=>{
   window.updateCalls=[];window.updateFailure=false;
   const info={currentVersion:'2.1.2',availableVersion:null,ready:false,autoDownload:true,canUpdate:true,lastChecked:0};
   window.__TAURI__={core:{Channel:class {},invoke:async(command,args)=>{
    if(command==='get_backend_port')return Number(location.port);
    updateCalls.push(command);
    if(command==='pulse_update_check'){info.availableVersion='2.1.3';info.notes='A synthetic update <script>unsafe</script>';}
    if(command==='pulse_update_download'){
     args.onEvent.onmessage({phase:'downloading',downloaded:100,total:200});info.ready=true;
    }
    if(command==='pulse_update_preferences')info.autoDownload=args.autoDownload;
    if(command==='pulse_update_install'&&window.updateFailure)throw Error('Synthetic install failure');
    return {...info};
   }}};
  });
  await page.goto(url);await page.waitForFunction(()=>state.autosaveReady&&document.getElementById('pulseUpdateBanner').hidden===false).catch(async error=>{console.error(await page.evaluate(()=>({ready:state.autosaveReady,calls:window.updateCalls,status:document.getElementById('pulseUpdateStatus').textContent})));throw error;});
  assert.equal(await page.evaluate(()=>updateCalls.filter(x=>x==='pulse_update_download').length),1);
  await page.evaluate(()=>{setSettingsOpen(true);setSettingsTab('updates');});
  await page.locator('#pulseUpdateInstall').waitFor({state:'visible'});
  assert.match(await page.locator('#pulseUpdateVersion').innerText(),/2.1.2/);
  assert.match(await page.locator('#pulseUpdateStatus').innerText(),/downloaded and verified/);
  assert.equal(await page.locator('#pulseUpdateNotes script').count(),0,'Release notes are plain text');
  await page.uncheck('#pulseUpdateAuto');await page.waitForFunction(()=>updateCalls.includes('pulse_update_preferences'));
  if(process.env.PULSE_UI_SCREENSHOTS){fs.mkdirSync(process.env.PULSE_UI_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PULSE_UI_SCREENSHOTS,'Pulse-2.1.2-updates.png')});}
  await page.evaluate(()=>{window.updateFailure=true;state.papers=[normalizeImportedPaper({id:'update-check',title:'Saved before updating'},'Fixture')];});
  await page.click('#pulseUpdateInstall');await page.waitForFunction(()=>document.getElementById('pulseUpdateStatus').textContent.includes('Synthetic install failure'));
  assert.equal(await page.evaluate(()=>document.getElementById('pulseUpdateRestartOverlay').hidden),true);
  assert.equal(await page.evaluate(()=>state.pulseUpdateRestarting),false);
  const saved=await page.evaluate(async()=>{const response=await fetch(backendUrl('/api/library'),{headers:apiHeaders()});return response.json();});
  assert(saved.papers.some(p=>p.id==='update-check'),'Restart first persists library changes to the real backend');
  assert.deepEqual(errors,[]);
  console.log('PASS: real update settings, background download, safe release notes, preferences, durable save before restart and failure recovery.');
 } finally {await browser?.close();if(backend.exitCode===null){const stopped=new Promise(resolve=>backend.once('exit',resolve));backend.kill();await stopped;}fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
