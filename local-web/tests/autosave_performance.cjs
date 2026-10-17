const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const frontend = path.join(__dirname, '../pulse-frontend/js');
const source = fs.readFileSync(path.join(frontend, 'part_19.js'), 'utf8');
const saves = source.slice(source.indexOf('    function scheduleAutosave()'), source.indexOf('    async function promptClearLibrary()'));
const mutations = fs.readFileSync(path.join(frontend, 'part_24.js'), 'utf8');
const mutationSource = mutations.slice(mutations.indexOf('async function libraryMutationRequest('), mutations.indexOf('function applyRecoveredWorkspace('));
const clearSource = fs.readFileSync(path.join(frontend, 'part_20.js'), 'utf8').split('    async function addPaperFromInput')[0];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture(count = 300) {
  const state = {
    papers: Array.from({length:count}, (_, i) => ({id:`paper-${i}`, title:`Synthetic paper ${i}`, notes:''})),
    links:[], clusters:[], areas:[], vectors:new Map(), keywords:new Map(), autosaveReady:true,
    paperView:'table', selectedId:null, selectedAreaId:null, centerId:null, allowEmptySave:false,
    librarySelectedIds:new Set(), filterTags:[], mendeleyIgnored:[], mendeleySyncPaused:false
  };
  const requests = [], caches = [], statuses = [], beacons = [], timers = new Map();
  let serialized = 0, fullStringifies = 0, nextTimer = 1, localFail = false;
  const context = {
    state, AbortSignal, Blob, backendUrl:value => value, apiHeaders:value => value,
    uid:()=>'test-save-session', els:{app:{inert:false}}, showToast:()=>{},
    updateSaveStatePill:label => statuses.push(label),
    serializeMap:() => {
      serialized++;
      return {
        format:'pulse-map', version:'1.0', generatedAt:`volatile-${serialized}`,
        papers:state.papers.map(p => ({...p})), links:state.links.map(p => ({...p})), areas:state.areas,
        mendeleyIgnored:state.mendeleyIgnored, mendeleySyncPaused:state.mendeleySyncPaused
      };
    },
    JSON:{
      parse:JSON.parse,
      stringify(value, ...args) {
        if (value && typeof value === 'object' && Array.isArray(value.papers)) fullStringifies++;
        return JSON.stringify(value, ...args);
      }
    },
    localStorage:{setItem:(key, body) => {if (localFail) throw Error('Synthetic storage quota'); caches.push({key, body, payload:JSON.parse(body)});}, removeItem:()=>{}},
    fetch:(url, options) => {
      const gate = deferred();
      requests.push({url, options, payload:JSON.parse(options.body), ...gate});
      return gate.promise;
    },
    navigator:{sendBeacon:(url, body) => { beacons.push({url, body}); return true; }},
    setTimeout:(callback, delay) => { const id = nextTimer++; timers.set(id, {callback, delay}); return id; },
    clearTimeout:id => timers.delete(id),
    rememberMendeleyRemovals:papers => { state.mendeleyIgnored = papers.map(p => p.id); },
    confirmClearPapers:async()=>true, refreshLibraryRecovery:async()=>{}, renderLibraryBulkActions:()=>{}
  };
  for (const name of ['updateMetrics','render','renderPapers','renderDetails','renderAreasPanel','renderLinkages']) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext(saves + '\n' + mutationSource + '\n' + clearSource, context);
  const complete = (index, ok=true, data={ok:true,recoveryId:'test-recovery'}, status=ok?200:503) => requests[index].resolve({ok, status, json:async()=>data});
  return {context, state, requests, caches, statuses, beacons, timers, complete,
    get serialized() { return serialized; }, get fullStringifies() { return fullStringifies; },
    set localFail(value) { localFail=value; }};
}

function productionSerialization(f) {
  f.context.mergedKeywords = paper => paper.paperKeywords || [];
  f.context.extractBibliographyText = () => '';
  const begin=source.indexOf('    const libraryBibliographyCache');
  vm.runInContext(source.slice(begin,source.indexOf('    async function exportMap()',begin)),f.context);
}
function acknowledgeDelta(f,index,letter='a') {
  f.complete(index,true,{ok:true,deltaSupported:true,storageRevision:letter.repeat(32)});
}

