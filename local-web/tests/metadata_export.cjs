const fs=require('fs'),vm=require('vm'),assert=require('assert');
const doc={createElement(){return {set innerHTML(text){this.value=text.replace(/&amp;/g,'&')},value:''}}};
let calls=[];
const context={document:doc,window:{},Map,Set,WeakMap,TextDecoder,Uint8Array,URLSearchParams,crypto:require('crypto').webcrypto,uid:()=>require('crypto').randomUUID(),state:{papers:[],autosaveReady:true},els:{},stopwords:new Set(),backendUrl:p=>p,apiHeaders:h=>h,render(){},showToast(){},fetch:async(url,options)=>{
 const payload=JSON.parse(options.body);calls.push(payload);
 return {ok:true,json:async()=>({matched:true,strategy:'doi',source:'Crossref',metadata:{title:'Synthetic transport study',doi:'10.1234/test',doiVerified:true,authors:['Ada Brooks','Sam Rivera'],year:'2025',date:'2025-06-05',journal:'Transport Review',volume:'10',issue:'2',pages:'20-29',publisher:'Test Press',issn:'1234-5678',url:'https://example.org/paper',language:'en',keywords:'network; transport'}})};
}};
vm.createContext(context);for(const n of ['05','06','07','08','13'])vm.runInContext(fs.readFileSync(`pulse-frontend/js/part_${n}.js`,'utf8'),context);
const records=fs.readFileSync('pulse-frontend/js/part_23.js','utf8');vm.runInContext(records.slice(records.indexOf('function recordRis('),records.indexOf("document.getElementById('relationClose')")),context);
(async()=>{
 const paper=context.normalizeImportedPaper({title:'Synthetic transport study',doi:'10.1234/test',doiVerified:true},'test');context.state.papers=[paper];
 await context.enrichLibraryAutomatically();assert.equal(calls.length,1,'Previously verified DOI still needs metadata completion');
 assert.equal(paper.pages,'20-29');assert.equal(paper.publisher,'Test Press');assert.equal(paper.authors.length,2);
 assert(paper.metadataCheckedAt);assert(paper.paperKeywords.includes('network'));
 await context.preparePaperExport([paper]);assert.equal(calls.length,1,'Fresh verified metadata is reused for export');
 const output=context.recordRis([paper]);for(const field of ['VL  - 10','IS  - 2','SP  - 20','EP  - 29','PB  - Test Press','SN  - 1234-5678','DA  - 2025-06-05','UR  - https://example.org/paper'])assert(output.includes(field),field);
 paper.journal='My local correction';await context.resolvePaperMetadata(paper,{force:true});await context.resolvePaperMetadata(paper,{force:true});assert.equal(paper.journal,'My local correction','Edits remain protected on repeated refreshes');
 const selected={...paper,id:'chosen'},untouched={...paper,id:'other',metadataCheckedAt:'',metadataMatch:null};context.state.papers=[selected,untouched];calls=[];vm.runInContext('metadataResolutionCache.clear()',context);
 selected.metadataCheckedAt='';await context.preparePaperExport([selected]);assert.equal(calls.length,1);assert.equal(untouched.metadataCheckedAt,'');
 const originalFetch=context.fetch;let offlineCalls=0;
 context.fetch=async(...args)=>{offlineCalls++;return offlineCalls===1 ? {ok:true,json:async()=>({matched:false,metadata:{},errors:['Offline']})} : originalFetch(...args);};
 vm.runInContext('metadataResolutionCache.clear()',context);
 const retry=context.normalizeImportedPaper({title:'Synthetic transport study',doi:'10.1234/test'},'test');await context.preparePaperExport([retry]);await context.preparePaperExport([retry]);assert.equal(offlineCalls,2,'An offline lookup is retried before the next export');assert.equal(retry.volume,'10');
 console.log('PASS: automatic DOI completion, verified cache, complete RIS fields, repeated edit preservation and selected-only export enrichment.');
})().catch(e=>{console.error(e);process.exitCode=1;});
