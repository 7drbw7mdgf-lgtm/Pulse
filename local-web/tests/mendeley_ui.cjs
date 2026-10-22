const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../pulse-frontend/js/paper-metrics-records.js'),'utf8');
const selected=source.slice(source.indexOf('function managerSelectedPapers()'),source.indexOf('async function refreshManagers()'));
const elements=new Map();function element(){return {value:'selected',textContent:'',hidden:false,disabled:false,classList:{toggle(){}}};}
const managerUi={status:{mendeley:{configured:true,sharedRegistration:true,connected:false},zotero:{connected:false}},busy:false,connecting:false};
const context={document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);}},managerUi,state:{papers:[{id:'one'},{id:'two'}],selectedId:'two'}};
vm.createContext(context);vm.runInContext(selected,context);context.updateManagers();
assert.equal(elements.get('mendeleyDeveloperSettings').hidden,true);assert.equal(elements.get('mendeleyConnect').disabled,false);assert(elements.get('mendeleyConnectionNote').textContent.includes('Sign in'));
managerUi.status.mendeley.pending=true;context.updateManagers();assert.equal(elements.get('mendeleyConnect').disabled,true);
managerUi.status.mendeley.pending=false;managerUi.status.mendeley.connected=true;context.updateManagers();assert.equal(elements.get('mendeleyConnect').hidden,true);assert.equal(elements.get('mendeleySend').disabled,false);
context.state.selectedId=null;context.updateManagers();assert.equal(elements.get('mendeleySend').disabled,true);
managerUi.status.mendeley={configured:false,connected:false};context.updateManagers();assert.equal(elements.get('mendeleyConnect').disabled,true);assert.equal(elements.get('mendeleyConnect').textContent,'Connect Mendeley');assert(elements.get('mendeleyConnectionNote').textContent.includes('export'));
context.state.mendeleySyncPaused=true;context.updateManagers();assert.equal(elements.get('mendeleyAutomaticSync').checked,false);context.state.mendeleySyncPaused=false;
context.state.selectedId='two';context.updateManagers();assert.equal(elements.get('mendeleySend').disabled,false);assert.equal(elements.get('mendeleySend').textContent,'Export for Mendeley');
(async()=>{
const recordDownloads=[];context.preparePaperExport=async papers=>papers;context.downloadRecordFile=(...args)=>recordDownloads.push(args);context.recordRis=papers=>papers.map(p=>p.id).join(',');
const exporter=source.slice(source.indexOf('async function exportMendeleyCitations()'),source.indexOf("for (const provider of ['zotero','mendeley']) document.getElementById(provider+'Send')"));
vm.runInContext(exporter,context);await context.exportMendeleyCitations();assert.equal(recordDownloads[0][1],'two');assert(elements.get('managerFeedback').textContent.includes('Exported 1 citation'));
context.state.selectedId=null;await context.exportMendeleyCitations();assert.equal(recordDownloads.length,1);
const connector=source.slice(source.indexOf('async function connectMendeley()'),source.indexOf("document.getElementById('mendeleyConnect').addEventListener"));
context.document.getElementById('mendeleyClientId').focus=()=>{};context.pulseRecordsRequest=()=>{throw new Error('Unconfigured setup must not request authorization');};
vm.runInContext(connector,context);await context.connectMendeley();assert(elements.get('managerFeedback').textContent.includes('awaiting Pulse service activation'));
managerUi.status.mendeley={configured:true,connected:false,sharedRegistration:false,defaultSignInAvailable:true,pending:true};
context.updateManagers();
assert.equal(elements.get('mendeleyUsePulseSignIn').hidden,false);
assert.equal(elements.get('mendeleyRestartSignIn').hidden,false);
assert(elements.get('mendeleyConnectionMethod').textContent.includes('custom'));
const link=context.document.getElementById('mendeleyAuthorizeLink');let opened=[];
link.href='https://api.mendeley.com/oauth/authorize?client_id=obsolete';
link.removeAttribute=name=>{if(name==='href')delete link.href;};
link.click=()=>opened.push({href:link.href,target:link.target});
context.window={__TAURI__:{}};context.clearInterval=()=>{};context.setInterval=()=>1;
context.refreshManagers=async()=>{};
context.pulseRecordsRequest=async()=>({authorizationUrl:'https://api.mendeley.com/oauth/authorize?client_id=current'});
await context.connectMendeley();
assert.equal(opened.at(-1).target,'_self','Desktop sign-in avoids an asynchronously blocked new-window popup');
assert(opened.at(-1).href.includes('client_id=current'));
context.pulseRecordsRequest=async()=>{throw new Error('Could not start sign-in');};
await context.connectMendeley();assert.equal(link.hidden,true);assert.equal(link.href,undefined,'Failed restarts cannot reuse an obsolete application URL');
const recovery=source.slice(source.indexOf('async function usePulseMendeleySignIn()'),source.indexOf("document.getElementById('mendeleyUsePulseSignIn')?.addEventListener"));
vm.runInContext(recovery,context);
const calls=[];const library=JSON.stringify(context.state.papers);
context.pulseRecordsRequest=async(path,payload)=>{
  calls.push({path,payload});
  if(path.endsWith('/connect'))return {authorizationUrl:'https://api.mendeley.com/oauth/authorize?client_id=shared'};
  return {configured:true,hasClientSecret:false,authFlow:'exchange',sharedRegistration:true};
};
context.refreshManagers=async()=>{managerUi.status.mendeley={configured:true,connected:false,authFlow:'exchange',sharedRegistration:true,defaultSignInAvailable:true};};
await context.usePulseMendeleySignIn();
assert.equal(calls[0].payload.usePulseSignIn,true);
assert(opened.at(-1).href.includes('client_id=shared'));
assert.equal(context.state.syncEpoch,1);
assert.equal(JSON.stringify(context.state.papers),library,'Connection recovery does not replace local papers');
assert.equal(elements.get('mendeleyUsePulseSignIn').hidden,true);
await staleStatusCannotUndoRecovery();
console.log('PASS: shared/custom modes, pending restart, fresh authorization URLs, desktop browser handoff, custom-application recovery, stale-response protection, local data preservation and selected-only export.');

})().catch(error=>{console.error(error);process.exitCode=1;});

