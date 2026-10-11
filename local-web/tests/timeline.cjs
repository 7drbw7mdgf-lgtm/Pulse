const fs=require('fs'), path=require('path'), vm=require('vm'), assert=require('assert');
const source=fs.readFileSync(path.join(__dirname,'../pulse-frontend/js/timeline.js'),'utf8');
const listeners={}, inspected=[], controls={}, frames=[];
const stage={scrollTop:0,clientHeight:500,isConnected:true,addEventListener(type,callback){listeners[type]=callback;},focus(){}};
const rail={scrollTop:0,innerHTML:'',querySelectorAll:()=>[]};
const timeline={hidden:false,innerHTML:'',contains:()=>false,
  addEventListener(type,callback){listeners[type]=callback;},querySelectorAll:()=>[],querySelector(selector){
    if(selector === '.timeline-stack') return stage;
    if(selector === '.timeline-year-rail') return rail;
    return controls[selector] ||= {dataset:{},addEventListener(){},focus(){}};
  }};
const papers=[
  {id:'late',title:'Synthetic later paper',year:'2001',authors:['Example author'],citations:0},
  {id:'undated',title:'Synthetic undated paper'},
  {id:'early',title:'Synthetic early paper',date:'1993-08-15',doi:'10.1234/example'},
  {id:'year-only',title:'Synthetic year-only paper',year:'1993'},
];
const context={Set,requestAnimationFrame(callback){frames.push(callback);return frames.length;},
  state:{papers,selectedId:'late',timelineFocusId:null},els:{timelineView:timeline,app:{classList:{toggle(){}}}},document:{activeElement:{}},
  escapeHtml:value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  paperAuthorSummary:p=>(p.authors || ['Unknown authors']).join(', '),paperCitationCount:p=>Number.isFinite(p.citations)?p.citations:null,
  normalizeDoi:value=>value,safePaperUrl:()=> '#',setRailAddOpen(){},
  inspectPaper(id){inspected.push(id);context.state.selectedId=id;context.renderTimeline();}};
vm.createContext(context);vm.runInContext(source,context);
assert.deepEqual(Array.from(context.chronologicalPapers(),entry=>entry.paper.id),['year-only','early','late','undated']);
assert.equal(context.parsePaperDate({year:'2001'}).label,'2001');
assert.equal(context.parsePaperDate({year:'2001'}).precision,'year');
assert.equal(context.parsePaperDate({date:'2001-08'}).label,'August 2001');
assert.equal(context.parsePaperDate({date:'2001-08'}).day,null);
assert.equal(context.parsePaperDate({date:'2001-08-15'}).label,'15 August 2001');
assert.equal(context.parsePaperDate({date:'2000-02-29'}).precision,'day');
assert.equal(context.parsePaperDate({date:'2001-02-29'}).precision,'month');
assert.equal(context.parsePaperDate({date:'2001-13-20'}).precision,'year');
assert.equal(context.parsePaperDate({date:'Unknown'}).year,'Undated');
const groups=context.timelineDateGroups(context.chronologicalPapers());
assert.equal(groups[0].count,2);assert.equal(groups[0].months[0].label,'Month unknown');
assert.equal(groups[0].months[1].label,'August');assert.equal(groups[0].months[1].papers[0].date.day,15);
context.state.timelineFocusId='removed';assert.equal(context.timelineFocusIndex(context.chronologicalPapers()),2);
const preview=context.timelineStackPreviews(context.chronologicalPapers(),2);
assert(preview.includes('is-before'));assert(preview.includes('is-after'));
assert(preview.includes('data-timeline-preview="1"'));assert(preview.includes('data-timeline-preview="3"'));
assert(!preview.includes('data-timeline-preview="4"'));
assert.equal(context.timelineStackPreviews([context.chronologicalPapers()[0]],0),'');
context.renderTimeline();assert(timeline.innerHTML.includes('timeline-card-pile'));assert(timeline.innerHTML.includes('Paper 3 of 4'));assert(timeline.innerHTML.includes('0 citations'));
assert(rail.innerHTML.includes('1993 · 2 papers'));assert(!timeline.innerHTML.includes('Seminal'));
context.state.timelineExpandedYears.add('1993');context.renderTimeline();
assert(rail.innerHTML.includes('aria-expanded="true"'));assert(rail.innerHTML.includes('August'));
assert(rail.innerHTML.includes('15 August 1993'));assert(rail.innerHTML.includes('Synthetic year-only paper'));
assert(rail.innerHTML.includes('data-timeline-index="1"'));
assert.equal(context.selectTimelineIndex(-1),false);assert.equal(context.selectTimelineIndex(4),false);assert.equal(inspected.length,0);
assert.equal(context.selectTimelineIndex(1),true);assert.equal(inspected.at(-1),'early');assert.equal(stage.scrollTop,500);
assert(timeline.innerHTML.includes('https://doi.org/10.1234/example'));
const stableMarkup=timeline.innerHTML;
stage.scrollTop=1100;context.readTimelineScroll(stage);
assert.equal(context.state.selectedId,'late');assert.equal(stage.scrollTop,1100);assert.equal(timeline.innerHTML,stableMarkup);
assert.equal(controls['.timeline-position strong'].innerHTML,'Paper 3 <span>/ 4</span>');
assert.equal(context.timelineScrollIndex(900,500,4),2);assert.equal(context.timelineScrollIndex(9999,500,4),3);
assert.equal(context.timelineScrollIndex(-500,500,4),0);assert.equal(context.timelineScrollIndex(0,0,4),-1);
let prevented=0;const keyEvent=(key,extras={})=>({key,target:{closest:()=>null},preventDefault(){prevented++;},...extras});
listeners.keydown(keyEvent('End'));assert.equal(context.state.selectedId,'undated');assert(timeline.innerHTML.includes('Citations not checked'));
const before=inspected.length;listeners.keydown(keyEvent('ArrowDown'));assert.equal(inspected.length,before);
listeners.keydown(keyEvent('Home'));assert.equal(context.state.selectedId,'year-only');
listeners.keydown(keyEvent('ArrowDown',{ctrlKey:true}));assert.equal(context.state.selectedId,'year-only');
listeners.keydown(keyEvent('ArrowDown',{target:{closest:()=>({})}}));assert.equal(context.state.selectedId,'year-only');assert(prevented>0);
rail.dataset={selectedIndex:'0'};rail.scrollTop=0;
rail.getBoundingClientRect=()=>({top:0,bottom:200});
rail.querySelector=()=>({getBoundingClientRect:()=>({top:250,bottom:280})});
context.renderTimelineRail(context.chronologicalPapers(),2);assert.equal(rail.scrollTop,92);
rail.scrollTop=130;context.renderTimelineRail(context.chronologicalPapers(),2);assert.equal(rail.scrollTop,130);
context.state.papers=[];context.renderTimeline();assert(timeline.innerHTML.includes('Your timeline starts with a paper'));assert.equal(context.state.timelineFocusId,null);
console.log('PASS: publication precision, year/month/date grouping, bounded neighboring stack previews, active-date reveal without resetting manual rail scrolling, native scroll selection without rebuilding the deck, DOI links, unknown metrics, keyboard and boundary navigation, stale selection, and empty timeline.');
