const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert/strict');
const base = path.join(__dirname, '../pulse-frontend');
const source = name => fs.readFileSync(path.join(base, name), 'utf8');
const html = source('index.html');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, 'merging settings must not duplicate element IDs');
for (const id of ['graphComputeStatus', 'trendsView', 'libraryBulkColorBtn', 'mapClearAll', 'openAlexApiKeyInput', 'semanticScholarKeyInput']) assert(ids.includes(id), `${id} remains available`);

function element() {
  return {value:'', placeholder:'', textContent:'', innerHTML:'', disabled:false, hidden:false, checked:true,
    dataset:{}, handlers:{}, classes:new Set(), querySelectorAll:() => [], setAttribute(){}, focus(){this.focused=true;},
    addEventListener(name, fn){this.handlers[name]=fn;},
    classList:{add(){}, remove(){}, toggle(){}}};
}

async function settingsRegression() {
  const elements = new Map(), requests = [];
  const get = id => {if (!elements.has(id)) elements.set(id, element()); return elements.get(id);};
  const els = new Proxy({}, {get:(_, id) => get(id)});
  let configured = true, fail = false;
  const publicSettings = () => ({aiProvider:'local', defaults:{}, providers:{
    semanticScholar:{configured:false, saved:false}, openAlex:{configured, contactEmail:'fixture@example.org'}}});
  const status = source('js/part_04.js');
  const save = source('js/part_05.js');
  const context = {els, state:{}, apiBase:'', window:{location:{origin:'http://127.0.0.1:8000'}},
    document:{getElementById:get}, populateOllamaModels(){}, backendUrl:value => value, apiHeaders:value => value,
    showToast(){}, fetch:async(url, options) => {
      requests.push({url, payload:JSON.parse(options.body)});
      return {ok:!fail, json:async() => fail ? {error:'Fixture save failure'} : publicSettings()};
    }};
  vm.createContext(context);
  vm.runInContext(status.slice(status.indexOf('    function renderBackendStatus('), status.indexOf('    function populateOllamaModels(')) + '\n' +
    save.slice(save.indexOf('    async function saveBackendSettings('), save.indexOf('    async function testBackend(')) + '\n' +
    source('js/part_21.js').split('\n').filter(line => line.includes("els.clearOpenAlexKeyButton?.addEventListener('click'")).join('\n'), context);
  context.renderBackendStatus(publicSettings());
  assert.equal(els.pulseContactEmailInput.value, 'fixture@example.org');
  assert.match(els.openAlexKeyStatus.textContent, /API key saved/);
  els.openAlexApiKeyInput.value = '  fixture-openalex-key  ';
  els.pulseContactEmailInput.value = '  fixture@example.org  ';
  els.openAlexLimitBanner.hidden = false;
  await context.saveBackendSettings();
  assert.equal(requests[0].payload.openAlexApiKey, 'fixture-openalex-key');
  assert.equal(requests[0].payload.contactEmail, 'fixture@example.org');
  assert.equal(requests[0].payload.clearOpenAlexApiKey, false);
  assert.equal(els.openAlexApiKeyInput.value, '', 'a successful save clears the key field');
  assert.equal(els.openAlexLimitBanner.hidden, true);
  assert(!els.backendDiagnostics.textContent.includes('fixture-openalex-key'));
  await context.saveBackendSettings();
  assert.equal(requests[1].payload.openAlexApiKey, '');
  assert.equal(requests[1].payload.clearOpenAlexApiKey, false, 'blank fields preserve saved keys');
  configured = false;
  await els.clearOpenAlexKeyButton.handlers.click();
  assert.equal(requests[2].payload.clearOpenAlexApiKey, true);
  assert.equal(requests[2].payload.openAlexApiKey, '');
  fail = true; els.openAlexApiKeyInput.value = 'fixture-retry-key';
  await context.saveBackendSettings();
  assert.equal(els.openAlexApiKeyInput.value, 'fixture-retry-key', 'a failed save preserves input for retry');
}

function discoveryRegression() {
  const elements = new Map();
  for (const id of ['discoveryPreview', 'discoverySourceNotice', 'discoverySourceStatus', 'discoveryProgressPanel', 'discoverySearchDetailsContent', 'openAlexLimitBanner', 'openAlexLimitTime', 'openAlexApiKeyInput']) elements.set(id, element());
  const state = {papers:[], discoverySelectedKeys:new Set(), discoverySearchErrors:new Map(), discoveryRunInfo:new Map()};
  const modal = element(), actions = [];
  const context = {state, Map, Set, URL, els:{discoveryModal:modal, discoveryPaperList:element()},
    document:{getElementById:id => elements.get(id) || null}, window:{},
    cleanField:value => String(value || '').trim(), escapeHtml:value => String(value || ''),
    safeHref:value => /^https?:\/\//.test(value) ? value : '', recommendationAlreadyOnMap:() => false,
    recommendationKey:() => 'fixture', selectedPapersForRecommendation:() => [], normalizeDoi:value => String(value || ''),
    showToast(){}, setSettingsOpen:value => actions.push(['settings', value]), setSettingsTab:value => actions.push(['tab', value]),
    setTimeout:fn => fn(), cancelDiscoverySearch:() => actions.push(['stop'])};
  vm.createContext(context);
  const definitions = source('js/part_01.js');
  vm.runInContext(definitions.slice(definitions.indexOf('    function discoveryPaperKey')), context);
  vm.runInContext(source('js/part_02.js'), context);
  const a = {title:'Fixture A', doi:'10.1234/a', score:90}, b = {title:'Fixture B', doi:'10.1234/b', score:80};
  const c = {title:'Fixture C', doi:'10.1234/c', score:85};
  context.openDiscoverySearching({title:'Seed'}, 'fixture-run', {branches:{citationGraph:true}});
  context.updateDiscoverySearching({recommendations:[a,b], errors:{}, sourceCooldowns:{OpenAlex:{retryInSeconds:60}}});
  assert.equal(elements.get('openAlexLimitBanner').hidden, false);
  assert(elements.get('openAlexLimitTime').textContent.length > 0);
  context.updateDiscoverySearching({recommendations:[b,c], errors:{}});
  assert.deepEqual(Array.from(state.discoveryResults, paper => paper.doi), [b.doi,c.doi,a.doi], 'incremental updates retain previously visible papers without duplicates');
  assert.equal(elements.get('openAlexLimitBanner').hidden, true);
  context.initDiscoveryWorkspace();
  modal.handlers.click({target:{closest:() => ({dataset:{dvAction:'open-openalex-settings'}})}});
  assert.deepEqual(actions, [['settings',true],['tab','search']]);
  assert.equal(elements.get('openAlexApiKeyInput').focused, true);
  modal.handlers.click({target:{closest:() => ({dataset:{dvAction:'stop-review'}})}});
  assert.equal(state.discoveryStopReview, true, 'the newer stop-and-review action survives the merge');
  assert.deepEqual(actions.at(-1), ['stop']);
  state.discoveryUserTouchedRelevance = true;
  context.updateDiscoverySearching({recommendations:[c], errors:{}});
  assert.deepEqual(Array.from(state.discoveryResults, paper => paper.doi), [b.doi,c.doi,a.doi], 'user-reviewed order stays stable');
  assert.equal(state.discoveryPendingRefinedOrder[0], c);
}

(async() => {
  await settingsRegression();
  discoveryRegression();
  console.log('PASS: merged OpenAlex settings/cooldown, incremental results, stop-and-review and unique 1.8.9 UI elements');
})().catch(error => {console.error(error); process.exitCode=1;});