function deferred() {
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function flush() {for(let i=0;i<12;i++)await Promise.resolve();}
async function staleStatusCannotUndoRecovery() {
  const fields=new Map(),timers=new Map(),cleared=[],requests=[];
  const ui={status:{mendeley:{configured:true,connected:false,sharedRegistration:false,pending:true}},busy:false,connecting:false};
  let nextTimer=1,shared=false;
  const fixture={managerUi:ui,state:{papers:[{id:'kept'}],selectedId:'kept'},window:{__TAURI__:{}},
    document:{getElementById(id){if(!fields.has(id))fields.set(id,element());return fields.get(id);}},
    clearInterval:id=>{cleared.push(id);timers.delete(id);},
    setInterval:callback=>{const id=nextTimer++;timers.set(id,callback);return id;},
    pulseRecordsRequest:async(path,payload)=>{
      if(path==='/api/managers/status'){const item=deferred();requests.push(item);return item.promise;}
      if(path.endsWith('/connect'))return {authorizationUrl:'https://api.mendeley.com/oauth/authorize?client_id='+(shared?'shared':'custom')};
      if(payload?.usePulseSignIn)shared=true;
      return {configured:true,sharedRegistration:shared,authFlow:shared?'exchange':'code',defaultSignInAvailable:true};
    }
  };
  vm.createContext(fixture);
  const refresh=source.slice(source.indexOf('async function refreshManagers()'),source.indexOf('async function openManagers()'));
  const connect=source.slice(source.indexOf('async function connectMendeley()'),source.indexOf("document.getElementById('mendeleyConnect').addEventListener"));
  const recovery=source.slice(source.indexOf('async function usePulseMendeleySignIn()'),source.indexOf("document.getElementById('mendeleyUsePulseSignIn')?.addEventListener"));
  vm.runInContext(selected+'\n'+refresh+'\n'+connect+'\n'+recovery,fixture);
  const authorize=fixture.document.getElementById('mendeleyAuthorizeLink');authorize.click=()=>{};
  authorize.removeAttribute=name=>{if(name==='href')delete authorize.href;};
  const status=(isShared,pending,connected=false)=>({mendeley:{configured:true,sharedRegistration:isShared,defaultSignInAvailable:true,pending,connected}});
  const first=fixture.connectMendeley();await flush();
  requests[0].resolve(status(false,true));await first;
  const oldTimer=ui.timer,oldPoll=timers.get(oldTimer)();await flush();
  assert.equal(requests.length,2);
  const recovering=fixture.usePulseMendeleySignIn();await flush();
  assert(!timers.has(oldTimer));
  requests[2].resolve(status(true,false));await flush();
  requests[3].resolve(status(true,true));await recovering;
  const newTimer=ui.timer;
  assert.notEqual(newTimer,oldTimer);assert(timers.has(newTimer));
  requests[1].resolve(status(false,false));await oldPoll;
  assert.equal(ui.status.mendeley.sharedRegistration,true,'old custom status cannot overwrite recovered shared mode');
  assert.equal(ui.status.mendeley.pending,true,'old completed status cannot clear a fresh pending sign-in');
  assert(timers.has(newTimer),'an old poll cannot stop the new sign-in timer');
  assert(!cleared.includes(newTimer));
  assert(authorize.href.includes('client_id=shared'));
  const failedPoll=timers.get(newTimer)();await flush();
  await timers.get(newTimer)();
  assert.equal(requests.length,5,'slow status checks must not overlap and invalidate every earlier result');
  requests[4].reject(new Error('Temporary status failure'));await failedPoll;
  assert(timers.has(newTimer),'a failed refresh must keep polling rather than interpret old state as completion');
  const finished=timers.get(newTimer)();await flush();
  requests[5].resolve(status(true,false,true));await finished;
  assert(!timers.has(newTimer));assert.equal(ui.timer,null);assert.equal(authorize.hidden,true);
  assert(fields.get('managerFeedback').textContent.includes('Mendeley connected'));
  const before=fields.get('managerFeedback').textContent;
  const stale=fixture.refreshManagers(),latest=fixture.refreshManagers();await flush();
  requests[7].resolve(status(true,false,true));await latest;
  requests[6].reject(new Error('Obsolete custom-app error'));await stale;
  assert.equal(fields.get('managerFeedback').textContent,before,'stale refresh errors cannot replace current success feedback');
  const older=fixture.refreshManagers(),newer=fixture.refreshManagers();await flush();
  requests[8].resolve(status(false,true));await older;
  assert.equal(fields.get('managerRefresh').disabled,true,'an old request cannot re-enable the newest pending refresh');
  assert.equal(ui.status.mendeley.sharedRegistration,true);
  requests[9].resolve(status(true,false,true));await newer;
  assert.equal(fields.get('managerRefresh').disabled,false);
}
