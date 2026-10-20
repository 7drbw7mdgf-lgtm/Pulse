const assert = require('node:assert/strict');
const PulseUpdates = require('../pulse-frontend/js/app-updates.js');
function fixture({autoDownload=true, ready=false, canUpdate=true, availableVersion='2.1.3'}={}) {
  const calls=[], renders=[], frozen=[];
  let saveResult=true, pendingSave=null, installError=null, downloadError=null, channel;
  const info={currentVersion:'2.1.2',availableVersion,autoDownload,ready,canUpdate};
  const controller=new PulseUpdates({
    invoke:async(command,args)=>{
      calls.push({command,args});
      if(command==='pulse_update_download') {
        channel=args.onEvent; channel.onmessage({phase:'downloading',downloaded:50,total:100});
        if(downloadError) throw Error(downloadError); info.ready=true;
      }
      if(command==='pulse_update_preferences') info.autoDownload=args.autoDownload;
      if(command==='pulse_update_install' && installError) throw Error(installError);
      return {...info};
    }, channel:()=>({}), save:async()=>{calls.push({command:'save'}); if(pendingSave) await pendingSave; return saveResult;},
    freeze:value=>frozen.push(value), render:view=>renders.push({...view}),
  });
  return {controller,calls,renders,frozen,info,setSave:v=>saveResult=v,setInstallError:v=>installError=v,
    setDownloadError:v=>downloadError=v,setPendingSave:v=>pendingSave=v};
}
(async()=>{
  const automatic=fixture(); await automatic.controller.init(); await automatic.controller.check();
  assert.deepEqual(automatic.calls.map(x=>x.command),['pulse_update_info','pulse_update_check','pulse_update_download']);
  assert(automatic.controller.info.ready); assert(automatic.renders.some(x=>x.progress?.downloaded===50));
  const manual=fixture({autoDownload:false}); await manual.controller.check();
  assert(!manual.calls.some(x=>x.command==='pulse_update_download')); await manual.controller.download(); assert(manual.controller.info.ready);
  const readonly=fixture({canUpdate:false}); await readonly.controller.check(); assert.equal(readonly.calls.length,1);
  const noUpdate=fixture({availableVersion:null}); await noUpdate.controller.check(); assert.equal(noUpdate.calls.length,1);
  const existing=fixture({ready:true}); await existing.controller.check(); assert.equal(existing.calls.length,1);
  const bad=fixture(); bad.setDownloadError('Invalid signature'); await bad.controller.check();
  assert.match(bad.controller.error,/Invalid signature/); assert.equal(bad.controller.busy,''); assert(!bad.controller.info.ready);
  const saveFailed=fixture({ready:true}); await saveFailed.controller.init(); saveFailed.setSave(false); await saveFailed.controller.install();
  assert(!saveFailed.calls.some(x=>x.command==='pulse_update_install')); assert.deepEqual(saveFailed.frozen,[true,false]);
  assert.match(saveFailed.controller.error,/could not be saved/);
  const ordered=fixture({ready:true}); await ordered.controller.init();
  let release; ordered.setPendingSave(new Promise(resolve=>release=resolve));
  const installing=ordered.controller.install(); await Promise.resolve();
  assert(!ordered.calls.some(x=>x.command==='pulse_update_install')); release(); await installing;
  assert.deepEqual(ordered.calls.map(x=>x.command),['pulse_update_info','save','pulse_update_install']);
  const failed=fixture({ready:true}); await failed.controller.init(); failed.setInstallError('App folder is read-only'); await failed.controller.install();
  assert.deepEqual(failed.frozen,[true,false]); assert.equal(failed.controller.busy,''); assert.match(failed.controller.error,/read-only/);
  const choice=fixture({autoDownload:false}); await choice.controller.check(); await choice.controller.preferences(true);
  assert(choice.calls.some(x=>x.command==='pulse_update_preferences' && x.args.autoDownload===true)); assert(choice.controller.info.ready);
  console.log('App updates: automatic/manual download, signatures, persisted preference, save-before-install and failure recovery passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
