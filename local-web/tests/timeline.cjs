const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../pulse-frontend/js/timeline.js'),'utf8');
const rootListeners={},stageListeners={},inspected=[],controls={},frames=new Map(),timers=new Map();
let timerId=0,frameId=0,rootWrites=0,railWrites=0,cardBuilds=0,orderBuilds=0,resize;
function element(dataset={},classNames=[]){const classes=new Set(classNames);return {dataset,style:{},attributes:{},classes,
 classList:{add(name){classes.add(name);},remove(name){classes.delete(name);},toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains(name){return classes.has(name);}},
 setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},focus(){this.focused=true;},getBoundingClientRect(){return this.bounds||{top:20,bottom:40};}};}
const surface={style:{},slots:new Map(),querySelectorAll:()=>Array.from(surface.slots.values()),
 insertAdjacentHTML(position,html){cardBuilds++;const index=Number(/data-timeline-slot="(\d+)"/.exec(html)[1]);const id=/data-timeline-id="([^"]+)"/.exec(html)[1];
  const slot=element({timelineSlot:String(index)});slot.insertAdjacentHTML=(position,html)=>{surface.insertAdjacentHTML('beforeend',html);surface.slots=new Map([...surface.slots].sort((a,b)=>a[0]-b[0]));};slot.html=html;slot.card=element({timelineId:id},['timeline-paper']);slot.remove=()=>surface.slots.delete(index);surface.slots.set(index,slot);}};
