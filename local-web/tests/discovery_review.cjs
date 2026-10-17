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

// Section 2: Instant relevance re-ranking below judged row + cached 2,000-candidate bound + client/server parity
const { execFileSync } = require('child_process');
const pool = [
  { title: 'Top ranked paper A', doi: '10.1000/a', score: 82.0, matchLabel: 'Strong match', strongMatchEligible: true, scoreBreakdown: { preFeedbackScore: 0.82 }, authors: ['Jane Doe', 'Richard Roe'], journal: 'Nature Microbiology', paperKeywords: ['outer membrane vesicles', 'biofilm'], sharedConcepts: ['biofilm'], referenceIds: ['W100', 'W101'], dbef: { sharedReferenceIds: ['W100'], seedMatches: [{ seedId: 'S1', shared: 2 }] }, retrievalEvidence: [{ channel: 'citations:0:backward', subType: 'Backward Citation', seedIndices: [0] }], abstract: 'Outer membrane vesicles mediate biofilm matrix assembly in Gram-negative bacteria.' },
  { title: 'Second ranked paper B', doi: '10.1000/b', score: 78.0, matchLabel: 'Strong match', strongMatchEligible: true, scoreBreakdown: { preFeedbackScore: 0.78 }, authors: ['Alan Turing', 'Grace Hopper'], journal: 'IEEE Software', paperKeywords: ['compiler optimization', 'register allocation'], sharedConcepts: ['compiler'], referenceIds: ['W200', 'W201'], abstract: 'Register allocation and instruction scheduling in modern optimizing compilers.' },
  { title: 'Third ranked paper C (judged row)', doi: '10.1000/c', score: 74.0, matchLabel: 'Strong match', strongMatchEligible: true, scoreBreakdown: { preFeedbackScore: 0.74 }, authors: ['Carlos Gomez', 'Jane Doe'], journal: 'Journal of Bacteriology', paperKeywords: ['outer membrane vesicles', 'peptidoglycan', 'secretion'], sharedConcepts: ['outer membrane vesicles', 'secretion'], referenceIds: ['W100', 'W102'], dbef: { sharedReferenceIds: ['W100', 'W102'], seedMatches: [{ seedId: 'S1', shared: 3 }] }, retrievalEvidence: [{ channel: 'dbef', subType: 'Bibliographic Coupling', seedIndices: [0] }], abstract: 'Secretion of outer membrane vesicles and peptidoglycan remodeling during bacterial stress.' },
  { title: 'Fourth ranked paper D (unrelated)', doi: '10.1000/d', score: 70.0, matchLabel: 'Related', strongMatchEligible: false, scoreBreakdown: { preFeedbackScore: 0.70 }, authors: ['Alan Turing'], journal: 'IEEE Software', paperKeywords: ['compiler optimization', 'static analysis'], referenceIds: ['W200'], abstract: 'Static analysis and loop unrolling in optimizing compilers.' },
  { title: 'Fifth ranked paper E (matches C)', doi: '10.1000/e', score: 68.5, matchLabel: 'Related', strongMatchEligible: false, scoreBreakdown: { preFeedbackScore: 0.685 }, authors: ['Elena Vance', 'Jane Doe'], journal: 'Journal of Bacteriology', paperKeywords: ['outer membrane vesicles', 'peptidoglycan', 'secretion'], sharedConcepts: ['outer membrane vesicles', 'secretion'], referenceIds: ['W100', 'W102'], dbef: { sharedReferenceIds: ['W100', 'W102'], seedMatches: [{ seedId: 'S1', shared: 3 }] }, retrievalEvidence: [{ channel: 'dbef', subType: 'Bibliographic Coupling', seedIndices: [0] }], abstract: 'Outer membrane vesicles and peptidoglycan turnover in bacterial secretion pathways.' },
];

state.discoveryResults = pool.map((p, idx) => ({ ...p, rank: idx + 1 }));
state.discoveryJudgements = [];
state.discoverySessionJudgedKeys = new Set();
// First mark paper B as not relevant at index 1, then mark paper C as relevant at index 2
context.labelDiscoveryPaper(state.discoveryResults[1], 0);
assert.equal(state.discoveryResults[0].doi, '10.1000/a', 'Row above judged row must never move');
assert.equal(state.discoveryResults[1].doi, '10.1000/b', 'Judged row itself must never move');

const beforeAbove = state.discoveryResults.slice(0, 3).map(p => p.doi);
context.labelDiscoveryPaper(state.discoveryResults[2], 2);
const afterAbove = state.discoveryResults.slice(0, 3).map(p => p.doi);
assert.deepEqual(afterAbove, beforeAbove, 'Judged row and all rows above it must remain in exact place');
assert.equal(state.discoveryResults[3].doi, '10.1000/e', 'Matching unjudged candidate below the judged row must move up');
assert.equal(state.discoveryResults[4].doi, '10.1000/d', 'Non-matching unjudged candidate below the judged row must move down');
assert.equal(state.discoveryMovedUpNote, '1 moved up');