async function rapidMutationsCoalesceAndUnchangedSkips() {
  const f = fixture(), first = f.context.saveLibrary();
  await flush();
  assert.equal(f.requests.length, 1);
  for (let i = 1; i <= 100; i++) {
    f.state.papers[0].notes = `latest-${i}`;
    assert.strictEqual(f.context.saveLibrary(), first, 'one promise represents the full coalesced batch');
  }
  assert.equal(f.serialized, 1, 'pending mutations do not repeatedly serialize 300 papers');
  assert.equal(f.state.pendingLibraryWrites.size, 1);
  assert.strictEqual(f.state.libraryWriteQueue, first);
  f.complete(0);
  await flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].payload.papers[0].notes, 'latest-100');
  assert.equal(f.requests[1].payload.papers.length, 300);
  assert(f.requests[1].payload._saveRevision > f.requests[0].payload._saveRevision);
  assert.equal(f.caches.at(-1).body, f.requests[1].options.body, 'cache and request reuse one serialized body');
  f.complete(1);
  assert.equal(await first, true);
  assert.equal(f.serialized, 2);
  assert.equal(f.fullStringifies, 0, 'paper JSON is cached and the full snapshot is assembled without re-stringifying full text');
  assert.equal(f.state.pendingLibraryWrites.size, 0);
  const revision = f.state.librarySaveRevision;
  assert.equal(await f.context.saveLibrary(), true);
  assert.equal(f.requests.length, 2, 'volatile generatedAt does not cause a write');
  assert.equal(f.caches.length, 2);
  assert.equal(f.state.librarySaveRevision, revision);
  f.context.saveLibrarySync();
  assert.equal(f.beacons.length, 0, 'unchanged confirmed snapshot does not send an unload write');
  f.state.selectedId = 'paper-2';
  const selected = f.context.saveLibrary();
  await flush();
  assert.equal(f.requests[2].payload.selectedId, 'paper-2', 'recent workspace selection changes are preserved');
  f.complete(2);
  assert.equal(await selected, true);
}

async function failedLatestSaveRetriesWithoutFalseSaved() {
  const f = fixture(3), first = f.context.saveLibrary();
  await flush();
  f.state.papers[0].notes = 'newest unsaved change';
  f.context.saveLibrary();
  f.complete(0);
  await flush();
  assert(!f.statuses.includes('Saved'), 'an older successful write cannot claim the newer batch was saved');
  f.complete(1, false);
  assert.equal(await first, false);
  assert.equal(f.statuses.at(-1), 'Saved locally');
  assert.equal(f.caches.at(-1).payload.papers[0].notes, 'newest unsaved change', 'local fallback keeps failed latest data');
  const retry = f.context.saveLibrary();
  await flush();
  assert.equal(f.requests.length, 3, 'an unchanged failed snapshot must retry');
  assert.equal(f.requests[2].payload.papers[0].notes, 'newest unsaved change');
  f.complete(2);
  assert.equal(await retry, true);
  assert.equal(f.statuses.at(-1), 'Saved');
}

async function clearWaitsForWholeBatchAndKeepsRevisionOrder() {
  const f = fixture(3), save = f.context.saveLibrary();
  await flush();
  f.state.papers[0].notes = 'latest before clear';
  f.context.saveLibrary();
  const clearing = f.context.clearAppToDefault(true);
  await flush();
  assert.equal(f.state.autosaveReady, false);
  assert.equal(f.requests.length, 1, 'clear waits for the active batch');
  f.context.saveLibrarySync();
  assert.equal(f.beacons.length, 0, 'unload cannot restore a library during clear');
  f.complete(0);
  await flush();
  assert.equal(f.requests[1].url, '/api/library');
  assert.equal(f.requests[1].payload.papers[0].notes, 'latest before clear');
  assert(!f.requests.some(item => item.url === '/api/library/change'));
  f.complete(1);
  await flush();
  assert.equal(await save, true);
  assert.equal(f.requests[2].url, '/api/library/change');
  assert.equal(f.requests[2].payload.action, 'clear');
  assert(f.requests[2].payload._saveRevision > f.requests[1].payload._saveRevision);
  f.complete(2);
  assert.equal(await clearing, true);
  assert.equal(f.state.papers.length, 0);
  assert.equal(f.state.pendingLibraryWrites.size, 0);
  const afterClear = f.context.saveLibrary();
  await flush();
  assert.equal(f.requests[3].payload.papers.length, 0, 'no older queued snapshot follows clear');
  assert(f.requests[3].payload._saveRevision > f.requests[2].payload._saveRevision);
  f.complete(3);
  assert.equal(await afterClear, true);
}

