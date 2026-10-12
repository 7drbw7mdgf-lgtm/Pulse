const fs = require('fs'), vm = require('vm'), assert = require('assert/strict'), path = require('path');
const frontend = path.join(__dirname, '../pulse-frontend/js');
const elements = new Map();
const node = () => ({innerHTML:'', textContent:'', hidden:false, dataset:{}, classes:new Set(),
  classList:{toggle(name, on){on ? this.owner.classes.add(name) : this.owner.classes.delete(name);}},
  querySelectorAll:()=>[], setAttribute(){}});
for (const id of ['discoveryPreview', 'discoverySourceNotice', 'discoverySourceStatus', 'discoveryProgressPanel', 'discoverySearchDetailsContent']) {
  const element = node(); element.classList.owner = element; elements.set(id, element);
}
const state = {papers:[], discoverySelectedKeys:new Set(), discoverySearchErrors:new Map(), discoveryRunInfo:new Map()};
const list = node();
const context = {state, Map, Set, URL, els:{discoveryModal:{hidden:false, querySelectorAll:()=>[]}, discoveryPaperList:list},
  document:{getElementById:id=>elements.get(id) || null}, window:{},
  cleanField:v=>String(v || '').trim(), escapeHtml:v=>String(v || '').replaceAll('&','&amp;').replaceAll('"','&quot;'),
  safeHref:v=>/^https?:\/\//.test(v) ? v : '', recommendationAlreadyOnMap:()=>false,
  recommendationKey:()=> 'fixture', selectedPapersForRecommendation:()=>[], normalizeDoi:v=>String(v || '').replace(/^https?:\/\/doi.org\//,''), showToast(){}};
vm.createContext(context);
const definitions = fs.readFileSync(path.join(frontend,'part_01.js'),'utf8');
vm.runInContext(definitions.slice(definitions.indexOf('    function discoveryPaperKey')), context);
vm.runInContext(fs.readFileSync(path.join(frontend,'part_02.js'),'utf8'), context);
const papers = [{title:'Indexing study A', doi:'10.1234/first', score:90, year:'2020'},
                {title:'Indexing study B', doi:'10.1234/second', score:80, year:'2025'}];
const key = item=>context.discoveryPaperKey(item);
const preview = elements.get('discoveryPreview');
const assertFocus = paper => {
  assert.equal(state.discoveryFocusKey, key(paper));
  assert.equal(preview.dataset.paperKey, key(paper));
  assert(preview.innerHTML.includes(paper.title));
  assert.equal((list.innerHTML.match(/ is-focused/g) || []).length, 1);
  assert(list.innerHTML.includes(`data-dv-focus="${key(paper)}" aria-current="true"`));
};
context.openDiscoveryModal(papers, {title:'Seed'});
context.setDiscoveryPaperSelected(key(papers[1]), true); assertFocus(papers[1]);
state.discoverySortBy='year-asc'; context.renderDiscoveryModal(); assertFocus(papers[1]);
state.discoveryFilterText='study A'; context.renderDiscoveryModal(); assertFocus(papers[0]);
state.discoveryFilterText='absent'; context.renderDiscoveryModal();
assert.equal(state.discoveryFocusKey, null); assert.equal(preview.dataset.paperKey,'');
assert(!preview.innerHTML.includes(papers[0].title));
context.openDiscoverySearching({title:'New seed'}, 'new-run', {branches:{citationGraph:true}});
assert.equal(state.discoveryFocusKey,null); assert(!preview.innerHTML.includes(papers[1].title));
state.discoveryFilterText='';
state.discoverySortBy='score';
const notice = {code:'extra-hop-limit', message:'Extra hops stopped at the limit.'};
context.updateDiscoverySearching({recommendations:papers, branchesExecuted:['citationGraph'], notices:{citationGraph:[notice]}, sourceCounts:{citationGraph:2}, errors:{}, completed:1, total:1});
assertFocus(papers[0]);
context.updateDiscoverySearching({...state.discoverySearching.job, recommendations:[{...papers[1],score:95},papers[0]]});
assertFocus(papers[1]);
context.focusDiscoveryPaper(key(papers[0]),false);
context.updateDiscoverySearching({...state.discoverySearching.job, recommendations:[{...papers[1],score:95},papers[0]]});
assertFocus(papers[0]);
assert(elements.get('discoveryProgressPanel').classes.has('is-compact'));
assert(!elements.get('discoveryProgressPanel').innerHTML.includes('dv-source-card'));
assert.equal(context.discoverySourceRows()[0].status,'ok');
state.discoverySearching=null;
state.discoveryRunInfo.set('new-run',{branchesExecuted:['citationGraph'], notices:{citationGraph:[notice]}, sourceCounts:{citationGraph:2}, errors:{}});
context.renderDiscoveryModal(); assert.equal(elements.get('discoverySourceNotice').hidden,true);
state.discoveryRunInfo.get('new-run').errors={citationGraph:'HTTP 500'};
assert.equal(context.discoverySourceRows()[0].status,'warn','Retained papers are partial results, rather than an empty failed search');
state.discoveryRunInfo.get('new-run').sourceCounts={citationGraph:0};
assert.equal(context.discoverySourceRows()[0].status,'fail','An informational notice cannot mask a real provider failure');
state.discoveryRunInfo.get('new-run').errors={citationGraph:'Additional citation hops stopped at the time budget; direct citations and collected results are retained.'};
assert.equal(context.discoverySourceRows()[0].status,'ok','Old cached hop-limit notices are also handled');
assert.equal(context.discoveryCitationText({citationCount:0,citationCountSource:'OpenAlex'}),'—');
assert.equal(context.discoveryCitationText({citationCount:0,citationCountSource:'OpenAlex',citationCountsBySource:{OpenAlex:0}}),'0 citations');
assert.equal(context.discoveryCitationText({citationCount:0,citationCountSource:'CORE',citationCountsBySource:{CORE:0}}),'—');
assert.equal(context.discoveryCitationText({citationCount:null}),'—');
assert.equal(context.discoveryCitationText({citationCount:-1}),'—');
assert.equal(context.paperOpenUrl({doi:'10.1234/paper',url:'https://example.org/other'}),'https://doi.org/10.1234/paper');
assert.equal(context.paperOpenUrl({url:'#',fullTextUrl:'https://example.org/paper.pdf'}),'https://example.org/paper.pdf');
assert.equal(context.paperOpenUrl({url:'javascript:alert(1)',s2PaperId:'record'}),'https://www.semanticscholar.org/paper/record');
assert.equal(context.paperOpenUrl({pmid:'12345'}),'https://pubmed.ncbi.nlm.nih.gov/12345/');
assert(context.discoveryPreviewMarkup(papers[0],false).includes('</a>\n<span'));
let listener, opened=[];
const linkContext = {URL, window:{location:{href:'http://127.0.0.1:8000/',origin:'http://127.0.0.1:8000',assign:url=>opened.push(url)}},
  document:{addEventListener:(_,fn)=>listener=fn}};
vm.runInNewContext(fs.readFileSync(path.join(frontend,'paper-links.js'),'utf8'),linkContext);
let prevented=false;
const click = href=>listener({defaultPrevented:false,target:{closest:()=>({href,hasAttribute:()=>false})},preventDefault(){prevented=true;}});
click('https://doi.org/10.1234/paper'); assert.deepEqual(opened,[]); assert.equal(prevented,false);
linkContext.window.__TAURI_INTERNALS__={}; click('https://doi.org/10.1234/paper');
assert.deepEqual(opened,['https://doi.org/10.1234/paper']); assert.equal(prevented,true);
click('javascript:alert(1)'); click('http://127.0.0.1:8000/'); click('https://user:secret@example.org/');
assert.equal(opened.length,1);
console.log('PASS: preview reconciliation, sorting/filtering, selected-card focus, compact progress, source notices, known counts and browser/native paper links.');
