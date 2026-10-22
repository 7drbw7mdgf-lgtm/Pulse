/* Continuous page stack: local page images plus a selectable text layer; annotations stay in the library. */
const PulsePDF = (() => {
  let paperId=null,attachmentId=null,pageNumber=1,selection=null,revision=0,undo=null;
  let previewFile=null,lookupController=null,openRevision=0,downloading=false;
  // Pages near the viewport are rendered at the zoom and screen density; the rest are sized placeholders.
  let info=null,outline=null,pages=[],layoutKey='',observer=null,queue=[],busy=0,currentScale=1,pin=null,scrollFrame=0,renderTimer=0,positionTimer=0,gestureBase=1;
  let zoom=String(stored('pulse-pdf-zoom','fit'));if(zoom!=='fit'&&zoom!=='page'&&!(Number(zoom)>0))zoom='fit';
  const infoCache=new Map(),outlineCache=new Map(),colors={yellow:'#ffe66b',green:'#92e5aa',blue:'#8bc9ff',pink:'#f7a3d2'};
  const zoomSteps=[.25,.5,.75,1,1.25,1.5,2,3,4],POSITIONS='pulse-pdf-positions';
  const paper=()=>state.papers.find(p=>p.id===paperId),root=()=>document.getElementById('pdfReaderDialog');
  const get=id=>document.getElementById(id);
  const file=()=>previewFile||(paper()?.pdfAttachments||[]).find(row=>row.id===attachmentId);
  const order=()=>file()?.editor?.pageOrder||Array.from({length:file()?.pages||info?.pages||1},(_,i)=>i+1);
  const sourcePage=()=>order()[pageNumber-1]||1;
  const rotationOf=source=>Number(file()?.editor?.rotations?.[source]||0);
  const rotation=()=>rotationOf(sourcePage());
  const record=()=>pages[pageNumber-1];
  function stored(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
  function keep(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
  function notify(name){document.dispatchEvent(new CustomEvent('pulse:pdf-'+name));}
  async function request(endpoint,payload,signal) {
    await backendReady;
    const response=await fetch(backendUrl('/api/reader/'+endpoint),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload),signal});
    const data=await response.json();if(!response.ok){const error=Error(data.error||'PDF request failed.');error.status=response.status;throw error;}return data;
  }
  async function store(name,buffer){return request('attach',{name,contentBase64:arrayBufferToBase64(buffer)});}
  function displayMode() {
    const preview=Boolean(previewFile),file=previewFile||(paper()?.pdfAttachments||[]).find(row=>row.id===attachmentId);
    root().classList.toggle('is-preview',preview);
    get('pdfReadMode').textContent=preview?'Preview':attachmentId?'Local copy':'PDF reader';
    get('pdfAnnotationSidebar').hidden=!attachmentId||preview;
    get('pdfPreviewNotice').hidden=!preview;
    get('pdfDownloadCopy').hidden=!attachmentId;
    get('pdfDownloadCopy').textContent=preview?'Download & annotate':'Download original PDF';
    get('pdfDownloadCopy').disabled=downloading;
    get('pdfUndoAnnotation').hidden=preview||!attachmentId;
    get('pdfAttachmentSelect').innerHTML=(paper()?.pdfAttachments||[]).map(row=>`<option value="${escapeHtml(row.id)}">${escapeHtml(row.name)}</option>`).join('');
    if(preview&&!get('pdfAttachmentSelect').querySelector(`option[value="${previewFile.id}"]`)){
      const option=new Option('Open PDF preview',previewFile.id);get('pdfAttachmentSelect').add(option);
    }
    get('pdfAttachmentSelect').value=attachmentId||'';
    get('pdfAttachmentSelect').hidden=!get('pdfAttachmentSelect').options.length;
    const href=safeHref(file?.url||'');get('pdfSourceLink').hidden=!href;get('pdfSourceLink').href=href||'#';
    get('pdfSourceLink').textContent=file?.source?'Source: '+file.source:'PDF source';
    updateSelection();
    notify('state');
  }
  async function open(id,page=null,pdfId=null) {
    lookupController?.abort();const generation=++openRevision;previewFile=null;
    paperId=id;const p=paper();if(!p)return showToast('This paper is no longer in the library.');
    attachmentId=pdfId||(p.pdfAttachments||[])[0]?.id||null;selection=null;
    get('pdfReaderTitle').textContent=p.title;
    get('pdfPageNumber').value=1;get('pdfPageTotal').textContent='';get('pdfFindOpen').disabled=false;
    displayMode();
    if(!root().open)root().showModal();
    if(!attachmentId)return findOpenPDF();
    if(!await loadDocument(page)&&generation===openRevision&&root().open)return findOpenPDF();
  }
  async function findOpenPDF() {
    const p=paper();if(!p)return;
    lookupController?.abort();lookupController=new AbortController();const generation=++openRevision;
    const lookupPaper=Object.fromEntries(['title','authors','year','doi','pmid','pmcid','openAlexId','arxivId','url','pdfUrl','fullTextUrl','fullTextLinks','openAccessPdf'].map(key=>[key,p[key]]));
    revision++;attachmentId=null;previewFile=null;selection=null;clearPages();displayMode();
    get('pdfPageTotal').textContent='';
    get('pdfPrevPage').disabled=true;get('pdfNextPage').disabled=true;get('pdfFindOpen').disabled=true;
    get('pdfReaderStatus').textContent='Finding a freely available PDF…';
    try{
      const file=await request('preview',{paper:lookupPaper},lookupController.signal);
      if(generation!==openRevision||!root().open)return;
      previewFile=file;attachmentId=file.id;displayMode();await loadDocument();
    }catch(error){if(generation===openRevision&&error.name!=='AbortError')get('pdfReaderStatus').textContent=error.message;}
    finally{if(generation===openRevision)get('pdfFindOpen').disabled=false;}
  }
  async function downloadCopy() {
    if(!attachmentId||downloading||!paper())return;
    const targetId=paperId,generation=openRevision,identity=attachmentId;
    const file=previewFile||(paper().pdfAttachments||[]).find(row=>row.id===identity);
    downloading=true;displayMode();get('pdfReaderStatus').textContent='Downloading PDF…';
    try{
      if(previewFile){
        if(state.libraryMutation||state.clearingLibrary)throw Error('Wait for the current library change to finish, then download again.');
        const kept=await request('keep',{id:identity,name:file.name,url:file.url,source:file.source});
        const p=state.papers.find(row=>row.id===targetId);if(!p)throw Error('This paper is no longer in the library.');
        p.pdfAttachments ||= [];const existing=p.pdfAttachments.find(row=>row.id===kept.id);
        if(existing)Object.assign(existing,kept);else p.pdfAttachments.push(kept);
        scheduleAutosave();
        if(await saveLibrary()===false)throw Error('The PDF copy is saved locally, but the library could not be saved. Try downloading again.');
        if(generation===openRevision){previewFile=null;displayMode();drawPage();renderAnnotations();renderDetails();}
      }
      const response=await fetch(backendUrl('/api/reader/file/'+identity),{headers:apiHeaders()});
      if(!response.ok)throw Error('The PDF file could not be downloaded. Try again.');
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');
      anchor.href=url;anchor.download=(file?.name||'Paper.pdf').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_');anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      if(generation===openRevision)get('pdfReaderStatus').textContent='Local copy saved. You can now highlight, annotate and quote this PDF.';
    }catch(error){if(generation===openRevision)get('pdfReaderStatus').textContent=error.message;}
    finally{downloading=false;if(root().open)displayMode();}
  }
  async function attach(file) {
    if(!file||!paper())return;
    lookupController?.abort();const generation=++openRevision;
    const id=paperId;get('pdfReaderStatus').textContent='Attaching PDF…';get('pdfAttachInput').disabled=true;
    try{const attachment=await store(file.name,await file.arrayBuffer()),p=state.papers.find(row=>row.id===id);if(!p)return;
      p.pdfAttachments ||= [];if(!p.pdfAttachments.some(row=>row.id===attachment.id))p.pdfAttachments.push(attachment);
      scheduleAutosave();if(paperId===id&&generation===openRevision&&root().open)await open(id,1,attachment.id);renderDetails();
    }catch(error){get('pdfReaderStatus').textContent=error.message;}finally{get('pdfAttachInput').disabled=false;get('pdfAttachInput').value='';}
  }
  function clearPages() {
    observer?.disconnect();observer=null;queue=[];layoutKey='';pin=null;outline=null;
    for(const r of pages)r.waiters.splice(0).forEach(w=>w.resolve(false));
    pages=[];info=null;get('pdfPageStack').replaceChildren();
  }
  /* Opens the current attachment at an explicit source page, or where the reader left it. */
  async function loadDocument(target=null) {
    const token=++revision;selection=null;updateSelection();clearPages();
    get('pdfReaderStatus').textContent=attachmentId?'Loading PDF…':'Attach a local PDF to read and annotate it here. PDFs stay on this computer.';
    get('pdfPrevPage').disabled=true;get('pdfNextPage').disabled=true;
    if(!attachmentId){renderAnnotations();return false;}
    const identity=attachmentId;
    try {
      const data=infoCache.get(identity)||await request('info',{id:identity});
      if(token!==revision)return false;
      infoCache.set(identity,data);while(infoCache.size>8)infoCache.delete(infoCache.keys().next().value);
      info=data;if(file())file().pages=data.pages;
      const saved=target==null?stored(POSITIONS,{})[identity]:null;
      pageNumber=Math.max(1,order().indexOf(Number(target??saved?.page)||1)+1);
      pin={number:pageNumber,offset:saved?.offset||0,at:0};layout();
      if(!await ensure(record())||token!==revision)return false;
      loadOutline(identity,token);
      return true;
    }catch(error){if(token===revision)get('pdfReaderStatus').textContent=error.message;return false;}
  }
  async function loadOutline(identity,token) {
    try{const data=outlineCache.get(identity)||await request('outline',{id:identity});
      outlineCache.set(identity,data);while(outlineCache.size>8)outlineCache.delete(outlineCache.keys().next().value);
      if(token===revision){outline=data;notify('outline');}
    }catch{if(token===revision){outline={outline:[],source:''};notify('outline');}}
  }
  function size(r){const [width,height]=info?.sizes?.[r.source-1]||[612,792];return r.rotation%180?[height,width]:[width,height];}
  function layout() {
    if(!info||!attachmentId)return;
    const key=[attachmentId,order().join(','),JSON.stringify(file()?.editor?.rotations||{})].join(':');
    if(key===layoutKey)return resize();
    // Reordering keeps rendered pages; a rotated page is rendered again.
    const previous=new Map(pages.map(r=>[r.source+':'+r.rotation,r]));
    observer?.disconnect();queue=[];layoutKey=key;
    pages=order().map((source,index)=>{
      const rotation=rotationOf(source),id=source+':'+rotation,r=previous.get(id)||{source,rotation,data:null,requested:0,waiters:[],el:document.createElement('div')};
      previous.delete(id);r.index=index;r.el.className='pdf-page';r.el.pdfRecord=r;r.el.dataset.pdfPage=index+1;r.el.dataset.sourcePage=source;
      r.el.setAttribute('aria-label','PDF page '+(index+1));return r;
    });
    for(const r of previous.values())r.waiters.splice(0).forEach(w=>w.resolve(false));
    get('pdfPageStack').replaceChildren(...pages.map(r=>r.el));
    observer=new IntersectionObserver(nearby,{root:get('pdfViewport'),rootMargin:'120% 0px'});
    for(const r of pages)observer.observe(r.el);
    resize();setCurrent(Math.min(pageNumber,pages.length),true);
  }
  function fitScale() {
    const viewport=get('pdfViewport'),style=getComputedStyle(viewport);
    const width=viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-4;
    const height=viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom)-4;
    if(width<=0||!pages.length)return currentScale;
    const widest=Math.max(...pages.map(r=>size(r)[0]));
    if(zoom==='fit')return Math.min(3,width/widest);
    const [w,h]=size(record()||pages[0]);return Math.min(width/w,height/h);
  }
  const pageTop=r=>get('pdfPageStack').offsetTop+r.el.offsetTop;
  function indexAt(y){let low=0,high=pages.length-1;while(low<high){const middle=Math.ceil((low+high)/2);if(pageTop(pages[middle])<=y)low=middle;else high=middle-1;}return low;}
  /* Resizes every page to the zoom, keeping the point under the anchor (or the reading line) still. */
  function resize(anchor=null) {
    if(!pages.length)return;
    const viewport=get('pdfViewport'),at=anchor||{x:viewport.clientWidth/2,y:viewport.clientHeight*.3};
    const target=pages[indexAt(viewport.scrollTop+at.y)],fraction=target?(viewport.scrollTop+at.y-pageTop(target))/Math.max(1,target.el.offsetHeight):0;
    const across=(viewport.scrollLeft+at.x)/Math.max(1,viewport.scrollWidth);
    currentScale=Math.max(.25,Math.min(4,zoom==='fit'||zoom==='page'?fitScale():Number(zoom)||1));
    for(const r of pages){const [width,height]=size(r);r.el.style.width=width*currentScale+'px';r.el.style.height=height*currentScale+'px';r.el.style.setProperty('--pdf-scale',currentScale);}
    viewport.scrollLeft=across*viewport.scrollWidth-at.x;
    if(pin)scrollToPin();else if(target)viewport.scrollTop=pageTop(target)+fraction*target.el.offsetHeight-at.y;
    pages.forEach(decorate);scheduleRender();syncZoom();
  }
  // A page chosen from a link, search result, thumbnail or saved position stays put until the reader scrolls.
  function scrollToPin(){
    const r=pages[pin.number-1],viewport=get('pdfViewport');if(!r)return;
    viewport.scrollTop=Math.max(0,pageTop(r)+pin.offset*r.el.offsetHeight-(pin.offset?pin.at*viewport.clientHeight:8));pin.top=viewport.scrollTop;
  }
  function setCurrent(number,force=false) {
    number=Math.max(1,Math.min(pages.length||1,number));const changed=number!==pageNumber||force;pageNumber=number;
    for(const node of get('pdfPageStack').querySelectorAll('#pdfPageSurface'))node.removeAttribute('id');
    const r=record();if(r)r.el.id='pdfPageSurface';
    get('pdfPageNumber').value=pageNumber;get('pdfPageNumber').max=order().length;get('pdfPageTotal').textContent='/ '+order().length;
    get('pdfPrevPage').disabled=pageNumber<=1;get('pdfNextPage').disabled=pageNumber>=order().length;
    if(changed){rememberPosition();if(r?.data){status(r.data);notify('page');}}
  }
  function status(data){get('pdfReaderStatus').textContent=data.warning||(previewFile?`${previewFile.source} · ${info?.pages||data.pages} pages`:`${data.source} · select text to highlight or quote it`);}
  function onScroll() {
    if(scrollFrame)return;
    scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;if(!pages.length)return;const viewport=get('pdfViewport');
      if(pin&&Math.abs(viewport.scrollTop-pin.top)<=2)return rememberPosition();
      pin=null;
      const bottom=viewport.scrollTop>0&&viewport.scrollHeight>viewport.clientHeight+2&&viewport.scrollTop+viewport.clientHeight>=viewport.scrollHeight-2;
      const number=bottom?pages.length:indexAt(viewport.scrollTop+viewport.clientHeight*.3)+1;
      if(number!==pageNumber){selection=null;updateSelection();setCurrent(number);}else rememberPosition();
    });
  }
  function rememberPosition() {
    clearTimeout(positionTimer);const identity=attachmentId;
    positionTimer=setTimeout(()=>{const r=record();if(!r||identity!==attachmentId)return;const viewport=get('pdfViewport');
      const offset=Math.max(0,Math.min(1,(viewport.scrollTop+8-pageTop(r))/Math.max(1,r.el.offsetHeight)));
      const rows=Object.entries({...stored(POSITIONS,{}),[identity]:{page:r.source,offset:Math.round(offset*1000)/1000,at:Date.now()}});
      keep(POSITIONS,Object.fromEntries(rows.sort((a,b)=>b[1].at-a[1].at).slice(0,300)));
    },300);
  }
  function nearby(entries) {
    for(const entry of entries){const r=entry.target.pdfRecord;if(!r||pages[r.index]!==r)continue;r.near=entry.isIntersecting;
      if(r.near)enqueue(r);else if(r.index!==pageNumber-1)unload(r);}
    pump();
  }
  const wanted=()=>Math.min(4,currentScale*(window.devicePixelRatio||1));
  const needs=r=>!r.data||r.data.rotation!==r.rotation||r.requested<Math.min(wanted()*.9,3.9);
  function enqueue(r){if(!queue.includes(r))queue.push(r);}
  function pump() {
    while(busy<2){
      queue=queue.filter(r=>pages[r.index]===r&&!r.loading&&(r.near||r.waiters.length)&&needs(r));
      if(!queue.length)return;
      queue.sort((a,b)=>Math.abs(a.index-pageNumber+1)-Math.abs(b.index-pageNumber+1));render(queue.shift());
    }
  }
  function scheduleRender(){clearTimeout(renderTimer);renderTimer=setTimeout(()=>{pages.filter(r=>r.near).forEach(enqueue);pump();},140);}
  function ensure(r) {
    if(!r)return Promise.resolve(false);
    if(r.data&&r.data.rotation===r.rotation&&r.el.querySelector(':scope>img'))return Promise.resolve(true);
    return new Promise((resolve,reject)=>{r.waiters.push({resolve,reject});enqueue(r);pump();});
  }
  async function render(r) {
    const token=revision,requested=wanted(),withText=!r.data||r.data.rotation!==r.rotation;busy++;r.loading=true;
    try{
      const data=await request('page',{id:attachmentId,page:r.source,rotation:r.rotation,scale:requested,text:withText});
      if(token!==revision||pages[r.index]!==r)return;
      r.data=withText?data:{...r.data,image:data.image,scale:data.scale};r.requested=requested;
      if(file()&&!file().pages)file().pages=data.pages;
      paint(r,withText);r.waiters.splice(0).forEach(w=>w.resolve(true));
      if(r.index===pageNumber-1&&withText){status(r.data);notify('page');}
    }catch(error){r.waiters.splice(0).forEach(w=>w.reject(error));if(token===revision&&r.index===pageNumber-1)get('pdfReaderStatus').textContent=error.message;}
    finally{busy--;r.loading=false;if(r.near&&needs(r)&&pages[r.index]===r)enqueue(r);pump();}
  }
  function unload(r){if(r.loading||!r.data?.image)return;r.data={...r.data,image:''};r.requested=0;r.el.replaceChildren();}
  function paint(r,fresh) {
    const el=r.el,data=r.data;let img=el.querySelector(':scope>img');
    if(fresh)el.replaceChildren(),img=null;
    if(!img){img=document.createElement('img');img.draggable=false;img.src=data.image;img.onerror=()=>{get('pdfReaderStatus').textContent='The page image could not be displayed. Try reopening the PDF.';};el.prepend(img);}
    else if(img.src!==data.image){const next=new Image(),src=data.image;next.src=src;next.decode().catch(()=>{}).then(()=>{if(r.data?.image===src)img.src=src;});}
    img.alt=`PDF page ${r.index+1}`;
    if(!el.querySelector('.pdf-text-layer')){
      const text=document.createElement('div');text.className='pdf-text-layer';
      for(const word of data.words||[]){const span=document.createElement('span'),[x0,y0,x1,y1]=word.box;
        const origin=word.origin||[x0,y0],width=word.width||x1-x0,height=word.height||y1-y0;
        span.textContent=word.text+' ';span.style.cssText=`left:${origin[0]/data.width*100}%;top:${origin[1]/data.height*100}%;width:${width/data.width*100}%;height:${height/data.height*100}%;font-size:calc(var(--pdf-scale) * ${height*.8}px);transform-origin:0 0;transform:rotate(${Number(word.rotation)||0}deg)`;text.append(span);}
      el.append(text,links(data));
    }
    decorate(r);
  }
  function links(data) {
    const layer=document.createElement('div');layer.className='pdf-link-layer';
    for(const link of data.links||[]){const a=document.createElement('a');a.style.cssText=`left:${link.x*100}%;top:${link.y*100}%;width:${link.width*100}%;height:${link.height*100}%`;
      if(link.url){const href=safeHref(link.url);if(!href)continue;a.href=href;a.rel='noreferrer';a.title=href;
        // Desktop navigation is intercepted by Tauri and opened in the system browser.
        a.target=window.__TAURI__?'_self':'_blank';}
      else{const position=()=>order().indexOf(link.page)+1;a.href='#';a.title='Go to page '+(position()||link.page);
        a.onclick=event=>{event.preventDefault();if(position())navigate(position(),link.targetY||0);else get('pdfReaderStatus').textContent='That page is excluded from the edited copy. Undo the page removal to view it.';};}
      layer.append(a);}
    return layer;
  }
  function decorate(r) {
    const img=r.el.querySelector(':scope>img');if(!img||!r.data)return;
    r.el.querySelector('.pdf-highlights')?.remove();
    const highlights=document.createElement('div');highlights.className='pdf-highlights';
    for(const annotation of paper()?.pdfAnnotations||[]){if(annotation.pdfId!==attachmentId||annotation.page!==r.source)continue;
      if(annotation.kind&&!['highlight','underline','strikeout'].includes(annotation.kind))continue;
      for(const original of annotation.rects||[]){const rect=typeof PulsePDFEditor!=='undefined'?PulsePDFEditor.viewRect(original,r.rotation):original;
        const mark=document.createElement('span');mark.className=annotation.kind||'highlight';mark.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%;--mark-color:${colors[annotation.color]||annotation.color||colors.yellow}`;mark.title=annotation.memo||annotation.quote;highlights.append(mark);}}
    img.after(highlights);
    if(typeof PulsePDFEditor!=='undefined')PulsePDFEditor.paintPage(r);
  }
  function drawPage(){layout();}
  function navigate(number,offset=0) {
    if(!info)return Promise.resolve(false);
    layout();pageNumber=Math.max(1,Math.min(pages.length,number));pin={number:pageNumber,offset,at:.25};selection=null;updateSelection();
    scrollToPin();setCurrent(pageNumber,true);return ensure(record()).catch(()=>false);
  }
  function syncZoom() {
    const select=get('pdfZoom');let custom=select.querySelector('[data-custom]');
    if([...select.options].some(option=>!option.dataset.custom&&option.value===zoom)){if(custom)custom.hidden=true;}
    else{if(!custom){custom=new Option('','');custom.dataset.custom='1';select.add(custom);}custom.value=zoom;custom.textContent=Math.round(Number(zoom)*100)+'%';custom.hidden=false;}
    select.value=zoom;get('pdfZoomOut').disabled=currentScale<=.26;get('pdfZoomIn').disabled=currentScale>=3.99;
  }
  function setZoom(value,anchor=null) {
    zoom=value==='fit'||value==='page'?value:String(Math.round(Math.max(.25,Math.min(4,Number(value)||1))*100)/100);
    keep('pulse-pdf-zoom',zoom);pin=null;resize(anchor);
  }
  function stepZoom(direction,anchor=null){setZoom(direction>0?zoomSteps.find(step=>step>currentScale+.01)||4:[...zoomSteps].reverse().find(step=>step<currentScale-.01)||.25,anchor);}
  function pointerAnchor(event){const box=get('pdfViewport').getBoundingClientRect();return{x:event.clientX-box.left,y:event.clientY-box.top};}
  function onKey(event) {
    if(event.defaultPrevented||event.altKey||!pages.length)return;
    const typing=event.target.closest?.('input,textarea,select,[contenteditable=true]');
    if(event.metaKey||event.ctrlKey){
      const step={'=':1,'+':1,'-':-1,'_':-1}[event.key];
      if(step){event.preventDefault();stepZoom(step);}else if(event.key==='0'){event.preventDefault();setZoom('fit');}
      return;
    }
    if(typing||event.key===' '&&event.target.closest?.('button,a,summary'))return;
    const viewport=get('pdfViewport'),screen=Math.max(40,viewport.clientHeight-40),paged=zoom==='page';
    const scroll=amount=>{pin=null;viewport.scrollBy({top:amount});};
    const action={ArrowRight:()=>navigate(pageNumber+1),ArrowLeft:()=>navigate(pageNumber-1),ArrowDown:()=>scroll(60),ArrowUp:()=>scroll(-60),
      PageDown:()=>paged?navigate(pageNumber+1):scroll(screen),PageUp:()=>paged?navigate(pageNumber-1):scroll(-screen),
      ' ':()=>paged?navigate(pageNumber+(event.shiftKey?-1:1)):scroll(event.shiftKey?-screen:screen),Home:()=>navigate(1),End:()=>navigate(pages.length)}[event.key];
    if(action){event.preventDefault();action();}
  }
  function captureSelection() {
    const selected=window.getSelection(),pageOf=node=>(node?.nodeType===1?node:node?.parentElement)?.closest?.('.pdf-page');
    if(!selected?.rangeCount||selected.isCollapsed)return;
    const surface=pageOf(selected.anchorNode),r=surface?.pdfRecord;if(!r||surface!==pageOf(selected.focusNode)||!get('pdfPageStack').contains(surface))return;
    const quote=selected.toString().replace(/\s+/g,' ').trim();if(!quote)return;
    if(r.index!==pageNumber-1){pin=null;setCurrent(r.index+1);}
    const box=surface.getBoundingClientRect();
    const rects=[...selected.getRangeAt(0).getClientRects()].filter(rect=>rect.width>0&&rect.height>0).slice(0,1000).map(rect=>({x:Math.max(0,(rect.x-box.x)/box.width),y:Math.max(0,(rect.y-box.y)/box.height),width:Math.min(1,rect.width/box.width),height:Math.min(1,rect.height/box.height)}));
    selection={quote,page:r.source,pdfId:attachmentId,rects:typeof PulsePDFEditor!=='undefined'?rects.map(rect=>PulsePDFEditor.canonicalRect(rect,r.rotation)):rects};updateSelection();
    if(typeof PulsePDFEditor!=='undefined')PulsePDFEditor.selectionChanged();
  }
  function updateSelection() {
    get('pdfSelectedQuote').textContent=selection?selection.quote.slice(0,400):'Select text on the page.';
    for(const id of ['pdfSaveHighlight','pdfQuoteNotes','pdfQuoteMatrix'])get(id).disabled=!selection||Boolean(previewFile);
  }
  async function save(kind='highlight') {
    if(!selection||!paper()||previewFile)return;
    const selected={...selection},targetId=paperId,color=get('pdfHighlightColor').value,memo=get('pdfAnnotationMemo').value,section=get('pdfEvidenceColumn').selectedOptions[0].textContent;
    get('pdfReaderStatus').textContent='Verifying selected passage…';
    try {
      const passage=await request('passage',{id:selected.pdfId,page:selected.page,quote:selected.quote,section});
      const p=state.papers.find(row=>row.id===targetId);if(!p)return;
      p.pdfAnnotations ||= [];p.pdfQuotes ||= [];
      if(typeof PulsePDFEditor!=='undefined')PulsePDFEditor.checkpoint();
      const markupKind=selected.kind||(typeof PulsePDFEditor!=='undefined'?PulsePDFEditor.markupKind():'highlight');
      let annotation=p.pdfAnnotations.find(row=>row.pdfId===selected.pdfId&&row.page===selected.page&&row.quote===selected.quote&&(row.kind||'highlight')===markupKind);
      if(!annotation){annotation={id:uid(),...selected,kind:markupKind,color,memo,createdAt:new Date().toISOString()};p.pdfAnnotations.push(annotation);}else if(memo)annotation.memo=memo;
      if(kind==='notes'&&!p.pdfQuotes.some(row=>row.annotationId===annotation.id&&row.kind==='notes')){
        p.notes=(p.notes?p.notes+'\n\n':'')+`[PDF p. ${selected.page}] “${selected.quote}”`+(memo?'\n'+memo:'');
        p.pdfQuotes.push({annotationId:annotation.id,pdfId:selected.pdfId,page:selected.page,quote:selected.quote,kind:'notes'});
      }
      if(kind==='matrix'){
        p.evidencePassages ||= [];const column=get('pdfEvidenceColumn').value;
        p.evidencePassages=p.evidencePassages.filter(row=>!(row.annotationId===annotation.id&&row.evidenceColumn===column));
        p.evidencePassages.push({...passage,annotationId:annotation.id,paperId:targetId,evidenceColumn:column});
        if(!p.pdfQuotes.some(row=>row.annotationId===annotation.id&&row.kind==='matrix'&&row.column===column))p.pdfQuotes.push({annotationId:annotation.id,pdfId:selected.pdfId,page:selected.page,quote:selected.quote,kind:'matrix',column});
      }
      scheduleAutosave();renderDetails();renderAnnotations();drawPage();selection=null;updateSelection();get('pdfAnnotationMemo').value='';
      get('pdfReaderStatus').textContent=kind==='matrix'?'Quote added to the Evidence Matrix source passages. It will appear in this column when you compare this paper.':kind==='notes'?'Quote added to Notes with a page link.':'Highlight saved on this computer.';
    }catch(error){get('pdfReaderStatus').textContent=error.message;}
  }
  function renderAnnotations() {
    if(typeof PulsePDFEditor!=='undefined')return PulsePDFEditor.renderAnnotations();
    const list=get('pdfAnnotations'),rows=(paper()?.pdfAnnotations||[]).filter(row=>row.pdfId===attachmentId);
    list.innerHTML=rows.map(row=>`<article><button type="button" data-annotation-page="${Number(row.page)}">Page ${Number(row.page)}</button><blockquote>${escapeHtml(row.quote)}</blockquote><label>Memo<textarea data-annotation-memo="${escapeHtml(row.id)}" rows="2">${escapeHtml(row.memo||'')}</textarea></label><div><button type="button" data-annotation-notes="${escapeHtml(row.id)}">To notes</button><button type="button" data-annotation-matrix="${escapeHtml(row.id)}">To matrix</button><button type="button" data-annotation-remove="${escapeHtml(row.id)}">Remove highlight</button></div></article>`).join('')||'<p>No highlights in this PDF yet.</p>';
    list.querySelectorAll('[data-annotation-page]').forEach(button=>button.onclick=()=>navigate(order().indexOf(Number(button.dataset.annotationPage))+1));
    list.querySelectorAll('[data-annotation-memo]').forEach(input=>input.onchange=()=>{const row=paper()?.pdfAnnotations.find(a=>a.id===input.dataset.annotationMemo);if(row){row.memo=input.value;scheduleAutosave();}});
    for(const kind of ['notes','matrix'])list.querySelectorAll(`[data-annotation-${kind}]`).forEach(button=>button.onclick=()=>{const row=paper()?.pdfAnnotations.find(a=>a.id===button.dataset[kind==='notes'?'annotationNotes':'annotationMatrix']);if(row){selection={...row};updateSelection();save(kind);}});
    list.querySelectorAll('[data-annotation-remove]').forEach(button=>button.onclick=()=>{const p=paper(),index=p.pdfAnnotations.findIndex(a=>a.id===button.dataset.annotationRemove);undo={paperId:p.id,annotation:p.pdfAnnotations[index],index};p.pdfAnnotations.splice(index,1);get('pdfUndoAnnotation').disabled=false;scheduleAutosave();drawPage();renderAnnotations();});
  }
  function linksMarkup(p) {
    const quotes=p.pdfQuotes||[];if(!quotes.length)return '';
    return '<section class="insp-section"><h3 class="insp-label">PDF quotations</h3>'+quotes.map(row=>`<button type="button" class="insp-btn block" data-pdf-paper="${escapeHtml(p.id)}" data-pdf-id="${escapeHtml(row.pdfId)}" data-open-pdf-page="${Number(row.page)}">Page ${Number(row.page)} · ${escapeHtml(row.quote.slice(0,80))}</button>`).join('')+'</section>';
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const dialog=document.createElement('dialog');dialog.id='pdfReaderDialog';dialog.className='pulse-tool-dialog pdf-reader';
    dialog.innerHTML='<header><h2 id="pdfReaderTitle">PDF reader</h2><button id="pdfReaderClose" type="button" aria-label="Close PDF reader">×</button></header><div class="pdf-access-bar"><span id="pdfReadMode" class="pdf-mode-badge">PDF reader</span><a id="pdfSourceLink" target="_blank" rel="noreferrer" hidden>PDF source</a><button id="pdfDownloadCopy" type="button" hidden>Download &amp; annotate</button></div><p id="pdfPreviewNotice" class="pdf-preview-notice" hidden>This is a preview. Download a local copy to add highlights, memos and quotations.</p><div class="pdf-toolbar"><button id="pdfFindOpen" type="button">Find open PDF</button><label class="pdf-attach-button">Attach PDF<input id="pdfAttachInput" type="file" accept="application/pdf,.pdf"></label><select id="pdfAttachmentSelect" aria-label="PDF attachment"></select><button id="pdfPrevPage" type="button" aria-label="Previous PDF page" title="Previous page (←)">←</button><label>Page <input id="pdfPageNumber" type="number" value="1" min="1" aria-label="PDF page"></label><span id="pdfPageTotal"></span><button id="pdfNextPage" type="button" aria-label="Next PDF page" title="Next page (→)">→</button><span class="pdf-zoom-controls"><button id="pdfZoomOut" type="button" aria-label="Zoom out" title="Zoom out (Cmd/Ctrl −)">−</button><select id="pdfZoom" aria-label="PDF zoom"><option value="fit">Fit width</option><option value="page">Fit page</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option></select><button id="pdfZoomIn" type="button" aria-label="Zoom in" title="Zoom in (Cmd/Ctrl +)">+</button></span><button id="pdfUndoAnnotation" type="button" disabled>Undo remove</button></div><p id="pdfReaderStatus" role="status"></p><div class="pdf-reader-body"><div id="pdfViewport" class="pdf-viewport" tabindex="0" aria-label="PDF pages"><div id="pdfPageStack" class="pdf-page-stack"></div></div><aside id="pdfAnnotationSidebar" class="pdf-sidebar"><h3>Highlight &amp; quote</h3><blockquote id="pdfSelectedQuote">Select text on the page.</blockquote><label>Colour<select id="pdfHighlightColor"><option value="yellow">Yellow</option><option value="green">Green</option><option value="blue">Blue</option><option value="pink">Pink</option></select></label><label>Memo<textarea id="pdfAnnotationMemo" rows="2" maxlength="20000"></textarea></label><button id="pdfSaveHighlight" type="button" disabled>Save highlight</button><button id="pdfQuoteNotes" type="button" disabled>Quote to Notes</button><label>Evidence column<select id="pdfEvidenceColumn"><option value="finding">Finding</option><option value="method">Method</option><option value="limitation">Limitation</option><option value="system">Study system</option><option value="aim">Aim</option></select></label><button id="pdfQuoteMatrix" type="button" disabled>Quote to Evidence Matrix</button><h3>Saved highlights</h3><div id="pdfAnnotations"></div></aside></div>';
    document.body.append(dialog);get('pdfReaderClose').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{if(dialog.open)return;lookupController?.abort();openRevision++;revision++;selection=null;clearPages();});
    get('pdfFindOpen').onclick=findOpenPDF;get('pdfDownloadCopy').onclick=downloadCopy;
    get('pdfAttachInput').onchange=event=>attach(event.target.files[0]);get('pdfAttachmentSelect').onchange=()=>{lookupController?.abort();openRevision++;get('pdfFindOpen').disabled=false;attachmentId=get('pdfAttachmentSelect').value;if(previewFile?.id!==attachmentId)previewFile=null;displayMode();loadDocument();};
    get('pdfPrevPage').onclick=()=>navigate(pageNumber-1);get('pdfNextPage').onclick=()=>navigate(pageNumber+1);
    get('pdfPageNumber').onchange=()=>navigate(Number(get('pdfPageNumber').value)||1);
    get('pdfZoom').onchange=()=>setZoom(get('pdfZoom').value);get('pdfZoomIn').onclick=()=>stepZoom(1);get('pdfZoomOut').onclick=()=>stepZoom(-1);syncZoom();
    const viewport=get('pdfViewport'),stack=get('pdfPageStack');
    viewport.addEventListener('scroll',onScroll,{passive:true});
    // Trackpad pinches arrive as Ctrl+wheel in Chromium and as gesture events in WebKit.
    viewport.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey){pin=null;return;}event.preventDefault();setZoom(currentScale*Math.exp(-event.deltaY*.01),pointerAnchor(event));},{passive:false});
    viewport.addEventListener('touchmove',()=>{pin=null;},{passive:true});
    viewport.addEventListener('gesturestart',event=>{event.preventDefault();gestureBase=currentScale;});
    viewport.addEventListener('gesturechange',event=>{event.preventDefault();setZoom(gestureBase*event.scale,pointerAnchor(event));});
    dialog.addEventListener('keydown',onKey);
    stack.addEventListener('mouseup',captureSelection);stack.addEventListener('keyup',captureSelection);
    get('pdfSaveHighlight').onclick=()=>save();get('pdfQuoteNotes').onclick=()=>save('notes');get('pdfQuoteMatrix').onclick=()=>save('matrix');
    get('pdfUndoAnnotation').onclick=()=>{const p=state.papers.find(row=>row.id===undo?.paperId);if(p){p.pdfAnnotations.splice(undo.index,0,undo.annotation);undo=null;get('pdfUndoAnnotation').disabled=true;scheduleAutosave();drawPage();renderAnnotations();}};
    document.addEventListener('click',event=>{const button=event.target.closest('[data-open-pdf-page],[data-read-pdf]');if(button)open(button.dataset.pdfPaper||state.selectedId,Number(button.dataset.openPdfPage)||null,button.dataset.pdfId);});
  });
  return {open,store,linksMarkup,request,drawPage,renderAnnotations,save,navigate,
    loadPage:()=>navigate(pageNumber),
    context:()=>({paper:paper(),paperId,attachmentId,pageNumber,sourcePage:sourcePage(),pageData:record()?.data||null,selection,preview:!!previewFile,file:file(),order:order(),rotation:rotation(),open:!!root()?.open,outline,scale:currentScale}),
    renderedPages:()=>pages.filter(r=>r.data&&r.el.querySelector(':scope>img')),
    pageFor:element=>element?.closest?.('.pdf-page')?.pdfRecord||null,
    focusPage:number=>{if(number!==pageNumber){pin=null;setCurrent(number);}},
    chooseAnnotation:row=>{selection={...row};updateSelection();},
    updateMode:displayMode};
})();