async function unloadCancelsOlderPendingSnapshotAndNeedsConfirmation() {
  const f = fixture(3), save = f.context.saveLibrary();
  await flush();
  f.state.papers[0].notes = 'intermediate pending';
  f.context.saveLibrary();
  f.state.papers[0].notes = 'final unload change';
  f.context.saveLibrarySync();
  assert.equal(f.beacons.length, 1);
  const beacon = JSON.parse(await f.beacons[0].body.text());
  assert.equal(beacon.papers[0].notes, 'final unload change');
  assert(beacon._saveRevision > f.requests[0].payload._saveRevision);
  assert.equal(f.caches.at(-1).payload.papers[0].notes, 'final unload change');
  f.complete(0);
  assert.equal(await save, false, 'an older response cannot confirm the unload snapshot');
  assert.equal(f.requests.length, 1, 'older queued snapshot is cancelled');
  assert(!f.statuses.includes('Saved'));
  const retry = f.context.saveLibrary();
  await flush();
  assert.equal(f.requests[1].payload.papers[0].notes, 'final unload change');
  assert(f.requests[1].payload._saveRevision > beacon._saveRevision);
  f.complete(1);
  assert.equal(await retry, true);
}

async function completionBoundaryDoesNotLoseNewRequest() {
  const f = fixture(3), save = f.context.saveLibrary();
  await flush();
  let boundarySave;
  f.requests[0].promise.then(() => Promise.resolve().then(() => {
    f.state.papers[0].notes = 'arrived at completion boundary';
    boundarySave = f.context.saveLibrary();
  }));
  f.complete(0);
  await flush();
  assert.equal(f.requests.length, 2, 'a request during promise cleanup is still drained');
  assert.equal(f.requests[1].payload.papers[0].notes, 'arrived at completion boundary');
  f.complete(1);
  assert.equal(await save, true);
  assert.equal(await boundarySave, true);
  assert.equal(f.state.pendingLibraryWrites.size, 0);
}

async function individualPaperWritesAndBaselineConflict() {
  const f=fixture(336);productionSerialization(f);
  for (const paper of f.state.papers) {paper.text='Synthetic scientific full text '.repeat(800);paper.paperKeywords=[];}
  const first=f.context.saveLibrary();await flush();acknowledgeDelta(f,0);assert.equal(await first,true);
  const firstBytes=Buffer.byteLength(f.requests[0].options.body);
  f.state.papers[4].notes='Only this paper changed';
  const second=f.context.saveLibrary();await flush();
  const delta=f.requests[1].payload;
  assert.equal(delta._saveMode,'paper-delta-v1');assert.equal(delta.upsertPapers.length,1);
  assert.equal(delta.upsertPapers[0].id,'paper-4');assert.equal(delta.upsertPapers[0].notes,'Only this paper changed');
  assert.equal(delta.paperOrder.length,336);assert.equal(delta._baseStorageRevision,'a'.repeat(32));
  const deltaBytes=Buffer.byteLength(f.requests[1].options.body);
  assert.ok(deltaBytes<firstBytes*.02,'Single-paper transport does not resend all full text');
  assert.equal(f.caches.at(-1).payload.papers.length,336,'Browser recovery remains self-contained');
  acknowledgeDelta(f,1,'b');assert.equal(await second,true);
  const before=f.requests.length;
  assert.equal(await f.context.saveLibrary(),true);assert.equal(f.requests.length,before,'Unchanged full text skips transport');
  f.state.papers[5].paperKeywords.push('nested array edit');
  const third=f.context.saveLibrary();await flush();
  assert.equal(f.requests[2].payload.upsertPapers[0].id,'paper-5','In-place array edits invalidate only their paper');
  f.complete(2,false,{error:'The library changed elsewhere.'},409);assert.equal(await third,false);
  assert.match(f.statuses.at(-1),/Save conflict.*saved locally/);
  assert.equal(await f.context.saveLibrary(),false);f.context.saveLibrarySync();
  assert.equal(f.requests.length,3,'Conflict cannot silently become a full overwrite');assert.equal(f.beacons.length,0,'Conflict cannot overwrite an external clear during unload');
  f.state.papers=[];f.state.allowEmptySave=true;f.context.resetLibrarySaveBaseline();
  const reloaded=f.context.saveLibrary();await flush();
  assert.equal(f.requests[3].payload._saveMode,undefined);assert.equal(f.requests[3].payload.papers.length,0);
  acknowledgeDelta(f,3,'c');assert.equal(await reloaded,true);
  console.log(JSON.stringify({papers:336,fullTextCharactersPerPaper:24000,fullRequestBytes:firstBytes,singlePaperDeltaBytes:deltaBytes,reductionPercent:+(100*(1-deltaBytes/firstBytes)).toFixed(2)}));
}

