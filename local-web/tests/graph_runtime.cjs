const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Graph = require('../pulse-frontend/graph-engine.js');
const frontend = path.join(__dirname,'../pulse-frontend');
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version;
const source = name => fs.readFileSync(path.join(frontend,name),'utf8');
const json = value => JSON.parse(JSON.stringify(value));
const baseline = fs.readFileSync(path.join(__dirname,'fixtures/graph-baseline.js'),'utf8');
const scoringSource = source('js/part_08.js').split('    function tokenize(')[1].split('    const metadataResolutionCache')[0];
const scoring = 'function tokenize(' + scoringSource;
const words = new Set(['the','and','with']);
const fixture = count => Array.from({length:count},(_,index) => ({
  id:'p'+index,title:`Study ${index} topic ${index % 7}`,authors:['Ada','Baird'],year:String(2000+index%20),
  journal:'Research',abstract:'Genomic methods and graph evidence',paperKeywords:['genomic','topic'+index%7],
  text:`Study ${index} genomic measurements, evaluations and tissue samples topic${index%7}`,
  openAlexId:'W'+(100+index),referenceIds:index ? ['W'+(99+index),'W900'] : ['W900'],
  citedByIds:index%2 ? ['W999'] : [],x:100+index*3,y:150+index*2,
}));
function stateFor(papers) {
  return {papers,links:[],clusters:[],vectors:new Map(),keywords:new Map(),graphSteerKeywords:[],threshold:.05,
    graphStyle:{spacing:1},mode:'network',centerId:null,activeMapId:'one',areas:[],view:{width:800,height:600}};
}
function utilities(context) {
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`function normalizeOpenAlexId(value) { const m=String(value||'').match(/\\bW\\d+\\b/i);return m?m[0].toUpperCase():''; }
    function compactTitle(value) {const text=value.replace(/\\s+/g,' ').trim();return text.length>34?text.slice(0,31)+'...':text;}
    function dedupeList(values) {const seen=new Set();return values.filter(value=>{const key=String(value||'').trim().toLowerCase();if(!key||seen.has(key))return false;seen.add(key);return true;}).map(value=>String(value).trim());}`,context);
  return context;
}
function baselineContext(papers,threshold=.05,steer=[]) {
  const context = utilities({state:stateFor(json(papers)),stopwords:words});
  context.state.threshold = threshold; context.state.graphSteerKeywords = steer;
  vm.runInContext(baseline,context);
  return context;
}
function runtimeContext(papers,{worker=true,broken=false}={}) {
  const workers = [], timers = new Map(); let timerId = 0;
  class FakeWorker {
    constructor(url) { if (broken) throw Error('Worker blocked by host'); this.url=url;this.messages=[];this.engine=Graph.createEngine();workers.push(this); }
    postMessage(message) { this.messages.push(structuredClone(message)); }
    complete(index) {
      const message = this.messages[index];
      const data = message.action === 'analyse' ? {id:message.id,result:this.engine.analyse(message.payload)}
        : {id:message.id,positions:Graph.layout(message.payload)};
      this.onmessage({data});
    }
    terminate() { this.terminated=true; }
  }
  const context = utilities({state:stateFor(json(papers)),stopwords:new Set(words),PulseGraph:Graph,URL,
    document:{currentScript:{src:'http://127.0.0.1:9000/js/graph-runtime.js?v=test'},getElementById:()=>null},
    els:{timelineView:{hidden:true}},queueMicrotask,
    setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
    render:()=>{context.renders=(context.renders||0)+1;},activeRail:()=> 'library',
  });
  if (worker) context.Worker = FakeWorker;
  vm.runInContext(scoring,context);
  vm.runInContext(source('js/part_09.js'),context);
  vm.runInContext(source('js/graph-runtime.js'),context);
  context.workers=workers;context.timers=timers;
  return context;
}

