const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const frontend=path.join(__dirname,'../pulse-frontend/js');
const handlers={},nodes={};for(const id of ['discoveryFullTextOnly','discoveryResetFilters','discoveryExportLabels','discoveryFilterText','discoveryFilterAuthor','discoveryFilterYear'])nodes[id]={value:'',checked:false,addEventListener:(type,fn)=>handlers[id]=fn};
const paper={title:'Synthetic safer cycling study',doi:'10.1234/one',rank:1,abstract:'Bicycle lanes improve safety'};
let saved=0,rendered=0,delegated;
const state={discoveryResearchQuestion:'Safer cycling',discoveryResults:[paper],discoveryJudgements:[],discoverySeed:{title:'Transport design'},discoveryRunContext:{researchQuestion:'Safer cycling',seedPapers:[{title:'Transport design'}]}};
const context={state,els:{discoveryPaperList:{addEventListener:(type,fn)=>delegated=fn}},document:{getElementById:id=>nodes[id]},discoveryConfiguration:()=>({researchQuestion:'Safer cycling'}),citationPaperPayload:p=>p,discoveryPaperKey:p=>p.doi||p.title,scheduleAutosave:()=>saved++,renderDiscoveryModal:()=>rendered++};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(frontend,'discovery-review.js'),'utf8'),context);context.initDiscoveryReview();
delegated({target:{closest:()=>({dataset:{relevanceGrade:'2',paperKey:paper.doi}})},stopPropagation(){}});
assert.equal(context.discoveryRating(paper),2);assert.equal(state.discoveryJudgements.length,1);assert.equal(saved,1);
context.labelDiscoveryPaper(paper,0);assert.equal(state.discoveryJudgements.length,1);assert.equal(context.discoveryRating(paper),0);
state.discoveryRunContext={researchQuestion:'Transit frequency',seedPapers:[]};assert.equal(context.discoveryRating(paper),undefined,'Labels belong to their research context');
handlers.discoveryFullTextOnly({currentTarget:{checked:true}});assert(state.discoveryFullTextOnly);
state.discoveryFilterText='cycling';state.discoveryFilterBranch='concepts';state.discoveryWhyKinds=new Set(['authors']);state.discoveryHiddenStrengths=new Set(['related']);handlers.discoveryResetFilters();assert.equal(state.discoveryFilterText,'');assert.equal(state.discoveryFilterBranch,'all');assert(!state.discoveryFullTextOnly);assert.equal(state.discoveryWhyKinds.size,0,'Reset must clear the reason filters');assert.equal(state.discoveryHiddenStrengths.size,0,'Reset must restore every match strength');
assert(!fs.readFileSync(path.join(frontend,'part_02.js'),'utf8').includes('class="discovery-relevance-review" onclick='),'Nested handlers must not prevent delegated relevance clicks');
console.log('PASS: delegated relevance labels, replacement grades, context isolation, autosave, full-text control and filter reset.');

const payloadSource=fs.readFileSync(path.join(frontend,'part_17.js'),'utf8');vm.runInContext(payloadSource.slice(payloadSource.indexOf('    function citationPaperPayload'),payloadSource.indexOf('    function applyCitationMetadata')),context);
const payload=context.citationPaperPayload({...paper,authors:['Ada Brooks'],year:'2024',journal:'Synthetic journal',pmid:'123'});
assert.equal(payload.abstract,paper.abstract);assert.equal(payload.year,'2024');assert.equal(payload.pmid,'123');assert.deepEqual([...payload.authors],['Ada Brooks']);assert.equal(payload.journal,'Synthetic journal');

// Search feedback follows stable seed identities and the current question.
state.discoveryRunContext={researchQuestion:'Safer cycling',seedPapers:[{title:'Transport design'}]};
let steering=context.discoveryFeedbackPayload([{title:'Transport design',abstract:'Newly enriched metadata'}],{researchQuestion:'Safer cycling'});
assert.equal(steering.relevanceFeedback.length,1);assert.equal(steering.relevanceFeedback[0].grade,0);
assert.equal(context.discoveryFeedbackPayload([{title:'Different seed'}],{researchQuestion:'Safer cycling'}).relevanceFeedback.length,0);
assert.equal(context.discoveryFeedbackPayload([{title:'Transport design'}],{researchQuestion:'Train frequency'}).relevanceFeedback.length,0);
state.discoveryRunContext.seedPapers[0].abstract='Metadata added later';assert.equal(context.discoveryRating(paper),0,'Metadata enrichment must not lose existing judgements');
assert(fs.readFileSync(path.join(frontend,'part_18.js'),'utf8').includes('discoveryFeedbackPayload(seeds,options)'),'Search requests must include scoped feedback');
console.log('PASS: question-scoped feedback payload, stable context after metadata enrichment and request wiring.');
