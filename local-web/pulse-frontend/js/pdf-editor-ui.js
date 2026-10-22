/* Reader chrome and non-destructive local editing, backed by actual PDF export. */
const PulsePDFEditor=(()=>{
  const el=id=>document.getElementById(id),ctx=()=>PulsePDF.context();
  const palette={yellow:'#ffe66b',green:'#92e5aa',blue:'#3f8cf2',pink:'#f7a3d2',red:'#d92e2e',black:'#202027'};
  let tool='select',workspace='read',identity='',history=[],future=[],placement=null,drawing=null,exporting=false;
  let thumbsKey='',thumbObserver=null,thumbQueue=[],thumbBusy=0,thumbRevision=0,thumbLimit=100,searchController=null,searchResults=[],searchIndex=-1;
  const thumbnailCache=new Map();
  function editable(){const c=ctx();return c.open&&c.attachmentId&&!c.preview&&!!c.paper;}
  function snapshot(){const c=ctx();return JSON.parse(JSON.stringify({annotations:(c.paper?.pdfAnnotations||[]).filter(r=>r.pdfId===c.attachmentId),editor:c.file?.editor||null}));}
  function checkpoint(){if(!editable())return;history.push(snapshot());if(history.length>30)history.shift();future=[];syncHistory();}
  function syncHistory(){el('pdfUndoAnnotation').disabled=!history.length;el('pdfRedo').disabled=!future.length;}
  function changed(reload=false,page=ctx().pageNumber){scheduleAutosave();renderDetails();renderAnnotations();syncHistory();if(reload)PulsePDF.navigate(Math.min(page,ctx().order.length));else PulsePDF.drawPage();}
  function restore(from,to){if(!editable()||!from.length)return;to.push(snapshot());const previous=from.pop(),c=ctx();c.paper.pdfAnnotations=[...(c.paper.pdfAnnotations||[]).filter(r=>r.pdfId!==c.attachmentId),...previous.annotations];if(previous.editor)c.file.editor=previous.editor;else delete c.file.editor;placement=null;changed(true);}
  function transform(p,angle){return angle===90?{x:1-p.y,y:p.x}:angle===180?{x:1-p.x,y:1-p.y}:angle===270?{x:p.y,y:1-p.x}:{...p};}
  function viewPoint(point){return transform(point,ctx().rotation);}
  function canonicalPoint(point){return transform(point,(360-ctx().rotation)%360);}
  function transformRect(rect,angle){const points=[transform({x:rect.x,y:rect.y},angle),transform({x:rect.x+rect.width,y:rect.y+rect.height},angle)];return{x:Math.min(points[0].x,points[1].x),y:Math.min(points[0].y,points[1].y),width:Math.abs(points[1].x-points[0].x),height:Math.abs(points[1].y-points[0].y)};}
  const viewRect=rect=>transformRect(rect,ctx().rotation),canonicalRect=rect=>transformRect(rect,(360-ctx().rotation)%360);
  function status(text){el('pdfReaderStatus').textContent=text;}
  function mode(value){workspace=value;el('pdfReaderDialog').dataset.workspace=value;document.querySelectorAll('[data-pdf-workspace]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.pdfWorkspace===value)));
    document.querySelectorAll('[data-pdf-tools]').forEach(group=>group.hidden=group.dataset.pdfTools!==value);
    el('pdfAnnotationSidebar').hidden=!editable()||value==='read'||value==='pages';
    if(value==='read'||value==='pages')setTool('select');
  }
  function setTool(value){tool=editable()?value:'select';el('pdfPageSurface').dataset.tool=tool;placement=null;
    if(['text','ink','rectangle'].includes(tool)&&el('pdfHighlightColor').value==='yellow')el('pdfHighlightColor').value=tool==='text'?'black':'blue';
    document.querySelectorAll('[data-pdf-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.pdfTool===tool)));
    el('pdfPlacementTools').hidden=!['text','note'].includes(tool);el('pdfTextTools').hidden=tool!=='text';
    el('pdfPlaceMark').textContent=tool==='text'?'Add text box':'Add comment';
    if(['text','note','ink','rectangle'].includes(tool))status({text:'Click the page, enter text in the sidebar, then choose Add text box.',note:'Click the page, write a memo, then choose Add comment.',ink:'Draw on the page. Each stroke can be undone.',rectangle:'Drag on the page to draw a rectangle.'}[tool]);
    if(['highlight','underline','strikeout'].includes(tool)&&ctx().selection)PulsePDF.save();
  }
  function onState(){const c=ctx(),key=[c.paperId,c.attachmentId,c.preview].join(':');
    if(key!==identity){identity=key;history=[];future=[];placement=null;drawing=null;thumbsKey='';thumbLimit=100;thumbRevision++;thumbQueue=[];searchResults=[];searchIndex=-1;el('pdfSearchResults').replaceChildren();searchController?.abort();setTool('select');mode(c.preview||!c.attachmentId?'read':'comment');}
    if(!c.file){const href=safeHref(c.paper?.url||(c.paper?.doi?'https://doi.org/'+c.paper.doi:''));el('pdfSourceLink').href=href||'#';el('pdfSourceLink').hidden=!href;el('pdfSourceLink').textContent='Open source page';}
    el('pdfExportEdited').disabled=!editable()||exporting;el('pdfSearchText').disabled=!c.attachmentId;el('pdfRunSearch').disabled=!c.attachmentId;
    document.querySelectorAll('[data-pdf-edit]').forEach(b=>b.disabled=!editable());
    el('pdfEmptyView').hidden=!!c.attachmentId;el('pdfEmptyView').querySelector('h3').textContent='Open a PDF in Pulse';
    syncHistory();
  }
  function editor(){const c=ctx();c.file.editor ||= {pageOrder:[...c.order],rotations:{}};c.file.editor.rotations ||= {};return c.file.editor;}
  function pageEdit(action){if(!editable())return;const c=ctx();if(action==='remove'&&c.order.length===1)return status('Keep at least one page in the edited copy.');
    if(action==='earlier'&&c.pageNumber===1||action==='later'&&c.pageNumber===c.order.length)return;
    checkpoint();const e=editor(),source=c.sourcePage,index=c.pageNumber-1;let destination=c.pageNumber;
    if(action==='rotate-left'||action==='rotate-right')e.rotations[source]=((e.rotations[source]||0)+(action==='rotate-left'?270:90))%360;
    else if(action==='remove')e.pageOrder.splice(index,1);
    else{const other=index+(action==='earlier'?-1:1);[e.pageOrder[index],e.pageOrder[other]]=[e.pageOrder[other],e.pageOrder[index]];destination=other+1;}
    thumbsKey='';changed(true,destination);status('Page change saved in Pulse. Export edited PDF to create the updated file.');
  }
  function addMark(mark){if(!editable())return;checkpoint();const c=ctx();c.paper.pdfAnnotations ||= [];c.paper.pdfAnnotations.push({id:uid(),pdfId:c.attachmentId,page:c.sourcePage,color:el('pdfHighlightColor').value,createdAt:new Date().toISOString(),...mark});placement=null;changed();status('Edit saved in Pulse. Export edited PDF to include it in a PDF file.');}
  function pagePoint(event){const box=el('pdfPageSurface').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-box.x)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.y)/box.height))};}
  function pointerDown(event){if(!editable()||!ctx().pageData||!['ink','rectangle','text','note'].includes(tool)||event.button!==0)return;
    event.preventDefault();window.getSelection()?.removeAllRanges();const p=pagePoint(event);
    if(tool==='text'||tool==='note'){placement=canonicalPoint(p);el(tool==='text'?'pdfTextValue':'pdfAnnotationMemo').focus();status('Placement selected. Enter '+(tool==='text'?'text':'a memo')+' in the sidebar.');return;}
    drawing={start:p,points:[p],tool};el('pdfPageSurface').setPointerCapture(event.pointerId);
  }
  function pointerMove(event){if(!drawing)return;const p=pagePoint(event);drawing.points.push(p);if(drawing.points.length>2000)drawing.points.splice(1,1);paintDraft();}
  function pointerUp(event){if(!drawing)return;const draft=drawing;draft.points.push(pagePoint(event));drawing=null;
    if(draft.tool==='ink'&&draft.points.length>1)addMark({kind:'ink',points:draft.points.map(canonicalPoint),strokeWidth:Number(el('pdfStrokeWidth').value)});
    else{const a=draft.start,b=draft.points.at(-1),rect=canonicalRect({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)});if(rect.width>.002&&rect.height>.002)addMark({kind:'rectangle',rect,strokeWidth:Number(el('pdfStrokeWidth').value)});else paintDraft();}
  }
  function placeMark(){if(!editable()||!placement)return status('Click the page to choose a position first.');
    if(tool==='note'){const memo=el('pdfAnnotationMemo').value.trim();if(!memo)return status('Write a memo before adding a comment.');addMark({kind:'note',point:placement,memo});el('pdfAnnotationMemo').value='';}
    else{const text=el('pdfTextValue').value.trim();if(!text)return status('Enter text to add to the page.');const x=Math.min(.9,placement.x),y=Math.min(.94,placement.y);addMark({kind:'text',text,rect:{x,y,width:Math.min(.4,1-x),height:Math.min(.12,1-y)},fontSize:Number(el('pdfTextSize').value)});el('pdfTextValue').value='';}
  }
  function paintDraft(){const c=ctx(),surface=el('pdfPageSurface');if(!c.pageData)return;
    surface.querySelector('.pdf-editor-layer')?.remove();const layer=document.createElement('div');layer.className='pdf-editor-layer';
    for(const mark of c.paper?.pdfAnnotations||[]){if(mark.pdfId!==c.attachmentId||mark.page!==c.sourcePage)continue;
      const color=palette[mark.color]||palette.blue;
      if(mark.kind==='ink'){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 1000');svg.setAttribute('preserveAspectRatio','none');const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',mark.points.map(viewPoint).map(p=>`${p.x*1000},${p.y*1000}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke',color);line.setAttribute('stroke-width',String((mark.strokeWidth||2)*1000/c.pageData.width));svg.append(line);layer.append(svg);}
      else if(mark.kind==='note'){const point=viewPoint(mark.point),note=document.createElement('span');note.className='pdf-note-pin';note.style.left=point.x*100+'%';note.style.top=point.y*100+'%';note.textContent='●';note.title=mark.memo;layer.append(note);}
      else if(mark.rect){const rect=viewRect(mark.rect),box=document.createElement('span');box.className='pdf-edit-'+mark.kind;box.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%;color:${color};--edit-stroke:${mark.strokeWidth||2}px`;
        if(mark.kind==='text'){const inner=document.createElement('span'),angle=c.rotation,w=rect.width*surface.clientWidth,h=rect.height*surface.clientHeight;inner.textContent=mark.text;inner.style.width=(angle%180?h:w)+'px';inner.style.height=(angle%180?w:h)+'px';inner.style.transform=angle===90?`translateX(${w}px) rotate(90deg)`:angle===180?`translate(${w}px,${h}px) rotate(180deg)`:angle===270?`translateY(${h}px) rotate(270deg)`:'none';box.append(inner);box.style.fontSize=(mark.fontSize||12)*surface.clientWidth/c.pageData.width+'px';}layer.append(box);}
    }
    if(drawing){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 1000');svg.setAttribute('preserveAspectRatio','none');const shape=document.createElementNS(svg.namespaceURI,drawing.tool==='ink'?'polyline':'rect');
      if(drawing.tool==='ink')shape.setAttribute('points',drawing.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '));
      else{const a=drawing.start,b=drawing.points.at(-1);for(const [key,value] of Object.entries({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)}))shape.setAttribute(key,String(value*1000));}
      shape.setAttribute('fill','none');shape.setAttribute('stroke',palette[el('pdfHighlightColor').value]||palette.blue);shape.setAttribute('stroke-width','3');svg.append(shape);layer.append(svg);}
    if(searchIndex>=0&&searchResults[searchIndex]?.page===c.sourcePage){const rect=viewRect(searchResults[searchIndex].rect),match=document.createElement('span');match.className='pdf-search-match';match.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%`;layer.append(match);}
    surface.append(layer);surface.dataset.tool=tool;
  }
  function renderAnnotations(){const c=ctx(),rows=(c.paper?.pdfAnnotations||[]).filter(row=>row.pdfId===c.attachmentId),list=el('pdfAnnotations');if(!list)return;
    list.innerHTML=rows.map(row=>`<article><div class="pdf-comment-heading"><button type="button" data-annotation-page="${Number(row.page)}">Page ${Number(row.page)}</button><span>${escapeHtml(({ink:'Pen drawing',rectangle:'Rectangle',text:'Text box',note:'Comment',underline:'Underline',strikeout:'Strikethrough'})[row.kind]||'Highlight')}</span></div><blockquote>${escapeHtml(row.quote||row.text||row.memo||'Page markup')}</blockquote><label>Memo<textarea data-annotation-memo="${escapeHtml(row.id)}" rows="2">${escapeHtml(row.memo||'')}</textarea></label><div>${row.quote?`<button type="button" data-annotation-notes="${escapeHtml(row.id)}">To notes</button><button type="button" data-annotation-matrix="${escapeHtml(row.id)}">To matrix</button>`:''}<button type="button" data-annotation-remove="${escapeHtml(row.id)}">Remove</button></div></article>`).join('')||'<p class="pdf-no-comments">Your highlights and comments will appear here.</p>';
    for(const b of list.querySelectorAll('[data-annotation-page]'))b.onclick=()=>{const position=ctx().order.indexOf(Number(b.dataset.annotationPage));if(position>=0)PulsePDF.navigate(position+1);else status('This source page is excluded from the edited copy. Undo the page removal to view it.');};
    for(const input of list.querySelectorAll('[data-annotation-memo]'))input.onchange=()=>{const row=ctx().paper?.pdfAnnotations.find(r=>r.id===input.dataset.annotationMemo);if(row){checkpoint();row.memo=input.value;scheduleAutosave();}};
    for(const kind of ['notes','matrix'])for(const b of list.querySelectorAll(`[data-annotation-${kind}]`))b.onclick=()=>{const row=ctx().paper?.pdfAnnotations.find(r=>r.id===b.dataset[kind==='notes'?'annotationNotes':'annotationMatrix']);if(row){PulsePDF.chooseAnnotation(row);PulsePDF.save(kind);}};
    for(const b of list.querySelectorAll('[data-annotation-remove]'))b.onclick=()=>{checkpoint();ctx().paper.pdfAnnotations=ctx().paper.pdfAnnotations.filter(r=>r.id!==b.dataset.annotationRemove);changed();};
    el('pdfCommentCount').textContent=String(rows.length);syncHistory();
  }
  async function thumbnailWork(){if(thumbBusy>=2||!thumbQueue.length)return;const job=thumbQueue.shift();thumbBusy++;const c=ctx(),key=c.attachmentId+':'+job.page+':'+(c.file?.editor?.rotations?.[job.page]||0),revision=thumbRevision;
    try{let image=thumbnailCache.get(key);if(!image){const data=await PulsePDF.request('page',{id:c.attachmentId,page:job.page,rotation:c.file?.editor?.rotations?.[job.page]||0,scale:.18,thumbnail:true});image=data.image;thumbnailCache.set(key,image);while(thumbnailCache.size>80)thumbnailCache.delete(thumbnailCache.keys().next().value);}
      if(revision===thumbRevision&&job.button.isConnected){const img=document.createElement('img');img.src=image;img.alt='Page '+job.number;job.button.prepend(img);job.button.classList.remove('is-loading');}}
    catch{if(job.button.isConnected)job.button.classList.add('is-unavailable');}finally{thumbBusy--;thumbnailWork();}
    thumbnailWork();
  }
  function thumbnails(){const c=ctx();if(!c.attachmentId||!c.pageData)return;const key=c.attachmentId+':'+thumbLimit+':'+c.order.join(',')+':'+JSON.stringify(c.file?.editor?.rotations||{});
    if(key!==thumbsKey){thumbsKey=key;thumbRevision++;thumbQueue=[];thumbObserver?.disconnect();const list=el('pdfThumbnails');list.replaceChildren();
      thumbObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){thumbObserver.unobserve(entry.target);thumbQueue.push({button:entry.target,page:Number(entry.target.dataset.sourcePage),number:Number(entry.target.dataset.pdfPage)});}thumbnailWork();thumbnailWork();},{root:el('pdfPagesPane'),rootMargin:'150px'});
      c.order.slice(0,thumbLimit).forEach((page,index)=>{const button=document.createElement('button');button.type='button';button.className='pdf-thumbnail is-loading';button.dataset.pdfPage=index+1;button.dataset.sourcePage=page;button.setAttribute('aria-label','Go to PDF page '+(index+1));const label=document.createElement('span');label.textContent=index+1;button.append(label);button.onclick=()=>PulsePDF.navigate(index+1);list.append(button);thumbObserver.observe(button);});
      if(c.order.length>thumbLimit){const more=document.createElement('button');more.type='button';more.textContent='Load more pages';more.onclick=()=>{thumbLimit+=100;thumbnails();};list.append(more);}}
    el('pdfThumbnails').querySelectorAll('button').forEach(b=>b.setAttribute('aria-current',String(Number(b.dataset.pdfPage)===c.pageNumber)));
  }
  async function search(){if(!ctx().attachmentId)return;const query=el('pdfSearchText').value.trim();if(!query)return;
    searchController?.abort();searchController=new AbortController();const id=ctx().attachmentId;el('pdfSearchResults').textContent='Searching document…';
    try{const data=await PulsePDF.request('search',{id,query},searchController.signal);if(ctx().attachmentId!==id)return;searchResults=data.matches.filter(row=>ctx().order.includes(row.page));searchIndex=-1;
      el('pdfSearchResults').innerHTML=`<p>${searchResults.length} matches${data.complete?'':' (search limit reached)'}</p>`+searchResults.map((r,i)=>`<button type="button" data-pdf-match="${i}"><strong>Page ${ctx().order.indexOf(r.page)+1}</strong><span>${escapeHtml(r.snippet)}</span></button>`).join('')+(data.scannedPages?'<p>Scanned pages without selectable text are not included.</p>':'');
      el('pdfSearchResults').querySelectorAll('[data-pdf-match]').forEach(b=>b.onclick=()=>showMatch(Number(b.dataset.pdfMatch)));if(searchResults.length)showMatch(0);
    }catch(error){if(error.name!=='AbortError')el('pdfSearchResults').textContent=error.message;}
  }
  function showMatch(index){if(!searchResults.length)return;searchIndex=(index+searchResults.length)%searchResults.length;PulsePDF.navigate(ctx().order.indexOf(searchResults[searchIndex].page)+1);}
  async function exportPDF(){if(!editable()||exporting)return;const c=ctx(),target=c.paperId,name=(c.file.name||'Paper.pdf').replace(/\.pdf$/i,'')+' - edited.pdf';exporting=true;onState();status('Creating edited PDF…');
    try{const result=await PulsePDF.request('export',{id:c.attachmentId,name,pageOrder:c.order,rotations:c.file.editor?.rotations||{},annotations:(c.paper.pdfAnnotations||[]).filter(r=>r.pdfId===c.attachmentId)});
      const p=state.papers.find(row=>row.id===target);if(p&&!p.pdfAttachments.some(row=>row.id===result.id)){p.pdfAttachments.push(result);scheduleAutosave();await saveLibrary();}
      const response=await fetch(backendUrl('/api/reader/file/'+result.id),{headers:apiHeaders()});if(!response.ok)throw Error('The edited copy was saved, but its download failed. Reopen the copy from the attachment menu.');
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=result.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Edited PDF saved and downloaded. Your source PDF is unchanged.');PulsePDF.updateMode();
    }catch(error){status(error.message);}finally{exporting=false;onState();}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const dialog=el('pdfReaderDialog');if(!dialog)return;dialog.classList.add('pdf-editor-workspace');
    const exportButton=document.createElement('button');exportButton.id='pdfExportEdited';exportButton.type='button';exportButton.textContent='Export edited PDF';exportButton.onclick=exportPDF;el('pdfReadMode').parentElement.append(exportButton);
    const tabs=document.createElement('div');tabs.className='pdf-workspace-tabs';tabs.role='tablist';tabs.setAttribute('aria-label','PDF workspace');tabs.innerHTML=['Read','Comment','Edit','Pages'].map(name=>`<button type="button" role="tab" data-pdf-workspace="${name.toLowerCase()}" aria-selected="false">${name}</button>`).join('');dialog.insertBefore(tabs,dialog.querySelector('.pdf-toolbar'));tabs.querySelectorAll('button').forEach(b=>b.onclick=()=>mode(b.dataset.pdfWorkspace));
    const tools=document.createElement('div');tools.className='pdf-context-tools';tools.innerHTML='<div data-pdf-tools="comment" hidden><button type="button" data-pdf-tool="select">Select</button><button type="button" data-pdf-tool="highlight" data-pdf-edit>Highlight</button><button type="button" data-pdf-tool="underline" data-pdf-edit>Underline</button><button type="button" data-pdf-tool="strikeout" data-pdf-edit>Strikethrough</button><button type="button" data-pdf-tool="note" data-pdf-edit>Comment</button></div><div data-pdf-tools="edit" hidden><button type="button" data-pdf-tool="select">Select</button><button type="button" data-pdf-tool="text" data-pdf-edit>Add text</button><button type="button" data-pdf-tool="ink" data-pdf-edit>Pen</button><button type="button" data-pdf-tool="rectangle" data-pdf-edit>Rectangle</button><span>Additions and markup; original paragraphs are preserved.</span></div><div data-pdf-tools="pages" hidden><button type="button" data-pdf-page-edit="rotate-left" data-pdf-edit>Rotate left</button><button type="button" data-pdf-page-edit="rotate-right" data-pdf-edit>Rotate right</button><button type="button" data-pdf-page-edit="earlier" data-pdf-edit>Move earlier</button><button type="button" data-pdf-page-edit="later" data-pdf-edit>Move later</button><button type="button" data-pdf-page-edit="remove" data-pdf-edit>Remove page</button></div>';dialog.insertBefore(tools,dialog.querySelector('.pdf-reader-body'));
    tools.querySelectorAll('[data-pdf-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.pdfTool));tools.querySelectorAll('[data-pdf-page-edit]').forEach(b=>b.onclick=()=>pageEdit(b.dataset.pdfPageEdit));
    const pane=document.createElement('aside');pane.id='pdfPagesPane';pane.className='pdf-pages-pane';pane.setAttribute('aria-label','PDF pages and search');pane.innerHTML='<div class="pdf-pane-heading">Pages &amp; search</div><div class="pdf-search-field"><input id="pdfSearchText" type="search" maxlength="200" placeholder="Find in document…" aria-label="Find in PDF"><button id="pdfRunSearch" type="button" aria-label="Search PDF">Find</button></div><div class="pdf-search-nav"><button id="pdfSearchPrevious" type="button" aria-label="Previous PDF match">Previous</button><button id="pdfSearchNext" type="button" aria-label="Next PDF match">Next</button></div><div id="pdfSearchResults" class="pdf-search-results"></div><div id="pdfThumbnails"></div>';dialog.querySelector('.pdf-reader-body').prepend(pane);
    const empty=document.createElement('div');empty.id='pdfEmptyView';empty.className='pdf-empty-view';empty.innerHTML='<span aria-hidden="true">PDF</span><h3>Open a PDF in Pulse</h3><p>Use Find open PDF to retrieve an accessible copy, or attach a PDF from your computer.</p>';el('pdfViewport').prepend(empty);
    el('pdfRunSearch').onclick=search;el('pdfSearchText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();search();}};el('pdfSearchPrevious').onclick=()=>showMatch(searchIndex-1);el('pdfSearchNext').onclick=()=>showMatch(searchIndex+1);
    const sidebar=el('pdfAnnotationSidebar');sidebar.querySelector('h3').textContent='Properties & comments';
    const properties=document.createElement('div');properties.className='pdf-edit-properties';properties.innerHTML='<div id="pdfPlacementTools" hidden><div id="pdfTextTools"><label>Text<textarea id="pdfTextValue" rows="3" maxlength="5000" placeholder="Text to add to the page"></textarea></label><label>Font size<input id="pdfTextSize" type="number" min="6" max="72" value="12"></label></div><button id="pdfPlaceMark" type="button">Add text box</button></div><label>Pen width<input id="pdfStrokeWidth" type="number" min="1" max="12" value="2"></label>';sidebar.insertBefore(properties,el('pdfSelectedQuote'));el('pdfPlaceMark').onclick=placeMark;
    for(const [value,label] of [['black','Black'],['red','Red']])el('pdfHighlightColor').add(new Option(label,value));
    const count=document.createElement('span');count.id='pdfCommentCount';count.className='pdf-comment-count';sidebar.querySelector('h3').append(count);
    el('pdfUndoAnnotation').textContent='Undo';el('pdfUndoAnnotation').title='Undo PDF edit (Cmd/Ctrl+Z)';el('pdfUndoAnnotation').onclick=()=>restore(history,future);
    const redo=document.createElement('button');redo.id='pdfRedo';redo.type='button';redo.textContent='Redo';redo.disabled=true;redo.onclick=()=>restore(future,history);el('pdfUndoAnnotation').after(redo);
    dialog.append(el('pdfReaderStatus'));el('pdfReaderStatus').classList.add('pdf-status-bar');
    const surface=el('pdfPageSurface');surface.addEventListener('pointerdown',pointerDown);surface.addEventListener('pointermove',pointerMove);surface.addEventListener('pointerup',pointerUp);surface.addEventListener('pointercancel',()=>{drawing=null;paintDraft();});
    document.addEventListener('pulse:pdf-state',onState);document.addEventListener('pulse:pdf-page',()=>{onState();thumbnails();paintDraft();renderAnnotations();});
    dialog.addEventListener('close',()=>{searchController?.abort();thumbObserver?.disconnect();thumbRevision++;thumbQueue=[];identity='';});
    dialog.addEventListener('keydown',event=>{const input=event.target.matches('input,textarea,select,[contenteditable=true]');if(event.metaKey||event.ctrlKey){const key=event.key.toLowerCase();
      if(key==='f'){event.preventDefault();event.stopPropagation();el('pdfSearchText').focus();}
      else if(key==='s'){event.preventDefault();event.stopPropagation();if(editable())exportPDF();else el('pdfDownloadCopy').click();}
      else if(!input&&(key==='z'||key==='y')){event.preventDefault();event.stopPropagation();if(key==='y'||event.shiftKey)restore(future,history);else restore(history,future);}}
    });
    let width=0,frame=0;new ResizeObserver(entries=>{const next=Math.round(entries[0].contentRect.width);if(next===width)return;width=next;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(ctx().open)PulsePDF.drawPage();});}).observe(el('pdfViewport'));
    mode('read');
  });
  return{checkpoint,viewRect,canonicalRect,renderAnnotations,markupKind:()=>['underline','strikeout'].includes(tool)?tool:'highlight',selectionChanged:()=>{if(editable()&&['highlight','underline','strikeout'].includes(tool))PulsePDF.save();}};
})();
