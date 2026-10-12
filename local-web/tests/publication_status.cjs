const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../pulse-frontend/js/publication-status.js'),'utf8');
let requests=[],finish,renders=0,saves=0;
const state={papers:[],selectedId:null};
const context={state,Date,Map,Set,URL,AbortSignal,normalizeDoi:value=>/^10\.\d+\/.+/.test(value)?value:'',
  escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  backendUrl:value=>value,apiHeaders:headers=>headers,scheduleAutosave:()=>saves++,renderDetails:()=>renders++,
  fetch:async(url,options)=>{requests.push(JSON.parse(options.body));return new Promise(resolve=>{finish=metadata=>resolve({ok:true,json:async()=>({available:true,metadata})});});}};
vm.createContext(context);vm.runInContext(source,context);
(async()=>{
  const first={id:'one',doi:'10.1234/one',doiVerified:true},second={id:'two',doi:'10.1234/two',doiVerified:true};state.papers=[first,second];state.selectedId='one';
  const pending=context.checkSelectedPublication(first);await context.checkSelectedPublication(first);assert.equal(requests.length,1);
  state.selectedId='two';finish({isRetracted:true,publicationStatus:{status:'retracted',source:'Crossref'},publicationNotices:[{doi:'10.1234/notice',type:'retraction',relation:'updated-by'}]});await pending;
  assert.equal(first.isRetracted,true);assert.equal(renders,0,'A late status must not redraw over another selected paper');assert.equal(saves,1);
  const markup=context.publicationMarkup(first);assert.match(markup,/Retracted/);assert.match(markup,/10.1234%2Fnotice/);
  assert.match(context.publicationMarkup({...first,publicationStatus:{status:'no-notice-found'}}),/Retracted/,'A registry without updates cannot hide an existing retraction flag');
  assert.doesNotThrow(()=>context.publicationMarkup({publicationNotices:[null],publicationRelations:'invalid'}));
  assert(!context.publicationMarkup({publicationNotices:[{doi:'javascript:alert(1)',type:'retraction'}]}).includes('javascript:'));
  const malicious=context.publicationMarkup({publicationStatus:{status:'corrected',source:'<img onerror=bad>'},publicationNotices:[{doi:'10.1234/safe',type:'<img onerror=bad>'}]});
  assert(!malicious.includes('<img'));assert(malicious.includes('&lt;img'));
  const next=context.checkSelectedPublication(second);second.doi='10.1234/changed';finish({isRetracted:true});await next;
  assert.equal(second.isRetracted,undefined,'DOI changes invalidate an in-flight status response');
  assert.equal(requests.length,2);
  console.log('PASS: selected-only publication checks, request coalescing, stale-selection/DOI guards, notice links and safe markup.');
})().catch(error=>{console.error(error);process.exit(1);});
