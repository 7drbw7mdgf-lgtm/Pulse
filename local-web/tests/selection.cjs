const fs = require('fs'), vm = require('vm'), assert = require('assert');
const source = fs.readFileSync(require('path').join(__dirname,'../pulse-frontend/js/part_13.js'), 'utf8');
const selection = source.slice(source.indexOf('    function inspectPaper('), source.indexOf('    function metadataSummary('));
function fixture() {
  const calls = [], state = { papers: [{id:'one'}, {id:'two'}], selectedId:'one', selectedLinkId:'one__two', detailsAbstractExpanded:true, inspectorVisible:false, libraryFullscreen:true };
  const els = {aiPanel:{hidden:false}, details:{scrollTop:200}};
  const context = {state, els,
    setLibraryFullscreen(value){state.libraryFullscreen=value; calls.push('exit-fullscreen');},
    setInspectorVisible(value){state.inspectorVisible=value; calls.push('open-inspector');},
    setAiPanelOpen(value){els.aiPanel.hidden=!value; calls.push('close-agent');},
    renderSelection(){calls.push('selection');},
    renderDetails(){calls.push(['details', state.selectedId, state.selectedLinkId, state.inspectorVisible]);},
    updateAgentControls(){calls.push('agent-context');}};
  vm.createContext(context); vm.runInContext(selection,context);
  return {context,state,els,calls};
}
const test=fixture();test.context.inspectPaper('two');
assert.equal(test.state.selectedId,'two'); assert.equal(test.state.selectedLinkId,null);
assert.equal(test.state.inspectorVisible,true); assert.equal(test.state.libraryFullscreen,false);
assert.equal(test.state.detailsAbstractExpanded,false); assert.equal(test.els.details.scrollTop,0);
assert.equal(test.els.aiPanel.hidden,true);
assert.deepEqual(test.calls.find(Array.isArray),['details','two',null,true]);
assert(test.calls.includes('selection')&&test.calls.includes('agent-context'));
const missing=fixture();missing.context.inspectPaper('missing');assert.equal(missing.calls.length,0);assert.equal(missing.state.selectedId,'one');
const keepAgent=fixture();keepAgent.context.inspectPaper('two',{closeAgent:false});assert.equal(keepAgent.els.aiPanel.hidden,false);
console.log('PASS: paper selection replaces linkage details, reopens the inspector, exits full screen, resets scroll, updates the agent context, and ignores missing records.');

const graphSource=fs.readFileSync(require('path').join(__dirname,'../pulse-frontend/js/part_20.js'),'utf8');
const graphHandler=graphSource.slice(graphSource.indexOf('    function handleGraphBackgroundClick'),graphSource.indexOf("    els.map?.addEventListener('click', handleGraphBackgroundClick)"));
const hides=[];const graphContext={state:{selectedId:'one',selectedLinkId:'link'},setInspectorVisible:(...args)=>hides.push(args),render(){},renderDetails(){}};
vm.createContext(graphContext);vm.runInContext(graphHandler,graphContext);
graphContext.handleGraphBackgroundClick({target:{closest:()=>null}});assert.equal(hides.length,1);assert.equal(hides[0][0],false);assert.equal(hides[0][1],false);assert.equal(graphContext.state.selectedId,null);
graphContext.state.selectedId='one';graphContext.handleGraphBackgroundClick({target:{closest:()=>({})}});assert.equal(hides.length,1);assert.equal(graphContext.state.selectedId,'one');
console.log('PASS: empty graph clicks hide the inspector without changing the saved preference; node, edge and area clicks remain interactive.');