// Client/server parity check against Python discovery_feedback.py
const feedbackRows = [
  { grade: 0, paper: pool[1] },
  { grade: 2, paper: pool[2] }
];
const clientFull = context.rerankDiscoveryPoolWithFeedback(pool, feedbackRows, null);
const clientBelow2 = context.rerankDiscoveryPoolWithFeedback(pool, feedbackRows, 2);
const pyInput = JSON.stringify({ pool, feedback: feedbackRows });
const testPython = process.env.PULSE_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const pyOut = JSON.parse(execFileSync(testPython, [
  '-c',
  `import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '../pulse-backend'))})
from pulse_core.discovery_feedback import concept_features, contrastive_profile, rerank_pool_with_feedback
data = json.loads(sys.stdin.read())
full_recs, full_moved = rerank_pool_with_feedback(data['pool'], data['feedback'], below_index=None)
below_recs, below_moved = rerank_pool_with_feedback(data['pool'], data['feedback'], below_index=2)
prof = contrastive_profile(data['feedback'])
print(json.dumps({
  'features0': sorted(concept_features(data['pool'][0])),
  'weights': prof['weights'],
  'fullOrder': [r['doi'] for r in full_recs],
  'fullScores': [r['score'] for r in full_recs],
  'fullMoved': full_moved,
  'belowOrder': [r['doi'] for r in below_recs],
  'belowMoved': below_moved,
}))`,
], { input: pyInput, encoding: 'utf8' }));

assert.deepEqual([...context.conceptFeatures(pool[0])].sort(), pyOut.features0, 'Client and server conceptFeatures must match');
assert.deepEqual(clientFull.profile.weights, pyOut.weights, 'Client and server contrastive_profile weights must match');
assert.deepEqual(clientFull.records.map(r => r.doi), pyOut.fullOrder, 'Client and server full re-rank order must match');
assert.deepEqual(clientFull.records.map(r => r.score), pyOut.fullScores, 'Client and server re-ranked scores must match');
assert.equal(clientFull.movedUp, pyOut.fullMoved);
assert.deepEqual(clientBelow2.records.map(r => r.doi), pyOut.belowOrder, 'Client and server below-index re-rank order must match');
assert.equal(clientBelow2.movedUp, pyOut.belowMoved);

// 2,000-candidate cache correctness and a warmed median latency check.
const bigPool = Array.from({ length: 2000 }, (_, i) => ({
  title: `Candidate paper ${i} on bacterial vesicles and transport`,
  doi: `10.9999/cand.${i}`,
  score: Math.round((90 - (i * 0.04)) * 1000) / 1000,
  matchLabel: i < 100 ? 'Strong match' : i < 800 ? 'Related' : 'Worth exploring',
  strongMatchEligible: i < 100,
  scoreBreakdown: { preFeedbackScore: (90 - (i * 0.04)) / 100 },
  authors: [`Author${i % 50} Smith`, i % 7 === 0 ? 'Jane Doe' : 'Other Researcher'],
  journal: i % 5 === 0 ? 'Journal of Bacteriology' : 'General Science',
  paperKeywords: i % 3 === 0 ? ['outer membrane vesicles', 'peptidoglycan'] : ['metabolism', 'transport'],
  referenceIds: i % 4 === 0 ? ['W100', 'W102'] : [`W${300 + (i % 80)}`],
  abstract: `Study ${i} investigates ${i % 3 === 0 ? 'outer membrane vesicles and peptidoglycan secretion' : 'general cellular transport mechanisms'} in model organisms.`
}));
context.warmDiscoveryFeedbackFeatures(bigPool);
const originalConceptFeatures = context.conceptFeatures;
const candidateKeys = new Set(bigPool.map(paper => paper.doi));
let extracted = 0;
context.conceptFeatures = paper => {
  assert(!candidateKeys.has(paper.doi), 'Warmed candidate features must be reused when feedback changes');
  extracted++;
  return originalConceptFeatures(paper);
};
const bigRes = context.rerankDiscoveryPoolWithFeedback(bigPool, feedbackRows, 10);
assert.equal(extracted, feedbackRows.length, 'Only feedback papers need feature extraction');
context.conceptFeatures = originalConceptFeatures;
assert.equal(bigRes.records.length, bigPool.length);
assert.deepEqual([...bigRes.records.map(p => p.doi)].sort(), [...candidateKeys].sort(), 'Every candidate must appear exactly once');
assert.deepEqual(bigRes.records.map(p => p.rank), Array.from({length: bigPool.length}, (_, i) => i + 1));
assert.deepEqual(bigRes.records.slice(0, 11).map(r => r.doi), bigPool.slice(0, 11).map(r => r.doi), 'First 11 items (0..10) must not move');
assert(bigRes.movedUp > 0, 'Relevant candidates below the judged row should move up');
for (let i = 0; i < 3; i++) context.rerankDiscoveryPoolWithFeedback(bigPool, feedbackRows, 10);
const samples = [];
for (let i = 0; i < 7; i++) {
  const started = performance.now();
  context.rerankDiscoveryPoolWithFeedback(bigPool, feedbackRows, 10);
  samples.push(performance.now() - started);
}
const elapsed = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
// Shared-runner CPU/load varies; assert cache reuse directly and reserve the
// strict 10ms target for an explicit, separately invoked benchmark measurement.
const budgetMs = process.env.PULSE_FEEDBACK_BENCHMARK === '1' ? 10 : 100;
assert(elapsed < budgetMs, `Warmed 2,000-candidate median ${elapsed.toFixed(2)} ms exceeded ${budgetMs} ms; samples=${JSON.stringify(samples)}`);
console.log(`PASS: below-judged-row re-ranking, client/server parity, cached features, and 2,000-candidate median ${elapsed.toFixed(2)} ms.`);
