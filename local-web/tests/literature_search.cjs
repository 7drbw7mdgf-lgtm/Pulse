const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const notice={hidden:true,textContent:''};
const context=vm.createContext({Map,Set,URL,URLSearchParams,TextDecoder,Uint8Array,crypto:require('crypto').webcrypto,
 document:{getElementById:id=>id==='discoverySourceNotice'?notice:null,createElement:()=>({set innerHTML(value){this.value=value;},value:''})},
 window:{},state:{papers:[],discoverySelectedKeys:new Set(),discoveryExpandedAbstracts:new Set(),discoverySearchErrors:new Map()},
 els:{discoveryModal:{hidden:false,querySelectorAll:()=>[]},discoveryPaperList:{innerHTML:'',querySelectorAll:()=>[]}},stopwords:new Set(),
 uid:()=>require('crypto').randomUUID(),recommendationAlreadyOnMap:()=>false,recommendationKey:()=> 'fixture',selectedPapersForRecommendation:()=>[],showToast(){}});
for(const part of ['05','06','07','08','11','13','17','02'])vm.runInContext(fs.readFileSync(`pulse-frontend/js/part_${part}.js`,'utf8'),context);
const definitions=fs.readFileSync('pulse-frontend/js/part_01.js','utf8');vm.runInContext(definitions.slice(definitions.indexOf('    function discoveryPaperKey')),context);
context.recommendationKey=()=> 'fixture';context.selectedPapersForRecommendation=()=>[];
const item={title:'Accessible research diagrams',doi:'10.1234/diagram',authors:['Ada Brooks'],source:'Europe PMC',metadataSource:'Europe PMC',
 sourceList:['Europe PMC','CORE'],sourceIdentifiers:{'Europe PMC':'MED/123',CORE:'456'},pmcid:'PMC123',coreId:'456',europePmcId:'MED/123',
 fullTextUrl:'https://europepmc.org/articles/PMC123',fullTextLinks:[{url:'https://repository.example/diagram.pdf',format:'pdf'}],
 citationCount:0,citationCountSource:'Europe PMC',citationCountsBySource:{'Europe PMC':0},keywords:'diagrams; accessibility',
 rankingMethod:'DBEF-content',dbef:{score:12.3,sharedReferenceIds:['W12'],seedMatches:[{seedIndex:0,shared:1}]}};
const imported=context.paperFromRecommendation(item);
assert.equal(imported.fullTextUrl,item.fullTextUrl);assert.equal(imported.fullTextLinks[0].url,item.fullTextLinks[0].url);
assert.equal(imported.coreId,'456');assert.equal(imported.pmcid,'PMC123');assert.equal(imported.citedByCount,0);
assert.deepEqual([...imported.paperKeywords],['diagrams','accessibility']);assert.equal(imported.sourceIdentifiers.CORE,'456');
assert.equal(imported.discoveryMethod,'DBEF-content');assert.equal(imported.dbef.sharedReferenceIds[0],'W12');
const workspaceSource=fs.readFileSync('pulse-frontend/js/part_19.js','utf8');vm.runInContext(workspaceSource.slice(workspaceSource.indexOf('    function serializeMap'),workspaceSource.indexOf('    async function exportMap')),context);
Object.assign(context.state,{papers:[imported],areas:[],links:[],clusters:[],keywords:new Map(),graphStyle:{},view:{},discoverySearchSources:{europePmc:true,core:false,semanticScholar:true},discoveryLimit:500});
const workspace=JSON.parse(JSON.stringify(context.serializeMap())),restored=context.normalizeImportedPaper(workspace.papers[0],'Restored workspace');
assert.equal(workspace.discoveryLimit,500,'The discovery limit must survive workspace export and autosave');
assert.equal(restored.discoveryMethod,'DBEF-content');assert.equal(restored.dbef.score,12.3);
assert.equal(restored.fullTextUrl,item.fullTextUrl);assert.equal(restored.fullTextLinks.length,1);assert.equal(restored.sourceIdentifiers.CORE,'456');assert.equal(restored.pmcid,'PMC123');assert.equal(restored.coreId,'456');assert.equal(restored.citationCountsBySource['Europe PMC'],0);assert.equal(workspace.discoverySearchSources.core,false);
context.state.discoveryResults=[item];context.state.discoveryQueue='all';context.state.discoverySearchErrors.set('fixture',{core:'Search limit reached.'});
context.renderDiscoveryModal();assert.match(context.els.discoveryPaperList.innerHTML,/Full text available/);assert.match(context.els.discoveryPaperList.innerHTML,/Europe PMC/);assert.match(context.els.discoveryPaperList.innerHTML,/CORE/);assert.match(context.els.discoveryPaperList.innerHTML,/0 citations/);
assert.equal(notice.hidden,false);assert.match(notice.textContent,/Partial results.*CORE/);
context.state.discoverySearchErrors.clear();context.state.discoveryResults=[{...item,fullTextUrl:'javascript:alert(1)'}];context.renderDiscoveryModal();
assert(!context.els.discoveryPaperList.innerHTML.includes('javascript:'));assert(!context.els.discoveryPaperList.innerHTML.includes('Full text available'));assert.equal(notice.hidden,true);
console.log('PASS: provider provenance, full-text links, keywords and citation counts survive imports; partial-source failures are visible; unsafe links are omitted.');
