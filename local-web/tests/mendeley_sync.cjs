const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync('pulse-frontend/js/mendeley-sync.js','utf8');const body=source.slice(0,source.indexOf("document.getElementById('mendeleySyncNow')"));
const fields=['title','authors','year','doi','journal','pages','volume','issue','publisher','url'];
const state={papers:[],autosaveReady:true};let pages=[],saved=0;
const context={state,managerUi:{status:{mendeley:{connected:true,automaticSync:true}}},bibliographicFields:fields,normalizeDoi:v=>v || '',paperIdentityKey:p=>p.doi ? 'doi:'+p.doi : 'title:'+p.title,normalizeImportedPaper:p=>({...p,id:p.id || 'local-'+p.remoteId}),render(){},showToast(){},updateManagers(){},saveLibrary:async()=>{saved++;return true;},pulseRecordsRequest:async(path,payload)=>path.includes('sync-page') ? pages.shift() : ({ok:true})};
vm.createContext(context);vm.runInContext(body,context);
const record={remoteId:'remote-one',title:'Synthetic transport study',doi:'10.1234/test',authors:['Ada Brooks'],year:'2025',journal:'Transport Review',pages:'20-29',paperKeywords:['transport']};
(async()=>{
 let result=context.mergeMendeleyRecords([record],'one');assert.equal(result.added,1);const paper=state.papers[0];paper.journal='My local edit';paper.paperKeywords.push('local tag');
 result=context.mergeMendeleyRecords([{...record,journal:'New remote venue',pages:'20-30',paperKeywords:['updated']}],'one');assert.equal(result.updated,1);assert.equal(paper.journal,'My local edit');assert.equal(paper.pages,'20-30');assert(paper.paperKeywords.includes('local tag'));
 context.rememberMendeleyRemovals([paper]);state.papers=[];result=context.mergeMendeleyRecords([{...record,remoteId:'different-duplicate-id'}],'one');assert.equal(result.removed,1);assert.equal(state.papers.length,0);
 result=context.mergeMendeleyRecords([record],'two');assert.equal(result.added,1,'Removal in one account does not suppress another account');
 state.papers=[];pages=[{accountId:'one',items:[record],next:'/documents?marker=next'},Promise.reject(new Error('Failed page'))];
 // Deliver the error only when the second page is requested.
 pages[1].catch(()=>{});await context.syncMendeleyLibrary(true);assert.equal(state.papers.length,0);assert.equal(saved,0);
 pages=[{accountId:'one',items:[record],next:null}];state.mendeleyIgnored=[];await context.syncMendeleyLibrary(true);assert.equal(state.papers.length,1);assert.equal(saved,1);
 state.mendeleySyncPaused=true;const before=saved;await context.syncMendeleyLibrary();assert.equal(saved,before);
 state.mendeleySyncPaused=false;state.papers=[];context.pulseRecordsRequest=async()=>{state.syncEpoch=1;return {accountId:'one',items:[record],next:null};};await context.syncMendeleyLibrary(true);assert.equal(state.papers.length,0,'A delayed page cannot resurrect a cleared workspace');
 console.log('PASS: paged atomic sync, local edit and tag preservation, account-bound removal recovery, paused clears and delayed-page cancellation.');
})().catch(e=>{console.error(e);process.exitCode=1;});
