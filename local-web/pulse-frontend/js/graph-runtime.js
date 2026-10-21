/* Background desktop graph work. Selection and presentation do not invalidate analysis. */
const graphPaperSnapshots = new WeakMap();
const graphScalarFields = ['id','title','year','journal','abstract','text','openAlexId','openAlexUrl'];
const graphArrayFields = ['authors','paperKeywords','referenceIds','citedByIds'];
const graphFallbackEngine = PulseGraph.createEngine();
const graphWorkerScript = typeof document !== 'undefined' && document.currentScript?.src
  ? new URL('../graph-worker.js?v=2.1.3',document.currentScript.src).href : 'graph-worker.js';
let graphWorker = null, graphWorkerDisabled = false, graphRequestId = 0;
let graphAnalysisJob = null, graphAnalysisDesired = null, graphAnalysisReady = null;
let graphLayoutJob = null, graphLayoutDesired = null, graphAnalysisResolve = null;
let graphLayoutResolve = null;
state.graphAnalysisRevision = state.graphAnalysisRevision || 0;
state.graphAnalysisPending = false;
state.graphAnalysisPromise = Promise.resolve(false);
state.graphLayoutPending = false;
state.graphLayoutPromise = Promise.resolve(false);
state.graphPerformance = {analysisBuilds:0,layoutBuilds:0,workerJobs:0,staleResults:0};