Object.defineProperty(surface,'innerHTML',{get:()=>Array.from(surface.slots.values(),slot=>slot.html).join(''),set:()=>surface.slots.clear()});
const stage={dataset:{},scrollTop:0,clientHeight:500,isConnected:true,addEventListener(type,callback,options){stageListeners[type]=callback;stageListeners[type+'Options']=options;},focus(){}};
const rail={scrollTop:0,dataset:{},buttons:[],getBoundingClientRect:()=>({top:0,bottom:200}),
 querySelectorAll(selector){return selector==='.is-current'?this.buttons.filter(button=>button.classes.has('is-current')):this.buttons;},
 querySelector(selector){if(selector.includes('.is-current'))return this.buttons.find(button=>button.classes.has('is-current')&&button.classes.has(selector.includes('date-stop')?'timeline-date-stop':'timeline-year-stop'));
  const match=/\[data-timeline-(year|month|control)="([^"]+)"\]/.exec(selector);return match?this.buttons.find(button=>button.dataset['timeline'+match[1][0].toUpperCase()+match[1].slice(1)]===match[2]):null;}};
let railMarkup='';Object.defineProperty(rail,'innerHTML',{get:()=>railMarkup,set(value){railWrites++;railMarkup=value;rail.buttons=[];
 for(const match of value.matchAll(/<button\b([^>]+)>/g)){const attrs=match[1],dataset={};for(const item of attrs.matchAll(/data-timeline-(year|month|control|index)="([^"]+)"/g))dataset['timeline'+item[1][0].toUpperCase()+item[1].slice(1)]=item[2];
 const classes=/class="([^"]*)"/.exec(attrs);rail.buttons.push(element(dataset,classes?classes[1].split(' '):[]));}}});
let markup='';const timeline={hidden:false,hasStage:false,contains:()=>false,addEventListener(type,callback){rootListeners[type]=callback;},
 querySelectorAll(selector){return selector==='.timeline-paper'?Array.from(surface.slots.values(),slot=>slot.card):[];},
 querySelector(selector){if(selector==='.timeline-stack')return this.hasStage?stage:null;if(selector==='.timeline-virtual-space')return this.hasStage?surface:null;if(selector==='.timeline-year-rail')return this.hasStage?rail:null;
 return controls[selector] ||= {...element(),addEventListener(){}};}};
Object.defineProperty(timeline,'innerHTML',{get:()=>markup,set(value){rootWrites++;markup=value;timeline.hasStage=value.includes('timeline-stack');surface.slots.clear();rail.buttons=[];railMarkup='';rail.dataset={};}});
const papers=[{id:'late',title:'Synthetic later paper',year:'2001',authors:['Example author'],citations:0},
 {id:'undated',title:'Synthetic undated paper'},
 {id:'early',title:'Synthetic early paper',date:'1993-08-15',doi:'10.1234/example'},
 {id:'year-only',title:'Synthetic year-only paper',year:'1993'}];
const context={Set,Map,requestAnimationFrame(callback){const id=++frameId;frames.set(id,callback);return id;},cancelAnimationFrame:id=>frames.delete(id),
 setTimeout(callback){const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id),
 ResizeObserver:class{constructor(callback){resize=callback;}observe(){}disconnect(){}},
 state:{papers,selectedId:'late',timelineFocusId:null},els:{timelineView:timeline,app:{classList:{toggle(){}}}},document:{activeElement:{}},
 escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
 paperAuthorSummary:p=>(p.authors||['Unknown authors']).join(', '),paperCitationCount:p=>Number.isFinite(p.citations)?p.citations:null,
 safePaperUrl:()=> '#',setRailAddOpen(){},
 inspectPaper(id){inspected.push(id);context.state.selectedId=id;context.renderTimeline();}};
vm.createContext(context);vm.runInContext(source,context);
const originalOrder=context.chronologicalPapers;context.chronologicalPapers=()=>{orderBuilds++;return originalOrder();};
const flushFrame=()=>{for(const [id,fn]of [...frames]){frames.delete(id);fn();}};
const settle=()=>{for(const [id,fn]of [...timers]){timers.delete(id);fn();}};
const allMarkup=()=>timeline.innerHTML+surface.innerHTML;
assert.deepEqual(Array.from(context.chronologicalPapers(),entry=>entry.paper.id),['year-only','early','late','undated']);
for(const [input,label,precision]of [[{year:'2001'},'2001','year'],[{date:'2001-08'},'August 2001','month'],[{date:'2001-08-15'},'15 August 2001','day'],[{date:'2000-02-29'},'29 February 2000','day'],[{date:'2001-02-29'},'February 2001','month'],[{date:'2001-13-20'},'2001','year'],[{date:'Unknown'},'Date unknown','unknown']]){
 const actual=context.parsePaperDate(input);assert.equal(actual.label,label);assert.equal(actual.precision,precision);}
const groups=context.timelineDateGroups(context.chronologicalPapers());assert.equal(groups[0].count,2);assert.equal(groups[0].months[0].label,'Month unknown');assert.equal(groups[0].months[1].papers[0].date.day,15);
context.state.timelineFocusId='removed';assert.equal(context.timelineFocusIndex(context.chronologicalPapers()),2);
const preview=context.timelineStackPreviews(context.chronologicalPapers(),2);assert(preview.includes('is-before'));assert(preview.includes('is-after'));assert(!preview.includes('data-timeline-preview="4"'));
assert.equal(context.timelineStackPreviews([context.chronologicalPapers()[0]],0),'');
context.renderTimeline();assert(allMarkup().includes('timeline-card-pile'));assert(allMarkup().includes('Paper 3 of 4'));assert(allMarkup().includes('0 citations'));assert(rail.innerHTML.includes('1993 · 2 papers'));
context.state.timelineExpandedYears.add('1993');context.renderTimeline();assert(rail.innerHTML.includes('aria-expanded="true"'));assert(rail.innerHTML.includes('15 August 1993'));
assert.equal(context.selectTimelineIndex(-1),false);assert.equal(context.selectTimelineIndex(4),false);assert.equal(inspected.length,0);
assert.equal(context.selectTimelineIndex(1),true);assert.equal(inspected.at(-1),'early');assert.equal(stage.scrollTop,500);assert(allMarkup().includes('https://doi.org/10.1234/example'));
const stableMarkup=timeline.innerHTML,stableRootWrites=rootWrites,stableRailWrites=railWrites,previousInspections=inspected.length;
stage.scrollTop=1100;context.readTimelineScroll(stage);
assert.equal(context.state.timelineFocusId,'late');assert.equal(context.state.selectedId,'early','Inspector waits for native momentum to finish');assert.equal(inspected.length,previousInspections);
assert.equal(stage.scrollTop,1100);assert.equal(timeline.innerHTML,stableMarkup);assert.equal(rootWrites,stableRootWrites);assert.equal(railWrites,stableRailWrites);
settle();assert.equal(context.state.selectedId,'late');assert.equal(inspected.length,previousInspections+1);assert.equal(stage.scrollTop,1100);
assert.equal(controls['.timeline-position strong'].innerHTML,'Paper 3 <span>/ 4</span>');
assert.equal(context.timelineScrollIndex(900,500,4),2);assert.equal(context.timelineScrollIndex(9999,500,4),3);assert.equal(context.timelineScrollIndex(-500,500,4),0);assert.equal(context.timelineScrollIndex(0,0,4),-1);
let prevented=0;const key=(value,extras={})=>({key:value,target:{closest:()=>null},preventDefault(){prevented++;},...extras});
rootListeners.keydown(key('End'));assert.equal(context.state.selectedId,'undated');assert(allMarkup().includes('Citations not checked'));
const before=inspected.length;rootListeners.keydown(key('ArrowDown'));assert.equal(inspected.length,before);
rootListeners.keydown(key('Home'));assert.equal(context.state.selectedId,'year-only');rootListeners.keydown(key('ArrowDown',{ctrlKey:true}));assert.equal(context.state.selectedId,'year-only');rootListeners.keydown(key('ArrowDown',{target:{closest:()=>({})}}));assert.equal(context.state.selectedId,'year-only');assert(prevented>0);
rail.scrollTop=130;context.renderTimelineRail(vm.runInContext('timelineModel.ordered',context),0);assert.equal(rail.scrollTop,130,'Manual year rail scrolling remains stable when selection does not change');

// Hundreds of wheel events use one animation frame, five live cards, no
// re-sorting or rail reconstruction, and one inspector update at scroll rest.
context.state.papers=Array.from({length:1000},(_,i)=>({id:'p'+i,title:'Synthetic paper '+i,year:String(1900+Math.floor(i/10))}));
context.state.selectedId='p500';context.state.timelineFocusId='p500';context.renderTimeline();
assert.equal(surface.slots.size,5);assert.equal(surface.style.height,'500000px');
assert.deepEqual(Array.from(surface.slots.keys()).sort((a,b)=>a-b),[498,499,500,501,502]);
const retained=surface.slots.get(501),initialCards=cardBuilds,initialOrders=orderBuilds,initialRails=railWrites,initialRoots=rootWrites,initialInspect=inspected.length;
for(let i=0;i<200;i++){stage.scrollTop=250500+i;stageListeners.scroll();}
assert.equal(frames.size,1);assert.equal(stageListeners.scrollOptions.passive,true);flushFrame();
assert.equal(surface.slots.get(501),retained,'Overlapping card nodes survive scroll-window updates');assert.equal(surface.slots.size,5);
for(let i=0;i<20;i++){stage.scrollTop=(502+i)*500+70;stageListeners.scroll();flushFrame();assert(surface.slots.size<=5);}
assert.equal(rootWrites,initialRoots);assert.equal(railWrites,initialRails);assert.equal(orderBuilds,initialOrders);assert.equal(inspected.length,initialInspect);
assert(cardBuilds-initialCards<=25,'Only entering cards are built; current cards are reused');
const nativeOffset=stage.scrollTop;stageListeners.scrollend();assert.equal(inspected.length,initialInspect+1);assert.equal(context.state.selectedId,'p521');assert.equal(stage.scrollTop,nativeOffset);assert.equal(orderBuilds,initialOrders);
context.renderTimeline();assert.equal(stage.scrollTop,nativeOffset,'An unrelated render after scrolling does not snap the native offset');
assert.equal(timers.size,0);
// Reverse scrolling also keeps tab/reading order chronological.
stage.scrollTop=519*500;stageListeners.scroll();flushFrame();assert.deepEqual(Array.from(surface.slots.keys()),[517,518,519,520,521]);settle();
// A genuine metadata update keeps the active native gesture in place.
stage.scrollTop=518*500+75;stageListeners.scroll();flushFrame();const updateOffset=stage.scrollTop;context.state.papers[518].title='Updated title';context.renderTimeline();assert.equal(stage.scrollTop,updateOffset);assert(surface.innerHTML.includes('Updated title'));settle();
// A direct library selection must not be overwritten by a pending scroll.
stage.scrollTop=517*500;stageListeners.scroll();flushFrame();context.state.timelineFocusId='p300';context.inspectPaper('p300');const directSelectionCount=inspected.length;settle();assert.equal(context.state.selectedId,'p300');assert.equal(inspected.length,directSelectionCount);assert.equal(stage.scrollTop,300*500);
// Inspector width changes keep the fractional native scroll position.
const resizeOffset=stage.scrollTop;stage.clientHeight=400;resize();assert.equal(stage.scrollTop,resizeOffset/500*400);assert.equal(surface.style.height,'400000px');assert.equal(surface.slots.size,5);
// Keyboard jumps stay immediate and mount the destination before moving there.
const keyboardOrders=orderBuilds;rootListeners.keydown(key('End'));assert.equal(orderBuilds,keyboardOrders);assert.equal(context.state.selectedId,'p999');assert.equal(stage.scrollTop,999*400);assert(surface.slots.has(999));
stage.scrollTop=998*400;stageListeners.scroll();flushFrame();const hiddenBefore=inspected.length;context.setTimelineVisible(false);settle();assert.equal(inspected.length,hiddenBefore);assert.equal(timers.size,0);
context.state.papers=[];timeline.hidden=false;context.renderTimeline();assert(timeline.innerHTML.includes('Your timeline starts with a paper'));assert.equal(context.state.timelineFocusId,null);
console.log('PASS: Timeline dates/grouping, five-card virtualization, retained card/scroll surfaces, passive frame-coalesced scrolling, cached ordering/rail, one settled inspector update, fractional resize preservation, immediate keyboard selection, cancellation on hide, and empty state across 1,000 papers.');
