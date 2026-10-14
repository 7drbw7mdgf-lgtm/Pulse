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
 // Unchanged Mendeley records are not reported as local edits after Pulse tidies metadata, and duplicate copies stay merged.
 state.papers=[];state.mendeleyIgnored=[];state.syncEpoch=0;
 const twin={...record,remoteId:'remote-twin',journal:'Transport Review (duplicate entry)'};
 result=context.mergeMendeleyRecords([record,twin],'three');assert.equal(result.added,1);assert.equal(result.duplicates,1);
 const tidy=state.papers[0];tidy.title='Synthetic Transport Study';
 for (let pass=0;pass<2;pass++) {
   result=context.mergeMendeleyRecords([record,twin],'three');
   assert.deepEqual([result.added,result.updated,result.preserved,result.duplicates],[0,0,0,1],'repeat sync is quiet');
   assert.equal(tidy.mendeleySource.id,'remote-one','the paper stays linked to its first Mendeley copy');assert.equal(tidy.journal,'Transport Review');
 }
 result=context.mergeMendeleyRecords([{...record,title:'Synthetic transport study, revised',volume:'7'},twin],'three');
 assert.equal(result.preserved,1,'a field changed in both places keeps the Pulse value');assert.equal(tidy.title,'Synthetic Transport Study');
 assert.equal(result.updated,1);assert.equal(tidy.volume,'7');
 const fixed=state.papers[0];fixed.doi='10.1234/test-corrected';
 result=context.mergeMendeleyRecords([record,twin],'three');assert.equal(result.preserved,0,'a DOI corrected in Pulse is not re-reported while Mendeley is unchanged');
 assert.equal(fixed.doi,'10.1234/test-corrected');
 // Pulse corrects the DOI of a paper that Mendeley holds twice: the second copy must not become a new paper.
 state.papers=[];state.mendeleyIgnored=[];
 const broken={...record,remoteId:'broken-a',doi:'10.1234/broken'},brokenTwin={...broken,remoteId:'broken-b'};
 result=context.mergeMendeleyRecords([broken,brokenTwin],'four');assert.equal(result.added,1);assert.equal(result.duplicates,1);
 state.papers[0].doi='10.1234/repaired';
 result=context.mergeMendeleyRecords([broken,brokenTwin],'four');
 assert.equal(state.papers.length,1,'a repaired DOI does not split Mendeley duplicates');assert.deepEqual([result.added,result.preserved,result.duplicates],[0,0,1]);
 console.log('PASS: paged atomic sync, local edit and tag preservation, account-bound removal recovery, paused clears and delayed-page cancellation, quiet repeat syncs and merged duplicates.');
})().catch(e=>{console.error(e);process.exitCode=1;});
