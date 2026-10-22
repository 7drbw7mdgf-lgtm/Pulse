const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const base=path.join(__dirname,'../pulse-frontend');
const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
assert(/<input[^>]*id="semanticScholarKeyInput"[^>]*type="password"[^>]*autocomplete="off"/.test(html));
assert(html.includes('id="clearSemanticScholarKeyButton"'));
assert(html.includes('https://www.semanticscholar.org/product/api#api-key-form'));
const statusSource=fs.readFileSync(path.join(base,'js/filters-and-backend.js'),'utf8');
const status=statusSource.slice(statusSource.indexOf('    function renderBackendStatus('),statusSource.indexOf('    function populateOllamaModels('));
const saveSource=fs.readFileSync(path.join(base,'js/backend-settings-ai.js'),'utf8');
const save=saveSource.slice(saveSource.indexOf('    async function saveBackendSettings('),saveSource.indexOf('    async function testBackend('));
const events=fs.readFileSync(path.join(base,'js/app-bindings.js'),'utf8').split('\n').filter(line=>line.includes("els.clearSemanticScholarKeyButton?.addEventListener('click'")).join('\n');
const elements=new Map(),calls=[],toasts=[];
function element(id){if(!elements.has(id))elements.set(id,{value:'',placeholder:'',textContent:'',disabled:false,checked:true,
  classList:{add(){},remove(){}},handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}});return elements.get(id);}
const els=new Proxy({}, {get:(_,key)=>element(String(key))});
let configured={configured:false,saved:false,source:''},failure=false;
const publicSettings=()=>({aiProvider:'local',defaults:{},providers:{semanticScholar:configured}});
const context={els,state:{},apiBase:'',window:{location:{origin:'http://127.0.0.1:8000'}},
  document:{getElementById:element},populateOllamaModels:()=>{},backendUrl:value=>value,apiHeaders:value=>value,
  showToast:value=>toasts.push(value),fetch:async(url,options)=>{
    calls.push({url,payload:JSON.parse(options.body)});
    return {ok:!failure,json:async()=>failure?{error:'Synthetic save failure'}:publicSettings()};
  }
};
vm.createContext(context);vm.runInContext(status+'\n'+save+'\n'+events,context);
(async()=>{
  context.renderBackendStatus(publicSettings());
  assert.equal(els.semanticScholarKeyInput.placeholder,'Optional');
  assert.equal(els.clearSemanticScholarKeyButton.disabled,true);
  assert(element('semanticScholarKeyStatus').textContent.includes('Public search'));
  els.semanticScholarKeyInput.value='  fixture-private-semantic-key  ';
  configured={configured:true,saved:true,source:'saved',preview:'MUST-NOT-BE-RENDERED'};
  await context.saveBackendSettings();
  assert.equal(calls[0].url,'/api/settings');
  assert.equal(calls[0].payload.semanticScholarApiKey,'fixture-private-semantic-key');
  assert.equal(calls[0].payload.clearSemanticScholarApiKey,false);
  assert.equal(els.semanticScholarKeyInput.value,'','successful save clears the password field');
  assert.equal(els.clearSemanticScholarKeyButton.disabled,false);
  assert(element('semanticScholarKeyStatus').textContent.includes('Key saved'));
  assert(!els.backendDiagnostics.textContent.includes('MUST-NOT-BE-RENDERED'));
  assert(!els.backendDiagnostics.textContent.includes('fixture-private-semantic-key'));
  await context.saveBackendSettings();
  assert.equal(calls[1].payload.semanticScholarApiKey,'','saving other settings sends no replacement key');
  assert.equal(calls[1].payload.clearSemanticScholarApiKey,false,'blank fields do not clear a saved key');
  configured={configured:false,saved:false,source:''};
  await els.clearSemanticScholarKeyButton.handlers.click();
  assert.equal(calls[2].payload.clearSemanticScholarApiKey,true);
  assert.equal(els.clearSemanticScholarKeyButton.disabled,true,'clear stays disabled when no local key remains');
  assert(element('semanticScholarKeyStatus').textContent.includes('Public search'));
  configured={configured:true,saved:false,source:'environment'};
  context.renderBackendStatus(publicSettings());
  assert(element('semanticScholarKeyStatus').textContent.includes('supplied by this computer'));
  assert.equal(els.clearSemanticScholarKeyButton.disabled,true,'a computer-provided key cannot be removed as a saved key');
  configured={configured:true,saved:true,source:'environment'};
  context.renderBackendStatus(publicSettings());
  assert.equal(els.clearSemanticScholarKeyButton.disabled,false,'a shadowed local key can still be removed');
  assert(element('semanticScholarKeyStatus').textContent.includes('takes priority'));
  failure=true;els.semanticScholarKeyInput.value='fixture-key-to-retry';
  await context.saveBackendSettings();
  assert.equal(els.semanticScholarKeyInput.value,'fixture-key-to-retry','a failed save preserves the entered key for retry');
  assert.equal(els.clearSemanticScholarKeyButton.disabled,false,'failed save keeps previous saved-key state');
  assert(els.backendStatus.textContent.includes('Synthetic save failure'));
  console.log('PASS: Semantic Scholar Settings saves and clears keys, retains blank-field settings, explains computer precedence, and never renders key previews.');
})().catch(error=>{console.error(error);process.exitCode=1;});
