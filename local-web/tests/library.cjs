const fs = require('fs'), vm = require('vm'), assert = require('assert');
const clearSource = fs.readFileSync('pulse-frontend/js/part_20.js','utf8').split('    async function addPaperFromInput')[0];
const promptSource = fs.readFileSync('pulse-frontend/js/part_19.js','utf8').split('    async function promptClearLibrary()')[1].split('    function confirmClearPapers')[0];
function fixture(response = {ok:true, json:async()=>({ok:true})}, confirm = true) {
 const paper={id:'test',title:'Synthetic test paper'}, calls=[];
 const state={papers:[paper],links:[{source:'test'}],areas:[{id:'area'}],clusters:[],vectors:new Map([['test',1]]),keywords:new Map([['test',['tag']]]),autosaveReady:true,filterTags:['tag']};
 const context={state,els:{},AbortSignal,confirmClearPapers:async()=>confirm,clearTimeout(){},localStorage:{removeItem(){},setItem(k,v){calls.push(['cache',JSON.parse(v)])}},
  serializeMap:()=>({papers:state.papers,areas:state.areas}), libraryMutationRequest:async(url,payload)=>{calls.push(['reset',payload]);const result=await response.json();if(!response.ok)throw new Error(result.error);return result},backendUrl:p=>p,apiHeaders:x=>x,showToast:m=>calls.push(['toast',m])};
 for(const name of ['updateMetrics','updateSaveStatePill','render','renderPapers','renderDetails','renderAreasPanel','renderLinkages','scheduleAutosave'])context[name]=()=>{};
 vm.createContext(context);vm.runInContext(clearSource+'\nasync function promptClearLibrary()'+promptSource,context);
 return {context,state,paper,calls};
}
(async()=>{
 const success=fixture();assert.equal(await success.context.clearAppToDefault(true),true);
 assert.equal(success.state.papers.length,0);assert.equal(success.state.links.length,0);assert.equal(success.state.vectors.size,0);
 assert.equal(success.state.autosaveReady,true);assert.equal(success.state.clearingLibrary,false);
 assert.equal(success.calls.find(c=>c[0]==='reset')[1].action,'clear');
 const failure=fixture({ok:false,json:async()=>({error:'Test server rejection'})});
 assert.equal(await failure.context.clearAppToDefault(true),false);assert.equal(failure.state.papers[0],failure.paper);assert.equal(failure.state.filterTags[0],'tag');
 assert.equal(failure.state.autosaveReady,true);assert(!failure.calls.some(c=>c[0]==='cache'));
 const cancelled=fixture(undefined,false);await cancelled.context.promptClearLibrary();assert.equal(cancelled.state.papers[0],cancelled.paper);assert.equal(cancelled.calls.length,0);
 const ordered=fixture();let release;ordered.state.pendingLibraryWrites=new Set([new Promise(resolve=>release=resolve)]);
 const resetting=ordered.context.clearAppToDefault(true);assert(!ordered.calls.some(c=>c[0]==='reset'));release();await resetting;
 assert(ordered.calls.some(c=>c[0]==='reset'));
 console.log('PASS: confirmed clear, cancelled clear, backend failure preserves papers, and older saves finish before reset.');
})().catch(error=>{console.error(error);process.exitCode=1});