async function main() {
  // This fixture preserves the actual desktop algorithm before the refactor,
  // including its topology evidence rules and exact floating point scoring.
  let parityCases = 0;
  for (const papers of [[],fixture(1),fixture(7),[
    {id:'a',title:'Alpha study',authors:[],text:'alpha',referenceIds:['W8'],citedByIds:['W9']},
    {id:'b',title:'Beta study',authors:[],text:'beta',referenceIds:['https://openalex.org/W8','W8'],citedByIds:['W9']},
  ]]) for (const threshold of [0,.01,.05,.5,.75,1]) for (const steer of [[],['genomic measurements']]) {
    const expected = baselineContext(papers,threshold,steer);
    expected.calculateRelatedness();
    const actual = Graph.createEngine().analyse({papers:json(papers),threshold,graphSteerKeywords:steer,stopwords:[...words]});
    assert.deepEqual(json(actual.links),json(expected.state.links));
    assert.deepEqual(json(actual.clusters),json(expected.state.clusters));
    assert.deepEqual(json(actual.keywords),json([...expected.state.keywords]));
    assert.deepEqual(json(actual.vectors),json([...expected.state.vectors].map(([id,values])=>[id,[...values]])));
    parityCases++;
  }
  const engine=Graph.createEngine(), payload={papers:fixture(8),threshold:.05,graphSteerKeywords:[],stopwords:[...words]};
  const initial=engine.analyse(payload);
  const thresholdResult=engine.analyse({...payload,threshold:.75});
  assert.equal(thresholdResult.stats.vectorBuilds,1);
  assert.equal(thresholdResult.stats.topologyBuilds,1);
  payload.papers[0].referenceIds.push('W9999');
  const topologyResult=engine.analyse(payload);
  assert.equal(topologyResult.stats.vectorBuilds,1,'Citation-only changes reuse the exact TF-IDF scores');
  assert.equal(topologyResult.stats.topologyBuilds,2);
  const stopped=engine.analyse({...payload,stopwords:[...words,'genomic']});
  assert.equal(stopped.stats.vectorBuilds,2,'Stopword changes invalidate text analysis');
  initial.links.length=0;
  assert(engine.analyse(payload).links.length>0,'Callers cannot mutate cached link evidence');

  for (const spacing of [.35,1,2,4]) for (const papers of [[],fixture(13),[
    {...fixture(1)[0],x:0,y:0,pinnedPosition:true}, {...fixture(2)[1],x:300,y:300},
    {...fixture(3)[2],x:300,y:300},
  ]]) {
    const expected=baselineContext(papers);expected.calculateRelatedness();expected.state.graphStyle.spacing=spacing;
    expected.layout(800,600);
    const before=json(papers);
    const actual=Graph.layout({papers,links:json(expected.state.links),width:800,height:600,spacing});
    assert.deepEqual(actual,json(expected.state.papers.map(({id,x,y})=>({id,x,y}))));
    assert.deepEqual(papers,before,'Pure worker layout leaves submitted papers untouched');
  }

  const sync=runtimeContext(fixture(8),{worker:false});
  sync.calculateRelatedness();sync.layout(800,600);
  const positions=json(sync.state.papers.map(p=>[p.x,p.y]));
  const builds=json(sync.state.graphPerformance);
  for(let i=0;i<20;i++) {sync.state.selectedId='p'+i%8;sync.state.papers[0].notes='note'+i;sync.calculateRelatedness();sync.layout(800,600);}
  assert.deepEqual(json(sync.state.graphPerformance),builds,'Warm selection/notes reuse analysis and settled positions');
  assert.deepEqual(json(sync.state.papers.map(p=>[p.x,p.y])),positions);
  sync.state.papers[0].paperKeywords.push('new keyword');sync.calculateRelatedness();
  assert.equal(sync.state.graphPerformance.analysisBuilds,2,'In-place keyword edits invalidate the snapshot');

  const async=runtimeContext(fixture(150));
  const promise=async.calculateRelatedness();
  assert.equal(async.state.graphAnalysisPending,true);
  const worker=async.workers[0];assert.equal(worker.url,`http://127.0.0.1:9000/graph-worker.js?v=${version}`);
  async.state.papers[0].title='intermediate';async.calculateRelatedness();
  async.state.papers[0].title='latest';async.calculateRelatedness();
  assert.equal(worker.messages.length,1,'One analysis runs while newer mutations coalesce');
  worker.complete(0);
  assert.equal(async.state.graphPerformance.analysisBuilds,0,'Stale analysis never touches current links/clusters');
  assert.equal(worker.messages.length,2);
  assert.equal(worker.messages[1].payload.papers[0].title,'latest');
  worker.complete(1);await promise;
  assert.equal(async.state.graphAnalysisPending,false);
  assert.equal(async.state.graphPerformance.analysisBuilds,1);
  assert.equal(async.state.clusters.flat().length,150,'Analysis clusters the whole library');

  async.activeMapPapers=()=>async.state.papers.slice(0,4);
  const inactive=json(async.state.papers.slice(4).map(p=>[p.x,p.y]));
  async.layout(800,600);
  assert.equal(worker.messages.length,2,'A four-paper active map does not schedule a 150-paper force layout');
  assert.deepEqual(json(async.state.papers.slice(4).map(p=>[p.x,p.y])),inactive);
  const layoutBuilds=async.state.graphPerformance.layoutBuilds;
  async.layout(800,600);assert.equal(async.state.graphPerformance.layoutBuilds,layoutBuilds);
  delete async.activeMapPapers;
  async.state.papers[0].pinnedPosition=true;async.state.papers[0].x=0;async.state.papers[0].y=0;
  async.layout(800,600);
  const layoutPromise=async.state.graphLayoutPromise;
  assert.equal(async.state.graphLayoutPending,true);
  async.state.papers[0].x=222;async.state.papers[0].y=333;async.layout(800,600);
  worker.complete(2);
  assert.equal(async.state.papers[0].x,222,'An old layout cannot roll back a manual placement');
  assert.equal(worker.messages.length,4,'Only the latest placement is submitted after the old layout finishes');
  worker.complete(3);await layoutPromise;
  assert.equal(async.state.graphLayoutPending,false);
  assert.equal(async.state.papers[0].x,222);assert.equal(async.state.papers[0].y,333);
  assert.equal(async.graphMapVisible(),true,'Opening the Library sidebar still leaves the map visible');
  async.trendsVisible=()=>true;
  const settled=json(async.state.papers.map(p=>[p.x,p.y]));async.state.graphStyle.spacing=2;async.layout(800,600);
  assert.deepEqual(json(async.state.papers.map(p=>[p.x,p.y])),settled,'Hidden Trends map performs no layout');

  const clear=runtimeContext(fixture(150));clear.calculateRelatedness();
  clear.state.papers=[];clear.calculateRelatedness();clear.workers[0].complete(0);
  assert.deepEqual(json(clear.state.links),[]);assert.deepEqual(json(clear.state.clusters),[]);
  assert.equal(clear.state.graphAnalysisPending,false,'An in-flight older library cannot resurrect cleared papers');

  const blocked=runtimeContext(fixture(150),{broken:true});await blocked.calculateRelatedness();
  assert.equal(blocked.state.graphAnalysisPending,false);
  assert.equal(blocked.state.graphPerformance.analysisBuilds,1,'Desktop Worker policy failure falls back synchronously');
  assert.equal(blocked.state.clusters.flat().length,150);

  for(const mode of ['radial','clusters']) {
    sync.state.mode=mode;sync.state.papers[0].pinnedPosition=true;sync.state.papers[0].x=0;sync.state.papers[0].y=0;
    sync.layout(800,600);assert.equal(sync.state.papers[0].x,0);assert.equal(sync.state.papers[0].y,0);
  }
  sync.state.centerId='p1';sync.layout(800,600);
  assert.equal(sync.state.papers[1].x,400);assert.equal(sync.state.papers[1].y,300);
  assert.equal(sync.state.papers[0].x,0,'Center mode leaves other pinned papers in place');

  const messages=[];
  const workerVm={PulseGraph:Graph,importScripts:file=>assert.equal(file,`graph-engine.js?v=${version}`),self:{postMessage:message=>messages.push(message)}};
  vm.createContext(workerVm);vm.runInContext(source('graph-worker.js'),workerVm);
  workerVm.self.onmessage({data:{id:7,action:'analyse',payload}});
  assert.equal(messages[0].id,7);assert(messages[0].result.links.length);
  workerVm.self.onmessage({data:{id:8,action:'unknown',payload:{}}});assert(messages[1].error);
  const html=source('index.html');
  assert(html.indexOf('src="graph-engine.js')<html.indexOf('src="js/part_08.js'));
  assert(html.indexOf('src="js/part_09.js')<html.indexOf('src="js/graph-runtime.js'));
  assert(html.indexOf('src="js/graph-runtime.js')<html.indexOf('src="js/part_10.js'));
  console.log(`PASS: ${parityCases} desktop scoring cases, exact cached layout, worker coalescing/stale rejection, active maps, pinning, hidden views and fallback`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
