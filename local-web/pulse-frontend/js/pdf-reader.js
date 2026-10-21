/* Local page images plus a selectable text layer; annotations stay in the library. */
const PulsePDF = (() => {
  let paperId=null,attachmentId=null,pageNumber=1,pageData=null,selection=null,revision=0,undo=null;
  const cache=new Map(),colors={yellow:'#ffe66b',green:'#92e5aa',blue:'#8bc9ff',pink:'#f7a3d2'};
  const paper=()=>state.papers.find(p=>p.id===paperId),root=()=>document.getElementById('pdfReaderDialog');
  const get=id=>document.getElementById(id);
  async function request(endpoint,payload) {
    await backendReady;
    const response=await fetch(backendUrl('/api/reader/'+endpoint),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload)});
    const data=await response.json();if(!response.ok)throw Error(data.error||'PDF request failed.');return data;
  }
  async function store(name,buffer){return request('attach',{name,contentBase64:arrayBufferToBase64(buffer)});}
  async function open(id,page=1,pdfId=null) {
    paperId=id;const p=paper();if(!p)return showToast('This paper is no longer in the library.');
    attachmentId=pdfId||(p.pdfAttachments||[])[0]?.id||null;pageNumber=Number(page)||1;selection=null;pageData=null;revision++;
    get('pdfReaderTitle').textContent=p.title;
    get('pdfAttachmentSelect').innerHTML=(p.pdfAttachments||[]).map(file=>`<option value="${escapeHtml(file.id)}">${escapeHtml(file.name)}</option>`).join('');
    get('pdfAttachmentSelect').value=attachmentId||'';
    if(!root().open)root().showModal();
    await loadPage();
  }
  async function attach(file) {
    if(!file||!paper())return;
    const id=paperId;get('pdfReaderStatus').textContent='Attaching PDF…';get('pdfAttachInput').disabled=true;
    try{const attachment=await store(file.name,await file.arrayBuffer()),p=state.papers.find(row=>row.id===id);if(!p)return;
      p.pdfAttachments ||= [];if(!p.pdfAttachments.some(row=>row.id===attachment.id))p.pdfAttachments.push(attachment);
      scheduleAutosave();if(paperId===id)await open(id,1,attachment.id);renderDetails();
    }catch(error){get('pdfReaderStatus').textContent=error.message;}finally{get('pdfAttachInput').disabled=false;get('pdfAttachInput').value='';}
  }
  async function loadPage() {
    const token=++revision;selection=null;updateSelection();
    get('pdfPageSurface').replaceChildren();get('pdfReaderStatus').textContent=attachmentId?'Loading page…':'Attach a local PDF to read and annotate it here. PDFs stay on this computer.';
    get('pdfPrevPage').disabled=true;get('pdfNextPage').disabled=true;
    if(!attachmentId){renderAnnotations();return;}
    try {
      const key=attachmentId+':'+pageNumber;
      const data=cache.get(key)||await request('page',{id:attachmentId,page:pageNumber,scale:1.4});
      if(token!==revision)return;
      cache.set(key,data);while(cache.size>3)cache.delete(cache.keys().next().value);
      pageData=data;pageNumber=data.page;get('pdfPageNumber').value=pageNumber;get('pdfPageNumber').max=data.pages;
      get('pdfPageTotal').textContent='/ '+data.pages;get('pdfPrevPage').disabled=pageNumber<=1;get('pdfNextPage').disabled=pageNumber>=data.pages;
      get('pdfReaderStatus').textContent=data.warning||`${data.source} · select text to highlight or quote it`;
      drawPage();renderAnnotations();
    }catch(error){if(token===revision)get('pdfReaderStatus').textContent=error.message;}
  }
  function drawPage() {
    if(!pageData)return;
    const surface=get('pdfPageSurface'),viewport=get('pdfViewport'),choice=get('pdfZoom').value;
    const scale=choice==='fit'?Math.max(.25,Math.min(2,(viewport.clientWidth-40)/pageData.width)):Number(choice);
    surface.style.width=pageData.width*scale+'px';surface.style.height=pageData.height*scale+'px';surface.replaceChildren();
    const img=document.createElement('img');img.src=pageData.image;img.alt=`PDF page ${pageNumber}`;img.draggable=false;surface.append(img);
    const highlights=document.createElement('div');highlights.className='pdf-highlights';
    for(const annotation of paper()?.pdfAnnotations||[]){if(annotation.pdfId!==attachmentId||annotation.page!==pageNumber)continue;
      for(const rect of annotation.rects||[]){const mark=document.createElement('span');mark.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%;background:${colors[annotation.color]||colors.yellow}`;mark.title=annotation.memo||annotation.quote;highlights.append(mark);}}
    surface.append(highlights);
    const text=document.createElement('div');text.className='pdf-text-layer';
    for(const word of pageData.words){const span=document.createElement('span'),[x0,y0,x1,y1]=word.box;
      const origin=word.origin||[x0,y0],width=word.width||x1-x0,height=word.height||y1-y0;
      span.textContent=word.text+' ';span.style.cssText=`left:${origin[0]/pageData.width*100}%;top:${origin[1]/pageData.height*100}%;width:${width/pageData.width*100}%;height:${height/pageData.height*100}%;font-size:${height*scale*.8}px;transform-origin:0 0;transform:rotate(${Number(word.rotation)||0}deg)`;text.append(span);}
    surface.append(text);viewport.scrollTop=0;
  }
  function captureSelection() {
    const selected=window.getSelection(),surface=get('pdfPageSurface');
    if(!selected?.rangeCount||selected.isCollapsed||!surface.contains(selected.anchorNode)||!surface.contains(selected.focusNode))return;
    const quote=selected.toString().replace(/\s+/g,' ').trim();if(!quote)return;
    const box=surface.getBoundingClientRect();
    const rects=[...selected.getRangeAt(0).getClientRects()].filter(rect=>rect.width>0&&rect.height>0).slice(0,1000).map(rect=>({x:Math.max(0,(rect.x-box.x)/box.width),y:Math.max(0,(rect.y-box.y)/box.height),width:Math.min(1,rect.width/box.width),height:Math.min(1,rect.height/box.height)}));
    selection={quote,page:pageNumber,pdfId:attachmentId,rects};updateSelection();
  }
  function updateSelection() {
    get('pdfSelectedQuote').textContent=selection?selection.quote.slice(0,400):'Select text on the page.';
    for(const id of ['pdfSaveHighlight','pdfQuoteNotes','pdfQuoteMatrix'])get(id).disabled=!selection;
  }
  async function save(kind='highlight') {
    if(!selection||!paper())return;
    const selected={...selection},targetId=paperId,color=get('pdfHighlightColor').value,memo=get('pdfAnnotationMemo').value,section=get('pdfEvidenceColumn').selectedOptions[0].textContent;
    get('pdfReaderStatus').textContent='Verifying selected passage…';
    try {
      const passage=await request('passage',{id:selected.pdfId,page:selected.page,quote:selected.quote,section});
      const p=state.papers.find(row=>row.id===targetId);if(!p)return;
      p.pdfAnnotations ||= [];p.pdfQuotes ||= [];
      let annotation=p.pdfAnnotations.find(row=>row.pdfId===selected.pdfId&&row.page===selected.page&&row.quote===selected.quote);
      if(!annotation){annotation={id:uid(),...selected,color,memo,createdAt:new Date().toISOString()};p.pdfAnnotations.push(annotation);}else if(memo)annotation.memo=memo;
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
    const list=get('pdfAnnotations'),rows=(paper()?.pdfAnnotations||[]).filter(row=>row.pdfId===attachmentId);
    list.innerHTML=rows.map(row=>`<article><button type="button" data-annotation-page="${Number(row.page)}">Page ${Number(row.page)}</button><blockquote>${escapeHtml(row.quote)}</blockquote><label>Memo<textarea data-annotation-memo="${escapeHtml(row.id)}" rows="2">${escapeHtml(row.memo||'')}</textarea></label><div><button type="button" data-annotation-notes="${escapeHtml(row.id)}">To notes</button><button type="button" data-annotation-matrix="${escapeHtml(row.id)}">To matrix</button><button type="button" data-annotation-remove="${escapeHtml(row.id)}">Remove highlight</button></div></article>`).join('')||'<p>No highlights in this PDF yet.</p>';
    list.querySelectorAll('[data-annotation-page]').forEach(button=>button.onclick=()=>{pageNumber=Number(button.dataset.annotationPage);loadPage();});
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
    dialog.innerHTML='<header><h2 id="pdfReaderTitle">PDF reader</h2><button id="pdfReaderClose" type="button" aria-label="Close PDF reader">×</button></header><div class="pdf-toolbar"><label class="pdf-attach-button">Attach PDF<input id="pdfAttachInput" type="file" accept="application/pdf,.pdf"></label><select id="pdfAttachmentSelect" aria-label="PDF attachment"></select><button id="pdfPrevPage" type="button" aria-label="Previous PDF page">←</button><label>Page <input id="pdfPageNumber" type="number" value="1" min="1" aria-label="PDF page"></label><span id="pdfPageTotal"></span><button id="pdfNextPage" type="button" aria-label="Next PDF page">→</button><select id="pdfZoom" aria-label="PDF zoom"><option value="fit">Fit width</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select><button id="pdfUndoAnnotation" type="button" disabled>Undo remove</button></div><p id="pdfReaderStatus" role="status"></p><div class="pdf-reader-body"><div id="pdfViewport" class="pdf-viewport"><div id="pdfPageSurface" class="pdf-page"></div></div><aside class="pdf-sidebar"><h3>Highlight &amp; quote</h3><blockquote id="pdfSelectedQuote">Select text on the page.</blockquote><label>Colour<select id="pdfHighlightColor"><option value="yellow">Yellow</option><option value="green">Green</option><option value="blue">Blue</option><option value="pink">Pink</option></select></label><label>Memo<textarea id="pdfAnnotationMemo" rows="2" maxlength="20000"></textarea></label><button id="pdfSaveHighlight" type="button" disabled>Save highlight</button><button id="pdfQuoteNotes" type="button" disabled>Quote to Notes</button><label>Evidence column<select id="pdfEvidenceColumn"><option value="finding">Finding</option><option value="method">Method</option><option value="limitation">Limitation</option><option value="system">Study system</option><option value="aim">Aim</option></select></label><button id="pdfQuoteMatrix" type="button" disabled>Quote to Evidence Matrix</button><h3>Saved highlights</h3><div id="pdfAnnotations"></div></aside></div>';
    document.body.append(dialog);get('pdfReaderClose').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{revision++;selection=null;pageData=null;cache.clear();get('pdfPageSurface').replaceChildren();});
    get('pdfAttachInput').onchange=event=>attach(event.target.files[0]);get('pdfAttachmentSelect').onchange=()=>{attachmentId=get('pdfAttachmentSelect').value;pageNumber=1;loadPage();};
    get('pdfPrevPage').onclick=()=>{pageNumber--;loadPage();};get('pdfNextPage').onclick=()=>{pageNumber++;loadPage();};
    get('pdfPageNumber').onchange=()=>{pageNumber=Math.max(1,Math.min(pageData?.pages||1,Number(get('pdfPageNumber').value)||1));loadPage();};get('pdfZoom').onchange=drawPage;
    get('pdfPageSurface').addEventListener('mouseup',captureSelection);get('pdfPageSurface').addEventListener('keyup',captureSelection);
    get('pdfSaveHighlight').onclick=()=>save();get('pdfQuoteNotes').onclick=()=>save('notes');get('pdfQuoteMatrix').onclick=()=>save('matrix');
    get('pdfUndoAnnotation').onclick=()=>{const p=state.papers.find(row=>row.id===undo?.paperId);if(p){p.pdfAnnotations.splice(undo.index,0,undo.annotation);undo=null;get('pdfUndoAnnotation').disabled=true;scheduleAutosave();drawPage();renderAnnotations();}};
    document.addEventListener('click',event=>{const button=event.target.closest('[data-open-pdf-page],[data-read-pdf]');if(button)open(button.dataset.pdfPaper||state.selectedId,Number(button.dataset.openPdfPage)||1,button.dataset.pdfId);});
  });
  return {open,store,linksMarkup};
})();