async function deltaFlushFinishesBeforeClearAndNextSaveUsesFullSnapshot() {
  const f=fixture(10);const initial=f.context.saveLibrary();await flush();acknowledgeDelta(f,0);await initial;
  f.state.papers[0].notes='Latest before clear';const save=f.context.saveLibrary();await flush();
  assert.equal(f.requests[1].payload._saveMode,'paper-delta-v1');
  const clearing=f.context.clearAppToDefault(true);await flush();assert.equal(f.requests.length,2);
  acknowledgeDelta(f,1,'b');await flush();assert.equal(await save,true);
  assert.equal(f.requests[2].url,'/api/library/change');f.complete(2);await clearing;
  const empty=f.context.saveLibrary();await flush();assert.equal(f.requests[3].payload._saveMode,undefined);
  assert.equal(f.requests[3].payload.papers.length,0);f.complete(3);await empty;
}

async function failedLocalAndRemoteSavesDoNotClaimPersistence() {
  const f=fixture(3);f.localFail=true;const save=f.context.saveLibrary();await flush();f.complete(0,false);
  assert.equal(await save,false);assert.equal(f.statuses.at(-1),'Save failed');
  f.localFail=false;const retry=f.context.saveLibrary();await flush();f.complete(1,false);
  assert.equal(await retry,false);assert.equal(f.statuses.at(-1),'Saved locally');
}

async function idleUnloadUsesSmallDeltaAndNeedsRemoteConfirmation() {
  const f=fixture(3);productionSerialization(f);
  for (const paper of f.state.papers) paper.text='Scientific full text '.repeat(1200);
  const initial=f.context.saveLibrary();await flush();acknowledgeDelta(f,0);await initial;
  f.state.papers[1].notes='Final idle edit';f.context.saveLibrarySync();
  const payload=JSON.parse(await f.beacons[0].body.text());
  assert.equal(payload._saveMode,'paper-delta-v1');assert.equal(payload.upsertPapers.length,1);
  assert.ok(f.beacons[0].body.size<65536,'Idle final delta fits the browser keepalive budget');
  assert.equal(f.statuses.at(-1),'Saved locally','Sending a beacon does not confirm a remote save');
  const resumed=f.context.saveLibrary();await flush();
  assert.equal(f.requests[1].payload._saveMode,undefined,'Resume does not rely on an unconfirmed delta baseline');
  f.complete(1);assert.equal(await resumed,true);
  f.state.papers[2].notes='Unsent final edit';f.localFail=true;f.context.navigator.sendBeacon=()=>false;
  f.context.saveLibrarySync();assert.equal(f.statuses.at(-1),'Save failed');
}

function missingBibliographyIsOnlyScannedWhenTextChanges() {
  const f=fixture(3);productionSerialization(f);let scans=0;
  f.context.extractBibliographyText=()=>{scans++;return '';};
  f.context.serializeMap();f.context.serializeMap();assert.equal(scans,3,'A known absent bibliography is cached');
  f.state.papers[1].text='Updated text';f.context.serializeMap();assert.equal(scans,4,'Only changed text is rescanned');
}

function unchangedSerializationBenchmark() {
  const {performance}=require('node:perf_hooks');const f=fixture(336);productionSerialization(f);
  for (const paper of f.state.papers) paper.text='Synthetic scientific full text '.repeat(800);
  f.context.librarySaveSnapshot();
  const before=[],after=[];
  for (let index=0;index<7;index++) {
    let start=performance.now();const payload=f.context.serializeMap();JSON.stringify(payload);JSON.stringify(payload);before.push(performance.now()-start);
    start=performance.now();f.context.librarySaveSnapshot();after.push(performance.now()-start);
  }
  before.sort((a,b)=>a-b);after.sort((a,b)=>a-b);
  console.log(JSON.stringify({benchmark:'unchanged snapshot CPU, synthetic 336-paper library, seven-run median',oldDoubleStringifyMs:+before[3].toFixed(2),cachedPaperSnapshotMs:+after[3].toFixed(2)}));
}

(async () => {
  await rapidMutationsCoalesceAndUnchangedSkips();
  await failedLatestSaveRetriesWithoutFalseSaved();
  await clearWaitsForWholeBatchAndKeepsRevisionOrder();
  await unloadCancelsOlderPendingSnapshotAndNeedsConfirmation();
  await completionBoundaryDoesNotLoseNewRequest();
  await individualPaperWritesAndBaselineConflict();
  await deltaFlushFinishesBeforeClearAndNextSaveUsesFullSnapshot();
  await failedLocalAndRemoteSavesDoNotClaimPersistence();
  await idleUnloadUsesSmallDeltaAndNeedsRemoteConfirmation();
  missingBibliographyIsOnlyScannedWhenTextChanges();
  unchangedSerializationBenchmark();
  console.log('PASS: production autosave coalescing, cached full text, changed-paper transport, conflict protection, clear/recovery/unload ordering, and truthful persistence status.');
})().catch(error => { console.error(error); process.exitCode = 1; });
