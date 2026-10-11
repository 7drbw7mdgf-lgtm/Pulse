const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const frontend = path.join(__dirname, '../pulse-frontend/js');
const state = {papers:[{id:'seed', title:'Synthetic starting paper'}], links:[], selectedId:'seed', view:{x:0,y:0,width:800,height:600}, discoverySelectedKeys:new Set()};
const node = () => ({textContent:'', disabled:false});
const els = {discoveryModal:{hidden:true, querySelectorAll:()=>[]}, discoveryPaperList:{innerHTML:'', querySelectorAll:()=>[]},
  discoverySelectedCount:node(), discoveryAddSelectedMapBtn:node(), discoveryAddSelectedLibraryBtn:node()};
const context = {state, els, document:{getElementById:()=>null}, stopwords:new Set(), cleanField:value=>String(value || '').trim(),
  escapeHtml:value=>String(value || '').replaceAll('&','&amp;').replaceAll('"','&quot;'), safeHref:()=>'',
  recommendationAlreadyOnMap:item=>state.papers.some(paper=>paper.title===item.title),
  paperFromRecommendation:item=>({...item, id:item.title}), render(){}, showToast(){}};
vm.createContext(context);
const definitions = fs.readFileSync(path.join(frontend,'part_01.js'),'utf8');
vm.runInContext(definitions.slice(definitions.indexOf('    function discoveryPaperKey')), context);
vm.runInContext(fs.readFileSync(path.join(frontend,'part_02.js'),'utf8'), context);
const additions = fs.readFileSync(path.join(frontend,'part_03.js'),'utf8');
vm.runInContext(additions.slice(0, additions.indexOf('    function openKeywordModal')), context);
const results = Array.from({length:50}, (_,i)=>({title:`Research fixture ${i+1}`, year:'2024', authors:['Example Author'], score:50-i}));
const key = item=>context.discoveryPaperKey(item);
context.openDiscoveryModal(results,state.papers[0]);
assert.equal(els.discoverySelectedCount.textContent,'0 selected');
assert.equal(els.discoveryAddSelectedMapBtn.textContent,'Add 0 to library and map');
assert(els.discoveryAddSelectedMapBtn.disabled && els.discoveryAddSelectedLibraryBtn.disabled);
context.setDiscoveryPaperSelected(key(results[0]),true);
context.setDiscoveryPaperSelected(key(results[3]),true);
assert.equal(els.discoveryAddSelectedMapBtn.textContent,'Add 2 to library and map');
assert.equal(els.discoveryAddSelectedLibraryBtn.textContent,'Library only (2)');
assert(!els.discoveryAddSelectedMapBtn.disabled && !els.discoveryAddSelectedLibraryBtn.disabled);
state.discoverySelectedKeys.add('stale-key'); context.updateDiscoverySelection();
assert.equal(els.discoverySelectedCount.textContent,'2 selected','Stale keys must not inflate the count');
state.discoveryFilterText='fixture 1'; context.renderDiscoveryModal();
assert.equal(els.discoverySelectedCount.textContent,'2 selected · 1 hidden by filters');
assert.equal(els.discoveryAddSelectedMapBtn.textContent,'Add 2 to library and map','Filters do not silently discard chosen papers');
context.setDiscoveryPaperSelected(key(results[0]),false);
assert.equal(els.discoveryAddSelectedMapBtn.textContent,'Add 1 to library and map');
context.addSelectedDiscoveredToMap();
assert.deepEqual(state.papers.map(paper=>paper.title),['Synthetic starting paper','Research fixture 4']);
assert.equal(state.links.length,1); assert(els.discoveryModal.hidden);
context.openDiscoveryModal(results,state.papers[0]);
assert.equal(context.selectedDiscoveryPapers().length,0,'Reopening results must start with no papers chosen');
context.addSelectedDiscoveredToLibrary(); assert.equal(state.papers.length,2);
context.openDiscoveryModal([results[1], {...results[1]}, results[2]],state.papers[0]);
context.setDiscoveryPaperSelected(key(results[1]),true);
assert.equal(els.discoveryAddSelectedLibraryBtn.textContent,'Library only (1)');
context.addSelectedDiscoveredToLibrary();
assert.equal(state.papers.length,3); assert.equal(state.papers[2].title,'Research fixture 2');
assert.equal(state.links.length,1,'Library additions must not create map links');
console.log('PASS: explicit selection, live counts and zero-state buttons, filtered selections, stale/duplicate keys, and additions use the same chosen papers.');