function graphSameValues(left,right) {
  return Boolean(left && right && left.length === right.length && left.every((value,index) => Object.is(value,right[index])));
}
function graphPaperSnapshot(paper) {
  const previous = graphPaperSnapshots.get(paper);
  const scalars = graphScalarFields.map(field => paper[field]);
  const arrays = graphArrayFields.map(field => Array.isArray(paper[field]) ? paper[field] : []);
  if (previous && graphSameValues(previous.scalars,scalars) && arrays.every((values,index) => graphSameValues(previous.arrays[index],values))) return previous.payload;
  const copiedArrays = arrays.map(values => values.slice());
  const payload = Object.fromEntries(graphScalarFields.map((field,index) => [field,scalars[index]]));
  graphArrayFields.forEach((field,index) => { payload[field] = copiedArrays[index]; });
  graphPaperSnapshots.set(paper,{scalars,arrays:copiedArrays,payload});
  return payload;
}
function graphAnalysisRequest() {
  const papers = state.papers.map(graphPaperSnapshot);
  const graphSteerKeywords = (state.graphSteerKeywords || []).slice();
  const words = typeof stopwords !== 'undefined' ? [...stopwords] : [];
  return {inputs:[state.threshold,JSON.stringify([graphSteerKeywords,words]),...papers],
    payload:{papers,threshold:state.threshold,graphSteerKeywords,stopwords:words}};
}
function graphWorkerAllowed() {
  return !graphWorkerDisabled && typeof Worker === 'function' && state.papers.length >= 120;
}
function graphMapVisible() {
  if (state.libraryFullscreen || state.mode === 'table') return false;
  if (typeof trendsVisible === 'function' && trendsVisible()) return false;
  if (typeof els !== 'undefined' && els.timelineView && !els.timelineView.hidden) return false;
  return true;
}
function graphComputationStatus() {
  const element = typeof document !== 'undefined' && document.getElementById('graphComputeStatus');
  if (!element) return;
  const pending = state.graphAnalysisPending || Boolean(graphLayoutJob);
  element.hidden = !pending;
  element.textContent = pending ? 'Updating map… You can keep using your library.' : '';
}
function graphFinishAnalysisPromise(value) {
  state.graphAnalysisPending = false;
  if (graphAnalysisResolve) graphAnalysisResolve(value);
  graphAnalysisResolve = null;
  graphComputationStatus();
}
function graphFinishLayoutPromise(value = false) {
  state.graphLayoutPending = false;
  if (graphLayoutResolve) graphLayoutResolve(value);
  graphLayoutResolve = null;
  graphComputationStatus();
}
function graphBeginAnalysisPromise() {
  state.graphAnalysisPending = true;
  if (!graphAnalysisResolve) state.graphAnalysisPromise = new Promise(resolve => { graphAnalysisResolve = resolve; });
  graphComputationStatus();
}
function graphAcceptAnalysis(request,result) {
  state.links = result.links;
  state.clusters = result.clusters;
  state.vectors = new Map(result.vectors.map(([id,values]) => [id,new Map(values)]));
  state.keywords = new Map(result.keywords);
  relatednessRevision += 1;
  state.graphAnalysisRevision = relatednessRevision;
  state.graphPerformance.analysisBuilds += 1;
  state.graphEngineStats = result.stats;
  graphAnalysisReady = request.inputs;
  graphFinishAnalysisPromise(true);
  if (typeof renderTrends === 'function' && typeof trendsVisible === 'function' && trendsVisible()) {
    queueMicrotask(() => { if (trendsVisible()) renderTrends({refresh:true}); });
  }
}
function graphDisableWorker(refresh = true) {
  graphWorkerDisabled = true;
  if (graphWorker) graphWorker.terminate();
  graphWorker = null;
  if (graphAnalysisJob) clearTimeout(graphAnalysisJob.timer);
  if (graphLayoutJob) clearTimeout(graphLayoutJob.timer);
  graphAnalysisJob = null;
  graphLayoutJob = null;
  graphLayoutDesired = null;
  graphFinishLayoutPromise();
  const desired = graphAnalysisRequest();
  if (!graphSameValues(graphAnalysisReady,desired.inputs)) graphAcceptAnalysis(desired,graphFallbackEngine.analyse(desired.payload));
  else graphFinishAnalysisPromise(false);
  if (refresh && typeof render === 'function') render();
}
function graphGetWorker() {
  if (graphWorker) return graphWorker;
  try {
    graphWorker = new Worker(graphWorkerScript,{name:'Pulse library graph'});
    graphWorker.onmessage = graphReceiveResult;
    graphWorker.onerror = () => graphDisableWorker();
    graphWorker.onmessageerror = () => graphDisableWorker();
    return graphWorker;
  } catch { graphDisableWorker(false); return null; }
}
function graphPostJob(action,request,payload) {
  const worker = graphGetWorker();
  if (!worker) return null;
  const job = {...request,id:++graphRequestId};
  state.graphPerformance.workerJobs += 1;
  job.timer = setTimeout(() => graphDisableWorker(),15000);
  if (action === 'analyse') graphAnalysisJob = job;
  else graphLayoutJob = job;
  try { worker.postMessage({id:job.id,action,payload}); }
  catch { graphDisableWorker(false); return null; }
  return job;
}
function ensureGraphAnalysis(options = {}) {
  const request = graphAnalysisRequest();
  graphAnalysisDesired = request;
  if (graphSameValues(graphAnalysisReady,request.inputs)) {
    if (state.graphAnalysisPending) graphFinishAnalysisPromise(false);
    return state.graphAnalysisPromise;
  }
  if (!graphWorkerAllowed() || options.synchronous) {
    graphAcceptAnalysis(request,graphFallbackEngine.analyse(request.payload));
    return state.graphAnalysisPromise;
  }
  graphBeginAnalysisPromise();
  if (!graphAnalysisJob) graphPostJob('analyse',request,request.payload);
  return state.graphAnalysisPromise;
}
function prepareGraphLayout(request) {
  if (!graphWorkerAllowed() || request.papers.length < 120 || !graphMapVisible()) return {pending:false};
  graphLayoutDesired = request;
  state.graphLayoutPending = true;
  if (!graphLayoutResolve) state.graphLayoutPromise = new Promise(resolve => { graphLayoutResolve = resolve; });
  if (!graphLayoutJob) {
    graphPostJob('layout',request,{
      papers:request.papers.map(paper => ({id:paper.id,x:paper.x,y:paper.y,pinnedPosition:Boolean(paper.pinnedPosition)})),
      links:state.links,width:request.width,height:request.height,spacing:state.graphStyle.spacing || 1,
    });
  }
  graphComputationStatus();
  return {pending:Boolean(graphLayoutJob)};
}
function graphReceiveResult({data}) {
  if (graphAnalysisJob && data.id === graphAnalysisJob.id) {
    const job = graphAnalysisJob;
    clearTimeout(job.timer);
    graphAnalysisJob = null;
    if (data.error || !data.result) { graphDisableWorker(); return; }
    const current = graphAnalysisRequest();
    graphAnalysisDesired = current;
    if (!graphSameValues(job.inputs,current.inputs)) {
      state.graphPerformance.staleResults += 1;
      if (!graphSameValues(graphAnalysisReady,current.inputs)) ensureGraphAnalysis();
      else graphFinishAnalysisPromise(false);
      return;
    }
    // A smaller replacement library may already have been computed synchronously.
    if (!graphSameValues(graphAnalysisReady,current.inputs)) graphAcceptAnalysis(current,data.result);
    else graphFinishAnalysisPromise(false);
    if (typeof render === 'function') render();
    return;
  }
  if (!graphLayoutJob || data.id !== graphLayoutJob.id) return;
  const job = graphLayoutJob;
  clearTimeout(job.timer);
  graphLayoutJob = null;
  if (data.error || !Array.isArray(data.positions)) { graphDisableWorker(); return; }
  const current = graphLayoutRequest(graphLayoutDesired?.width || job.width,graphLayoutDesired?.height || job.height);
  if (!graphMapVisible() || state.graphAnalysisPending || isRecenteringAnimation || state.drag || state.areaDrag ||
      state.centerId || state.mode === 'radial' || state.mode === 'clusters') {
    graphLayoutDesired = null;
    graphFinishLayoutPromise();
    graphComputationStatus();
    return;
  }
  if (!graphSameValues(job.signature,current.signature)) {
    state.graphPerformance.staleResults += 1;
    graphLayoutDesired = current;
    prepareGraphLayout(current);
    return;
  }
  const byId = new Map(current.papers.map(paper => [paper.id,paper]));
  data.positions.forEach(position => {
    const paper = byId.get(position.id);
    if (paper && !paper.pinnedPosition && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      paper.x = position.x; paper.y = position.y;
    }
  });
  layoutRevision += 1;
  state.graphPerformance.layoutBuilds += 1;
  graphFinishLayoutPromise(true);
  rememberGraphLayout(current.width,current.height);
  graphComputationStatus();
  if (typeof render === 'function') render();
}
