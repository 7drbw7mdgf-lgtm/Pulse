const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert');
const read=name=>fs.readFileSync(path.join(__dirname,'../pulse-frontend/js',name),'utf8');
const frames=new Map();let frame=0,createdRows=0,groupReads=0,sortReads=0;
let doc;
const decode=s=>String(s).replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&');
function matches(node,selector){return selector.split(',').some(part=>{part=part.trim();const tag=/^[a-z][\w-]*/i.exec(part)?.[0];if(tag&&node.tagName!==tag.toUpperCase())return false;
 for(const item of part.matchAll(/\.([\w-]+)/g))if(!node.classes.has(item[1]))return false;
 for(const item of part.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)){const value=node.getAttribute(item[1]);if(value===undefined||(item[2]!==undefined&&value!==item[2]))return false;}return Boolean(tag||part.startsWith('.')||part.startsWith('['));});}
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentNode=null;this.dataset={};this.style={};this.attrs={};this.classes=new Set();this.handlers={};this.scrollTop=0;this.clientHeight=0;this.clientWidth=0;this.value='';this.checked=false;this.textContent='';this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name),contains:name=>this.classes.has(name),toggle:(name,on)=>{if(on??!this.classes.has(name))this.classes.add(name);else this.classes.delete(name);}};}
 setAttribute(key,value){this.attrs[key]=String(value);if(key==='class')this.classes=new Set(value.split(/\s+/));if(key==='id')this.id=value;if(key==='value')this.value=decode(value);if(key==='checked')this.checked=true;if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=decode(value);}
 getAttribute(key){if(key.startsWith('data-'))return this.dataset[key.slice(5).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())];return this.attrs[key];} removeAttribute(key){delete this.attrs[key];}
 appendChild(node){return this.insertBefore(node,null);} insertBefore(node,next){if(node===next)return node;if(node.parentNode)node.remove();const index=next?this.children.indexOf(next):this.children.length;assert(index>=0);this.children.splice(index,0,node);node.parentNode=this;return node;}
 remove(){if(this.parentNode){this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}}
 get firstElementChild(){return this.children[0]||null;}get nextElementSibling(){return this.parentNode?.children[this.parentNode.children.indexOf(this)+1]||null;}
 contains(node){for(let cursor=node;cursor;cursor=cursor.parentNode)if(cursor===this)return true;return false;}
 matches(selector){return matches(this,selector);} closest(selector){for(let cursor=this;cursor;cursor=cursor.parentNode)if(matches(cursor,selector))return cursor;return null;}
 querySelectorAll(selector){const result=[];const walk=node=>{for(const child of node.children){if(matches(child,selector))result.push(child);walk(child);}};walk(this);return result;}querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 addEventListener(type,fn){(this.handlers[type]||=[]).push(fn);}focus(){doc.activeElement=this;}
 getBoundingClientRect(){return {height:this.tagName==='THEAD'?44:this.classes.has('paper-card')?637:this.classes.has('pulse-paper-card')?61:this.classes.has('library-table-row')?96:0};}
 set innerHTML(html){this.children=[];parse(this,html);if(this.tagName==='TEMPLATE')this.content=this;}
 get innerHTML(){return this.children.map(node=>node.tagName+' '+JSON.stringify(node.dataset)+' '+node.textContent+' '+node.innerHTML).join('');}
}
function parse(parent,html){const stack=[parent],voidTags=new Set(['INPUT','BR','IMG','META','LINK','HR']);for(const token of String(html).matchAll(/<\/?[^>]+>|[^<]+/g)){const text=token[0];if(text.startsWith('</')){if(stack.length>1)stack.pop();continue;}if(text.startsWith('<')){const tag=/^<([\w-]+)/.exec(text)?.[1];if(!tag)continue;const node=new Element(tag);const raw=text.slice(tag.length+1,-1);for(const attr of raw.matchAll(/([^\s=/>]+)(?:="([^"]*)")?/g))node.setAttribute(attr[1],decode(attr[2]??''));stack.at(-1).appendChild(node);if(node.dataset.paper&&(node.tagName==='ARTICLE'||node.tagName==='TR'))createdRows++;if(!voidTags.has(node.tagName)&&!text.endsWith('/>'))stack.push(node);}else stack.at(-1).textContent+=decode(text);}}
const root=new Element();root.clientHeight=600;root.clientWidth=320;
const extra=new Map();doc={activeElement:null,createElement:tag=>new Element(tag),getElementById(id){return root.querySelectorAll('[id]').find(node=>node.id===id)||extra.get(id)||(()=>{const node=new Element();node.id=id;extra.set(id,node);return node;})();},querySelector:selector=>root.querySelector(selector),querySelectorAll:selector=>root.querySelectorAll(selector)};
const state={papers:Array.from({length:1000},(_,i)=>({id:'p'+i,title:'Paper '+String(i).padStart(4,'0'),year:String(2000+i%26),authors:['Author '+i],paperKeywords:[i%2?'odd':'even'],citationMetrics:{citationCount:i,source:'OpenAlex'},mapIds:['map-1']})),areas:[],clusters:[],maps:[{id:'map-1',name:'One'},{id:'map-2',name:'Two'}],activeMapId:'map-1',paperView:'compact',libraryFullscreen:false,librarySortKey:'title',librarySortAsc:true,librarySelectedIds:new Set(),filterTags:[]};
state.clusters=Array.from({length:100},(_,group)=>state.papers.slice(group*10,group*10+10).map(p=>p.id));
const context={state,document:doc,els:{paperList:root,paperCount:new Element(),railLibraryBadge:new Element()},Map,Set,CSS:{escape:x=>x},
 requestAnimationFrame(fn){const id=++frame;frames.set(id,fn);return id;},
 escapeHtml:s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'),
 paperAuthors:p=>{sortReads++;return p.authors||[];},paperAuthorSummary:p=>(p.authors||[]).join(', '),paperCitationCount:p=>p.citationMetrics?.citationCount??null,mergedKeywords:p=>p.paperKeywords||[], displayKeywords: p=>p.paperKeywords||[],
 paperMatchesFilters:p=>!state.filterTags.length||state.filterTags.every(tag=>p.paperKeywords.includes(tag)),paperMatchScore:()=>0,paperDomainLabel:()=>'',paperStudyType:()=>'',paperOpenUrl:p=>'https://example.org/'+p.id,safePaperUrl:x=>x,
 paperColor:()=> '#3346d3',paperGroupInfo(p,lookup){groupReads++;return {color:p.color||'#3346d3',name:'Group '+((lookup?.get(p.id)||0)+1)};},
 isPaperOnActiveMap:p=>p.mapIds.includes(state.activeMapId),mapTabOptionsMarkup:p=>state.maps.map(map=>`<option value="${map.id}"${p.mapIds.includes(map.id)?' selected':''}>${map.name}</option>`).join(''),
 setPaperOnMap(p,id,on){p.mapIds=on?[id]:[];},setPaperMapTab(id,map){state.papers.find(p=>p.id===id).mapIds=[map];context.renderPapers();},
 inspectPaper(id){state.selectedId=id;context.renderPapers();},renderMultiSelection(){},renderLibraryBulkActions(){},showToast(){},cleanField:x=>x,
 splitKeywords:x=>x.split(';'),splitAuthors:x=>x.split(';'),normalizeDoi:x=>x,enrichPaperFromDoi:async()=>{},removePapersWithRecovery(){},openTagActionMenu(){},openKeywordModal(){},clearFilterTags(){state.filterTags=[];context.renderPapers();},render(){context.renderPapers();}};
context.window=context;vm.createContext(context);vm.runInContext(read('inspector.js'),context);vm.runInContext(read('part_14.js'),context);
const flush=()=>{let turns=0;while(frames.size){assert(turns++<12,'Measurement must converge');for(const [id,fn]of [...frames]){frames.delete(id);fn();}}};
function emit(type,target,extras={}){let stopped=false;const event={type,target,stopPropagation(){stopped=true;},preventDefault(){},...extras};for(let node=target;node;node=node.parentNode){for(const fn of node.handlers[type]||[])fn(event);if(stopped)break;}return event;}
const rows=()=>root.querySelectorAll('[data-paper]').filter(node=>node.tagName==='ARTICLE'||node.tagName==='TR');
const row=id=>rows().find(node=>node.dataset.paper===id);
context.renderPapers();flush();assert(rows().length<=64);assert(rows().length<30);assert.equal(root.querySelectorAll('[data-library-spacer]').length,1);
const first=row('p0'),second=row('p1'),created=createdRows;context.renderPapers();flush();assert.equal(row('p0'),first);assert.equal(row('p1'),second);assert.equal(createdRows,created,'Unchanged rows retain their DOM trees');
state.papers[0].title='Paper 0000 updated';context.renderPapers();flush();assert.notEqual(row('p0'),first);assert.equal(row('p1'),second);assert.equal(createdRows-created,1,'One metadata change replaces one row');
const keyboardRow=row('p1');keyboardRow.focus();state.papers[1].journal='Keyboard focus update';context.renderPapers();flush();assert.equal(doc.activeElement,row('p1'));assert.notEqual(row('p1'),keyboardRow);doc.activeElement=null;
const stable=row('p1');state.selectedId='p1';state.librarySelectedIds.add('p1');context.renderPapers();flush();assert.equal(row('p1'),stable);assert(stable.classes.has('is-selected'));assert(stable.classes.has('is-multi-selected'));
root.scrollTop=500*64;for(let i=0;i<100;i++)emit('scroll',root);assert.equal(frames.size,1);flush();assert(rows().length<=64);assert(row('p500'));assert(root.querySelectorAll('[data-library-spacer]').length>=2);
const native=root.scrollTop;context.renderPapers();flush();assert.equal(root.scrollTop,native,'Unrelated renders preserve native scroll position');
state.filterTags=['odd'];context.renderPapers();flush();assert(rows().every(node=>Number(node.dataset.paper.slice(1))%2===1));assert(state.librarySelectedIds.has('p1'),'Filtering does not discard selections');
state.filterTags=[];state.librarySortKey='group';groupReads=0;context.libraryDisplayPapers();assert.equal(groupReads,1000,'Group values are extracted once per paper, not per comparison');
state.librarySortKey='authors';sortReads=0;context.libraryDisplayPapers();assert.equal(sortReads,1000,'Author sort parses each paper once');
state.librarySortKey='title';state.paperView='expanded';context.renderPapers();flush();const expanded=row('p1'),input=expanded.querySelector('[data-field="title"]');input.focus();input.value='Uncommitted title';state.papers[1].journal='New remote journal';context.renderPapers();flush();assert.equal(row('p1'),expanded);assert.equal(doc.activeElement,input);assert.equal(input.value,'Uncommitted title');
root.scrollTop=500*640;emit('scroll',root);flush();assert.equal(row('p1'),expanded,'A focused editor stays mounted outside the viewport window');assert(rows().length<=65);assert.equal(doc.activeElement,input);
input.value='Edited title';emit('change',input);flush();assert.equal(state.papers[1].title,'Edited title');assert.equal(row('p1'),expanded);doc.activeElement=null;emit('focusout',input);flush();assert.notEqual(row('p1'),expanded,'Deferred metadata reconciles when the editor loses focus');
state.libraryFullscreen=true;context.renderPapers();flush();assert(rows().length<=64);assert(root.querySelector('table'));const visibleTableRow=rows()[0];context.renderPapers();flush();assert(rows().includes(visibleTableRow));
const tableSource=read('part_24.js');vm.runInContext(tableSource.slice(0,tableSource.indexOf('async function libraryMutationRequest')),context);context.renderLibraryBulkActions(state.papers);const rootChanges=root.handlers.change.length;context.renderLibraryBulkActions(state.papers);assert.equal(root.handlers.change.length,rootChanges,'Bulk delegation binds once');
const bulk=visibleTableRow.querySelector('[data-action="select-library-row"]');bulk.checked=true;emit('change',bulk);flush();assert(state.librarySelectedIds.has(visibleTableRow.dataset.paper));assert(rows().includes(visibleTableRow),'Bulk selection does not replace the row');
const all=doc.getElementById('librarySelectVisible');all.checked=true;emit('change',all);flush();assert.equal(state.librarySelectedIds.size,1000,'Select all covers the whole filtered library, not just mounted rows');
const mapSelect=rows()[0].querySelector('[data-action="set-paper-map-tab"]');mapSelect.value='map-2';emit('change',mapSelect);flush();assert.deepEqual(state.papers.find(p=>p.id===mapSelect.dataset.paper).mapIds,['map-2']);
root.scrollTop=500*96;emit('scroll',root);flush();assert(rows().length<=64);assert(rows().some(node=>Number(node.dataset.paper.slice(1))>400));
console.log('PASS: 1,000-paper keyed Library DOM, one-row updates, selection identity, passive bounded scrolling, filters, linear sort keys, focused editor pinning, table virtualization, delegated bulk selection and map selectors.');
