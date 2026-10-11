const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const read=name=>fs.readFileSync(path.join(__dirname,'../pulse-frontend/js/',name),'utf8');
const functions=(source,start,end)=>source.slice(source.indexOf('    function '+start+'('),source.indexOf(end,source.indexOf('    function '+start+'(')));
const elements={};
function element(id){return elements[id] ||= {dataset:{},attributes:{},classes:new Set(),hidden:true,
 classList:{toggle(name,value){if(value)elements[id].classes.add(name);else elements[id].classes.delete(name);},contains(name){return elements[id].classes.has(name);},remove(name){elements[id].classes.delete(name);}},
 setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},focus(){},scrollIntoView(){},addEventListener(type,fn){this[type]=fn;}};}
const nav=['network','library','trends','timeline','settings'].map(name=>{const item=element(name);item.dataset.rail=name;return item;});
const root=element('root');root.getAttribute=name=>root.attributes[name]||null;
const state={mode:'network',libraryFullscreen:false,libraryOpen:true};
const els={app:element('app'),timelineView:element('timelineView'),settingsPanel:element('settingsPanel'),settingsButton:element('settingsButton'),colLibrary:element('colLibrary'),closeLibrarySwipeBtn:element('fullscreen'),themeToggle:element('theme')};
const store={};
const context={state,els,localStorage:{getItem:key=>store[key],setItem:(key,value)=>store[key]=value},window:{matchMedia:()=>({matches:false})},
 document:{documentElement:root,querySelectorAll:()=>nav,querySelector:()=>nav.find(item=>item.classes.has('active')),getElementById:id=>element(id)},
 loadBackendSettings(){},showToast(){},setAiPanelOpen(){},syncDensityButtons(){},renderPapers(){},render(){},requestAnimationFrame:fn=>fn(),
 setTimelineVisible(value){els.timelineView.hidden=!value;}};
vm.createContext(context);
vm.runInContext(functions(read('part_01.js'),'highlightRail','    function discoveryPaperKey'),context);
vm.runInContext(functions(read('part_21.js'),'toggleLibraryWithSwipe','    els.closeLibrarySwipeBtn?'),context);
vm.runInContext(functions(read('part_04.js'),'initFrankTheme','    function updateSaveStatePill'),context);
context.highlightRail('timeline');els.timelineView.hidden=false;
context.setSettingsOpen(true);assert.equal(context.activeRail(),'settings');
context.setSettingsOpen(true);context.setSettingsOpen(false);assert.equal(context.activeRail(),'timeline');
context.setLibraryFullscreen(true);assert.equal(context.activeRail(),'library');assert.equal(state.libraryPreviousRail,'timeline');
context.setSettingsOpen(true);context.setSettingsOpen(false);assert.equal(context.activeRail(),'library');
context.setLibraryFullscreen(false);assert.equal(context.activeRail(),'timeline');assert.equal(els.timelineView.hidden,false);
state.libraryPreviousRail='network';context.toggleLibraryWithSwipe(false);assert.equal(context.activeRail(),'timeline');
context.toggleLibraryWithSwipe(true);assert.equal(context.activeRail(),'library');
context.setSettingsOpen(true);context.setSettingsOpen(false);assert.equal(context.activeRail(),'library');
context.toggleLibraryWithSwipe(false);assert.equal(context.activeRail(),'timeline');
context.highlightRail('trends');els.timelineView.hidden=true;state.mode='clusters';
context.setLibraryFullscreen(true);context.setLibraryFullscreen(false);assert.equal(context.activeRail(),'trends');
context.setSettingsOpen(true);context.highlightRail('network');context.setSettingsOpen(false);assert.equal(context.activeRail(),'network');
context.initFrankTheme();assert.equal(root.attributes['data-theme'],'light');assert.equal(els.themeToggle.attributes['aria-label'],'Switch to dark theme');
els.themeToggle.click();assert.equal(root.attributes['data-theme'],'dark');assert.equal(store['pulse-theme'],'dark');assert.equal(els.themeToggle.attributes['aria-pressed'],'true');
els.themeToggle.click();assert.equal(root.attributes['data-theme'],'light');context.applyFrankTheme('invalid');assert.equal(root.attributes['data-theme'],'light');
console.log('PASS: Settings and Library restore Timeline/Trends, nested overlays preserve their origin, later navigation is respected, and one theme button toggles and persists both themes.');
