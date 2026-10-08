const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../pulse-frontend/js/part_22.js'),'utf8');
function element(){return {hidden:false,disabled:false,value:'',textContent:'',classList:{toggle(){},remove(){}},addEventListener(){},append(){},setAttribute(){},replaceChildren(){}};}
const ui=new Map(),requests=[],pending=[];
const papers=[{id:'one',title:'First paper',abstract:'First abstract'},{id:'two',title:'Selected paper',text:'Only this source'}];
const context={console,AbortSignal,Map,JSON,Blob,URL,setTimeout(){},clearTimeout(){},backendReady:Promise.resolve(),state:{papers,selectedId:'two'},
 els:{aiAnalyzeButton:element(),aiPrompt:element(),aiResult:element(),aiPanel:element()},
 document:{getElementById(id){if(!ui.has(id))ui.set(id,element());return ui.get(id)},createElement:element,addEventListener(){}},
 window:{location:{port:'test'}},sessionStorage:{getItem(){},setItem(){},removeItem(){}},backendUrl:p=>p,apiHeaders:x=>x,
 mergedKeywords:()=>[],setAiPanelOpen(){},setSettingsOpen(){},
 fetch:async(url,options)=>{requests.push({url,payload:options.body&&JSON.parse(options.body)});return {ok:true,json:async()=>url.endsWith('/status') ? {online:true,model:'private-model',models:['private-model']} : url.endsWith('/start') ? {id:'job',paperId:'two',status:'running',total:1,completed:0,results:[]} : {id:'job',paperId:'two',status:'complete',total:1,completed:1,results:[{id:'two',title:'Selected paper',source:'Paper text',summary:'Second report'}]}};}};
vm.createContext(context);vm.runInContext(source,context);
(async()=>{
 await context.refreshPaperAgent();await context.startPaperScan();await new Promise(r=>setImmediate(r));
 const start=requests.find(r=>r.url==='/api/agent/start');assert.equal(start.payload.papers.length,1);assert.equal(start.payload.papers[0].id,'two');assert.equal(start.payload.papers[0].text,'Only this source');
 assert.equal(ui.get('aiAgentExport').hidden,false);
 context.state.selectedId='one';context.updateAgentControls();assert.equal(ui.get('aiAgentExport').hidden,true);assert.equal(ui.get('aiAgentContext').textContent,'First paper');
 context.state.selectedId=null;context.updateAgentControls();assert.equal(context.els.aiAnalyzeButton.disabled,true);
 const count=requests.filter(r=>r.url==='/api/agent/start').length;await context.startPaperScan();assert.equal(requests.filter(r=>r.url==='/api/agent/start').length,count);
 assert(!ui.get('aiAgentStatus').textContent.includes('private-model'));
 context.state.selectedId='two';context.renderPaperAgentJob({id:'legacy',total:2,status:'complete',results:[{id:'one',summary:'Wrong'}]});assert.equal(ui.get('aiAgentExport').hidden,false);
 context.state.selectedId='one';context.renderPaperAgentJob({id:'job',paperId:'two',total:1,status:'running',results:[]});await new Promise(r=>setImmediate(r));
 assert(requests.some(r=>r.url==='/api/agent/cancel'&&r.payload.id==='job'));assert.equal(ui.get('aiAgentExport').hidden,true);
 console.log('PASS: only selected paper is sent, no-selection cannot scan, reports and exports follow selection, legacy batches ignored, model details hidden, changing papers cancels the previous report.');
})().catch(e=>{console.error(e);process.exitCode=1});
