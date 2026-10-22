/* Reader chrome and non-destructive local editing, backed by actual PDF export. */
const PulsePDFEditor=(()=>{
  const el=id=>document.getElementById(id),ctx=()=>PulsePDF.context();
  const palette={yellow:'#ffe66b',green:'#92e5aa',blue:'#3f8cf2',pink:'#f7a3d2',red:'#d92e2e',black:'#202027'};
  let tool='select',sidebarOpen=false,identity='',history=[],future=[],drawing=null,exporting=false,inline=null,textSize=12,strokeWidth=2,selectionBar=null;
  let thumbsKey='',thumbObserver=null,thumbQueue=[],thumbBusy=0,thumbRevision=0,thumbLimit=100,searchController=null,searchResults=[],searchIndex=-1;
  const thumbnailCache=new Map();
  const toolIcons={select:'M6 3l12 9-5.5 1.5L10 19z',highlight:'<path d="M14.5 3.5l6 6-7 7-6-6zM7.5 10.5L5 16l3 3 5.5-2.5"/><path class="ink" d="M4 21h9"/>',underline:'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',strikeout:'M5 12h14M16 7c-.8-1.8-2.3-3-4.3-3-2.3 0-3.9 1.3-3.9 3.1 0 1.4.9 2.4 2.7 2.9M8 16.5c.8 1.6 2.4 2.5 4.3 2.5 2.4 0 4-1.3 4-3.1 0-.7-.2-1.3-.6-1.9',
    note:'M4 5h16v11H10l-6 4z',text:'M5 7V4h14v3M12 4v16M9 20h6',ink:'M4 20l4.5-1 10.5-10.5-3.5-3.5L5 15.5zM13.5 7l3.5 3.5',rectangle:'M4 6h16v12H4z',
    page:'M6 3h8l4 4v14H6zM14 3v4h4',comment:'M4 5h16v11H10l-6 4zM8 9h8M8 12h5',copy:'M8 8h11v12H8zM5 16V4h11',quote:'M5 7h5v5H7c0 2 1 3 3 4M14 7h5v5h-3c0 2 1 3 3 4',
    'rotate-left':'M4 4v5h5M5.5 9A7.5 7.5 0 1 1 4.5 14','rotate-right':'M20 4v5h-5M18.5 9A7.5 7.5 0 1 0 19.5 14',earlier:'M12 19V5M6 11l6-6 6 6',later:'M12 5v14M6 13l6 6 6-6',remove:'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6'};
  function editable(){const c=ctx();return c.open&&c.attachmentId&&!c.preview&&!!c.paper;}
  function snapshot(){const c=ctx();return JSON.parse(JSON.stringify({annotations:(c.paper?.pdfAnnotations||[]).filter(r=>r.pdfId===c.attachmentId),editor:c.file?.editor||null}));}
  function checkpoint(){if(!editable())return;history.push(snapshot());if(history.length>30)history.shift();future=[];syncHistory();}
  function syncHistory(){el('pdfUndoAnnotation').disabled=!history.length;el('pdfRedo').disabled=!future.length;}
  function changed(reload=false,page=ctx().pageNumber){scheduleAutosave();renderDetails();renderAnnotations();syncHistory();if(reload)PulsePDF.navigate(Math.min(page,ctx().order.length));else PulsePDF.drawPage();}
  function restore(from,to){if(!editable()||!from.length)return;closeInline(false);to.push(snapshot());const previous=from.pop(),c=ctx();c.paper.pdfAnnotations=[...(c.paper.pdfAnnotations||[]).filter(r=>r.pdfId!==c.attachmentId),...previous.annotations];if(previous.editor)c.file.editor=previous.editor;else delete c.file.editor;changed(true);}
  function transform(p,angle){return angle===90?{x:1-p.y,y:p.x}:angle===180?{x:1-p.x,y:1-p.y}:angle===270?{x:p.y,y:1-p.x}:{...p};}
  function viewPoint(point,angle=ctx().rotation){return transform(point,angle);}
  function canonicalPoint(point,angle=ctx().rotation){return transform(point,(360-angle)%360);}
  function transformRect(rect,angle){const points=[transform({x:rect.x,y:rect.y},angle),transform({x:rect.x+rect.width,y:rect.y+rect.height},angle)];return{x:Math.min(points[0].x,points[1].x),y:Math.min(points[0].y,points[1].y),width:Math.abs(points[1].x-points[0].x),height:Math.abs(points[1].y-points[0].y)};}
  const viewRect=(rect,angle=ctx().rotation)=>transformRect(rect,angle),canonicalRect=(rect,angle=ctx().rotation)=>transformRect(rect,(360-angle)%360);
  function status(text){el('pdfReaderStatus').textContent=text;}
  function setSidebarOpen(value){sidebarOpen=!!value&&!!editable();el('pdfAnnotationSidebar').hidden=!sidebarOpen;
    const toggle=el('pdfSidebarToggle');toggle.disabled=!editable();toggle.setAttribute('aria-expanded',String(sidebarOpen));toggle.title=(sidebarOpen?'Hide':'Show')+' comments and highlight properties';
  }
  /* Tools work directly on the page, as in Acrobat; the side panel only opens when asked for. */
  function setTool(value){closeInline(true);hideSelectionBar();showPageMenu(false);tool=editable()?value:'select';el('pdfPageStack').dataset.tool=tool;
    const color=el('pdfHighlightColor');
    if(['text','ink','rectangle'].includes(tool)&&color.value==='yellow')color.value=tool==='text'?'black':'blue';
    else if(['highlight','underline','strikeout','note'].includes(tool)&&color.value==='black')color.value='yellow';
    document.querySelectorAll('[data-pdf-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.pdfTool===tool)));
    syncOptions();
    status({highlight:'Select text to highlight it.',underline:'Select text to underline it.',strikeout:'Select text to strike it through.',note:'Click the page to add a comment.',text:'Click the page where the text should go, then type.',ink:'Draw on the page. Each stroke can be undone.',rectangle:'Drag on the page to draw a rectangle.'}[tool]||'');
    if(['highlight','underline','strikeout'].includes(tool)&&ctx().selection)PulsePDF.save();
  }
  function syncOptions(){const box=el('pdfToolOptions');if(!box)return;const shown=editable()&&tool!=='select';box.hidden=!shown;if(!shown)return;
    const color=el('pdfHighlightColor').value;box.querySelectorAll('[data-pdf-color]').forEach(b=>b.setAttribute('aria-checked',String(b.dataset.pdfColor===color)));
    const sized=['text','ink','rectangle'].includes(tool);box.querySelector('.pdf-size').hidden=!sized;
    if(sized)el('pdfToolSize').textContent=tool==='text'?textSize+' pt':strokeWidth+' px';
  }
  function resize(step){if(tool==='text')textSize=Math.max(6,Math.min(72,textSize+step*2));else strokeWidth=Math.max(1,Math.min(12,strokeWidth+step));syncOptions();styleInline();}
  function showPageMenu(open){const menu=el('pdfPageMenu');if(!menu)return;menu.hidden=!open;el('pdfPageMenuButton').setAttribute('aria-expanded',String(open));}
  function onState(){const c=ctx(),key=[c.paperId,c.attachmentId,c.preview].join(':');
    if(key!==identity){identity=key;history=[];future=[];closeInline(false);drawing=null;thumbsKey='';thumbLimit=100;thumbRevision++;thumbQueue=[];searchResults=[];searchIndex=-1;el('pdfSearchResults').replaceChildren();searchController?.abort();renderOutline();setTool('select');}
    setSidebarOpen(sidebarOpen);
    if(!c.file){const href=safeHref(c.paper?.url||(c.paper?.doi?'https://doi.org/'+c.paper.doi:''));el('pdfSourceLink').href=href||'#';el('pdfSourceLink').hidden=!href;el('pdfSourceLink').textContent='Open source page';}
    el('pdfExportEdited').disabled=!editable()||exporting;el('pdfSearchText').disabled=!c.attachmentId;el('pdfRunSearch').disabled=!c.attachmentId;
    document.querySelectorAll('[data-pdf-edit]').forEach(b=>{b.disabled=!editable();b.title=b.disabled?b.getAttribute('aria-label')+' — download a local copy to annotate':b.getAttribute('aria-label');});
    el('pdfDock').hidden=!c.attachmentId;syncOptions();
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
  function addMark(mark){if(!editable())return;checkpoint();const c=ctx();c.paper.pdfAnnotations ||= [];c.paper.pdfAnnotations.push({id:uid(),pdfId:c.attachmentId,page:c.sourcePage,color:el('pdfHighlightColor').value,createdAt:new Date().toISOString(),...mark});changed();status(mark.kind==='note'?'Comment added.':'Edit saved in Pulse. Export edited PDF to include it in a PDF file.');}
  function pagePoint(event,surface){const box=surface.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(event.clientX-box.x)/box.width)),y:Math.max(0,Math.min(1,(event.clientY-box.y)/box.height))};}
  function pointerDown(event){if(event.target.closest('.pdf-inline,.pdf-note-pin'))return;
    // Clicking away from an open comment or text box places it, as in Acrobat.
    if(inline){closeInline(true);if(tool==='text'||tool==='note'){event.preventDefault();return;}}
    const page=PulsePDF.pageFor(event.target);if(!editable()||!page?.data||!['ink','rectangle','text','note'].includes(tool)||event.button!==0)return;
    event.preventDefault();window.getSelection()?.removeAllRanges();PulsePDF.focusPage(page.index+1);const p=pagePoint(event,page.el);
    if(tool==='text'||tool==='note')return openInline(tool,page,p);
    drawing={page,start:p,points:[p],tool};page.el.setPointerCapture(event.pointerId);
  }
  function pointerMove(event){if(!drawing)return;const p=pagePoint(event,drawing.page.el);drawing.points.push(p);if(drawing.points.length>2000)drawing.points.splice(1,1);paintPage(drawing.page);}
  function pointerUp(event){if(!drawing)return;const draft=drawing,{page}=draft;draft.points.push(pagePoint(event,page.el));drawing=null;
    if(draft.tool==='ink'&&draft.points.length>1)addMark({kind:'ink',page:page.source,points:draft.points.map(p=>canonicalPoint(p,page.rotation)),strokeWidth});
    else{const a=draft.start,b=draft.points.at(-1),rect=canonicalRect({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)},page.rotation);if(rect.width>.002&&rect.height>.002)addMark({kind:'rectangle',page:page.source,rect,strokeWidth});else paintPage(page);}
  }
  /* A comment popup or a text box typed straight onto the page at the clicked point. */
  function openInline(kind,page,point,options={}){closeInline(true);
    const box=document.createElement('div');box.className='pdf-inline pdf-inline-'+(kind==='text'?'text':'note');box.style.left=point.x*100+'%';box.style.top=point.y*100+'%';
    box.classList.toggle('is-left',kind!=='text'&&point.x>.6);box.classList.toggle('is-above',kind!=='text'&&point.y>.72);
    const mark=options.mark||null;
    box.innerHTML=kind==='text'?'<textarea rows="1" maxlength="5000" aria-label="Text to add to the page" placeholder="Type here" spellcheck="true"></textarea>'
      :`<textarea rows="3" maxlength="20000" aria-label="Comment" placeholder="${options.placeholder||'Add a comment…'}"></textarea><div class="pdf-inline-actions">${mark?'<button type="button" data-pdf-delete>Delete</button>':''}<span></span><button type="button" data-pdf-cancel>Cancel</button><button type="button" data-pdf-post>${mark?'Save':'Post'}</button></div>`;
    const area=box.querySelector('textarea');area.value=mark?.memo||'';
    page.el.append(box);inline={kind,page,point,box,mark,commit:options.commit};styleInline();
    area.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeInline(false);}else if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();event.stopPropagation();closeInline(true);}});
    area.addEventListener('input',styleInline);
    if(kind==='text')area.addEventListener('blur',()=>setTimeout(()=>{if(inline?.box===box)closeInline(true);},0));
    box.querySelector('[data-pdf-post]')?.addEventListener('click',()=>closeInline(true));
    box.querySelector('[data-pdf-cancel]')?.addEventListener('click',()=>closeInline(false));
    box.querySelector('[data-pdf-delete]')?.addEventListener('click',()=>{closeInline(false);checkpoint();ctx().paper.pdfAnnotations=ctx().paper.pdfAnnotations.filter(row=>row.id!==mark.id);changed();status('Comment deleted.');});
    area.focus();
  }
  function styleInline(){if(inline?.kind!=='text')return;const {page,box}=inline,area=box.querySelector('textarea'),scale=page.el.clientWidth/page.data.width,size=textSize*scale;
    const measure=styleInline.canvas ||= document.createElement('canvas').getContext('2d');measure.font=`${size}px Arial, sans-serif`;
    const lines=(area.value||area.placeholder).split('\n'),widest=Math.max(...lines.map(line=>measure.measureText(line).width));
    area.style.fontSize=size+'px';area.style.color=palette[el('pdfHighlightColor').value]||palette.black;
    area.style.width=Math.min(page.el.clientWidth*(1-inline.point.x)-4,widest+size)+'px';area.style.height='auto';area.style.height=area.scrollHeight+'px';
  }
  function closeInline(commit){const current=inline;if(!current)return;inline=null;
    const area=current.box.querySelector('textarea'),value=area.value.trim(),{page,point}=current;
    const width=(area.offsetWidth+2)/page.el.clientWidth,height=(area.offsetHeight+2)/page.el.clientHeight,focused=current.box.contains(document.activeElement);current.box.remove();
    if(focused)el('pdfViewport').focus({preventScroll:true});
    if(!commit||!editable())return;
    if(current.commit)return value&&current.commit(value);
    if(current.mark){if(value&&value!==current.mark.memo){checkpoint();current.mark.memo=value;changed();status('Comment saved.');}return;}
    if(!value)return;
    if(current.kind==='note')return addMark({kind:'note',page:page.source,point:canonicalPoint(point,page.rotation),memo:value});
    const rect=canonicalRect({x:point.x,y:point.y,width:Math.min(Math.max(.03,width),1-point.x),height:Math.min(Math.max(.015,height),1-point.y)},page.rotation);
    addMark({kind:'text',page:page.source,text:value,rect,fontSize:textSize});
  }
  /* After selecting text with the Select tool, a bubble bar offers markup, a comment, a quotation or copying. */
  function showSelectionBar(){const bar=el('pdfSelectionBar'),selection=window.getSelection();if(!bar||!selection?.rangeCount)return;
    const rect=selection.getRangeAt(0).getBoundingClientRect(),stage=bar.parentElement.getBoundingClientRect();if(!rect.width&&!rect.height)return;
    bar.querySelectorAll('[data-pdf-edit]').forEach(b=>b.hidden=!editable());bar.hidden=false;
    const above=rect.top-stage.top-bar.offsetHeight-10;
    bar.style.left=Math.max(bar.offsetWidth/2+6,Math.min(stage.width-bar.offsetWidth/2-6,rect.left+rect.width/2-stage.left))+'px';
    bar.style.top=(above>6?above:rect.bottom-stage.top+10)+'px';selectionBar=ctx().selection;
  }
  function hideSelectionBar(){const bar=el('pdfSelectionBar');if(bar)bar.hidden=true;selectionBar=null;}
  async function selectionAction(action){const chosen=selectionBar;if(!chosen)return;hideSelectionBar();
    if(action==='copy'){try{await navigator.clipboard.writeText(chosen.quote);}catch{document.execCommand('copy');}return status('Copied.');}
    if(!editable())return;
    if(action==='notes'){PulsePDF.chooseAnnotation({...chosen,kind:'highlight'});return PulsePDF.save('notes');}
    if(action==='comment'){const page=PulsePDF.renderedPages().find(row=>row.source===chosen.page),last=chosen.rects?.at(-1);if(!page||!last)return;
      const end=viewRect(last,page.rotation);
      return openInline('note',page,{x:Math.min(.98,end.x+end.width),y:Math.min(.98,end.y+end.height)},{placeholder:'Comment on this passage…',commit:value=>{el('pdfAnnotationMemo').value=value;PulsePDF.chooseAnnotation({...chosen,kind:'highlight'});if(el('pdfHighlightColor').value==='black')el('pdfHighlightColor').value='yellow';PulsePDF.save();}});}
    if(action==='highlight'&&['black','red'].includes(el('pdfHighlightColor').value))el('pdfHighlightColor').value='yellow';
    PulsePDF.chooseAnnotation({...chosen,kind:action});PulsePDF.save();
  }
  /* Draws one rendered page's markup, the stroke in progress and the active search match. */
  function paintPage(page){const c=ctx(),surface=page.el,data=page.data,angle=page.rotation;if(!data||!surface.querySelector(':scope>img'))return;
    surface.querySelector('.pdf-editor-layer')?.remove();const layer=document.createElement('div');layer.className='pdf-editor-layer';
    for(const mark of c.paper?.pdfAnnotations||[]){if(mark.pdfId!==c.attachmentId||mark.page!==page.source)continue;
      const color=palette[mark.color]||palette.blue;
      if(mark.kind==='ink'){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 1000');svg.setAttribute('preserveAspectRatio','none');const line=document.createElementNS(svg.namespaceURI,'polyline');line.setAttribute('points',mark.points.map(p=>viewPoint(p,angle)).map(p=>`${p.x*1000},${p.y*1000}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke',color);line.setAttribute('stroke-width',String((mark.strokeWidth||2)*1000/data.width));svg.append(line);layer.append(svg);}
      else if(mark.kind==='note'){const point=viewPoint(mark.point,angle),note=document.createElement('button');note.type='button';note.className='pdf-note-pin';note.dataset.markId=mark.id;note.style.left=point.x*100+'%';note.style.top=point.y*100+'%';note.title=mark.memo;note.setAttribute('aria-label','Comment: '+mark.memo);note.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${toolIcons.note}"/></svg>`;layer.append(note);}
      else if(mark.rect){const rect=viewRect(mark.rect,angle),box=document.createElement('span');box.className='pdf-edit-'+mark.kind;box.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%;color:${color};--edit-stroke:${mark.strokeWidth||2}px`;
        if(mark.kind==='text'){const inner=document.createElement('span'),w=rect.width*surface.clientWidth,h=rect.height*surface.clientHeight;inner.textContent=mark.text;inner.style.width=(angle%180?h:w)+'px';inner.style.height=(angle%180?w:h)+'px';inner.style.transform=angle===90?`translateX(${w}px) rotate(90deg)`:angle===180?`translate(${w}px,${h}px) rotate(180deg)`:angle===270?`translateY(${h}px) rotate(270deg)`:'none';box.append(inner);box.style.fontSize=(mark.fontSize||12)*surface.clientWidth/data.width+'px';}layer.append(box);}
    }
    if(drawing?.page===page){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 1000 1000');svg.setAttribute('preserveAspectRatio','none');const shape=document.createElementNS(svg.namespaceURI,drawing.tool==='ink'?'polyline':'rect');
      if(drawing.tool==='ink')shape.setAttribute('points',drawing.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '));
      else{const a=drawing.start,b=drawing.points.at(-1);for(const [key,value] of Object.entries({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)}))shape.setAttribute(key,String(value*1000));}
      shape.setAttribute('fill','none');shape.setAttribute('stroke',palette[el('pdfHighlightColor').value]||palette.blue);shape.setAttribute('stroke-width','3');svg.append(shape);layer.append(svg);}
    if(searchIndex>=0&&searchResults[searchIndex]?.page===page.source){const rect=viewRect(searchResults[searchIndex].rect,angle),match=document.createElement('span');match.className='pdf-search-match';match.style.cssText=`left:${rect.x*100}%;top:${rect.y*100}%;width:${rect.width*100}%;height:${rect.height*100}%`;layer.append(match);}
    const text=surface.querySelector('.pdf-text-layer');if(text)text.before(layer);else surface.append(layer);
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
  /* Contents from the PDF's bookmarks, or from its section headings when it has none. */
  function renderOutline(){const c=ctx(),data=c.outline,list=el('pdfOutline');if(!list)return;
    if(!data){list.innerHTML=c.attachmentId?'<p class="pdf-outline-note">Reading contents…</p>':'';return;}
    if(!data.outline.length){list.innerHTML='<p class="pdf-outline-note">This PDF has no bookmarks or recognisable section headings.</p>';return;}
    list.innerHTML=(data.source==='headings'?'<p class="pdf-outline-note">Built from the section headings in this PDF.</p>':'')+data.outline.map((row,i)=>`<button type="button" data-pdf-outline="${i}" style="--outline-level:${Math.min(row.level,4)-1}"><span>${escapeHtml(row.title)}</span><small>${Number(row.page)}</small></button>`).join('');
    for(const b of list.querySelectorAll('[data-pdf-outline]'))b.onclick=()=>{const row=data.outline[Number(b.dataset.pdfOutline)],position=ctx().order.indexOf(row.page);if(position>=0)PulsePDF.navigate(position+1,row.y||0);else status('This section is on a page excluded from the edited copy. Undo the page removal to view it.');};
    markSection();
  }
  function markSection(){const c=ctx(),rows=c.outline?.outline||[];let current=-1;
    rows.forEach((row,i)=>{const position=c.order.indexOf(row.page)+1;if(position>0&&position<=c.pageNumber&&(current<0||position>=c.order.indexOf(rows[current].page)+1))current=i;});
    el('pdfOutline')?.querySelectorAll('[data-pdf-outline]').forEach(b=>b.setAttribute('aria-current',String(Number(b.dataset.pdfOutline)===current)));
  }
  function showPane(name){const contents=name==='contents';el('pdfOutline').hidden=!contents;el('pdfThumbnails').hidden=contents;
    document.querySelectorAll('[data-pdf-pane]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.pdfPane===name)));
    try{localStorage.setItem('pulse-pdf-pane',name);}catch{}
  }
  async function search(){if(!ctx().attachmentId)return;const query=el('pdfSearchText').value.trim();if(!query)return;
    searchController?.abort();searchController=new AbortController();const id=ctx().attachmentId;el('pdfSearchResults').textContent='Searching document…';
    try{const data=await PulsePDF.request('search',{id,query},searchController.signal);if(ctx().attachmentId!==id)return;searchResults=data.matches.filter(row=>ctx().order.includes(row.page));searchIndex=-1;
      el('pdfSearchResults').innerHTML=`<p>${searchResults.length} matches${data.complete?'':' (search limit reached)'}</p>`+searchResults.map((r,i)=>`<button type="button" data-pdf-match="${i}"><strong>Page ${ctx().order.indexOf(r.page)+1}</strong><span>${escapeHtml(r.snippet)}</span></button>`).join('')+(data.scannedPages?'<p>Scanned pages without selectable text are not included.</p>':'');
      el('pdfSearchResults').querySelectorAll('[data-pdf-match]').forEach(b=>b.onclick=()=>showMatch(Number(b.dataset.pdfMatch)));if(searchResults.length)showMatch(0);
    }catch(error){if(error.name!=='AbortError')el('pdfSearchResults').textContent=error.message;}
  }
  function showMatch(index){if(!searchResults.length)return;searchIndex=(index+searchResults.length)%searchResults.length;const match=searchResults[searchIndex];
    PulsePDF.navigate(ctx().order.indexOf(match.page)+1,match.rect.y);
    el('pdfSearchResults').querySelectorAll('[data-pdf-match]').forEach(b=>b.setAttribute('aria-current',String(Number(b.dataset.pdfMatch)===searchIndex)));}
  async function exportPDF(){if(!editable()||exporting)return;const c=ctx(),target=c.paperId,name=(c.file.name||'Paper.pdf').replace(/\.pdf$/i,'')+' - edited.pdf';exporting=true;onState();status('Creating edited PDF…');
    try{const result=await PulsePDF.request('export',{id:c.attachmentId,name,pageOrder:c.order,rotations:c.file.editor?.rotations||{},annotations:(c.paper.pdfAnnotations||[]).filter(r=>r.pdfId===c.attachmentId)});
      const p=state.papers.find(row=>row.id===target);if(p&&!p.pdfAttachments.some(row=>row.id===result.id)){p.pdfAttachments.push(result);scheduleAutosave();await saveLibrary();}
      const response=await fetch(backendUrl('/api/reader/file/'+result.id),{headers:apiHeaders()});if(!response.ok)throw Error('The edited copy was saved, but its download failed. Reopen the copy from the attachment menu.');
      const url=URL.createObjectURL(await response.blob()),anchor=document.createElement('a');anchor.href=url;anchor.download=result.name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('Edited PDF saved and downloaded. Your source PDF is unchanged.');PulsePDF.updateMode();
    }catch(error){status(error.message);}finally{exporting=false;onState();}
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const dialog=el('pdfReaderDialog');if(!dialog)return;dialog.classList.add('pdf-editor-workspace');
    const exportButton=document.createElement('button');exportButton.id='pdfExportEdited';exportButton.type='button';exportButton.textContent='Export';exportButton.title='Export an edited copy with your markup and page changes';exportButton.onclick=exportPDF;el('pdfReadMode').parentElement.append(exportButton);
    // Workspace tools float over the page as round bubbles, matching the map's paper nodes.
    const bubble=(kind,value,label,edit=true,icon=value)=>`<button type="button" class="pdf-bubble" data-pdf-${kind}="${value}"${edit?' data-pdf-edit':''} aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${toolIcons[icon].startsWith('<')?toolIcons[icon]:`<path d="${toolIcons[icon]}"/>`}</svg></button>`;
    const gap='<span class="pdf-dock-gap" aria-hidden="true"></span>';
    const tools=document.createElement('div');tools.id='pdfDock';tools.className='pdf-context-tools';tools.innerHTML=`<div id="pdfToolOptions" class="pdf-tool-options" hidden><div class="pdf-swatches" role="radiogroup" aria-label="Colour">${Object.entries(palette).map(([name,hex])=>`<button type="button" role="radio" class="pdf-swatch" data-pdf-color="${name}" style="--swatch:${hex}" aria-label="${name[0].toUpperCase()+name.slice(1)}" title="${name[0].toUpperCase()+name.slice(1)}"></button>`).join('')}</div><div class="pdf-size"><button type="button" data-pdf-size="-1" aria-label="Smaller">−</button><span id="pdfToolSize"></span><button type="button" data-pdf-size="1" aria-label="Larger">+</button></div></div>`
      +`<div id="pdfPageMenu" class="pdf-page-menu" role="toolbar" aria-label="Page tools" hidden>${bubble('page-edit','rotate-left','Rotate page left')}${bubble('page-edit','rotate-right','Rotate page right')}${bubble('page-edit','earlier','Move page earlier')}${bubble('page-edit','later','Move page later')}${bubble('page-edit','remove','Remove page')}</div>`
      +`<div class="pdf-dock" role="toolbar" aria-label="PDF tools">${bubble('tool','select','Select text',false)}${gap}${bubble('tool','highlight','Highlighter')}${bubble('tool','underline','Underline')}${bubble('tool','note','Comment')}${gap}${bubble('tool','text','Add text')}${bubble('tool','ink','Pen')}${bubble('tool','rectangle','Rectangle')}${gap}<button type="button" id="pdfPageMenuButton" class="pdf-bubble" data-pdf-edit aria-label="Page tools" aria-haspopup="true" aria-expanded="false" aria-controls="pdfPageMenu" title="Page tools"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${toolIcons.page}"/></svg></button></div>`;
    const selectionTools=document.createElement('div');selectionTools.id='pdfSelectionBar';selectionTools.className='pdf-selection-bar';selectionTools.setAttribute('role','toolbar');selectionTools.setAttribute('aria-label','Selected text');selectionTools.hidden=true;
    selectionTools.innerHTML=bubble('selection','highlight','Highlight')+bubble('selection','underline','Underline')+bubble('selection','strikeout','Strikethrough')+bubble('selection','comment','Comment on selection')+bubble('selection','notes','Quote to Notes',true,'quote')+bubble('selection','copy','Copy',false);
    const stage=document.createElement('div');stage.className='pdf-stage';el('pdfViewport').before(stage);stage.append(el('pdfViewport'),tools,selectionTools);
    tools.querySelectorAll('[data-pdf-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.pdfTool));tools.querySelectorAll('[data-pdf-page-edit]').forEach(b=>b.onclick=()=>pageEdit(b.dataset.pdfPageEdit));
    el('pdfPageMenuButton').onclick=()=>showPageMenu(el('pdfPageMenu').hidden);
    tools.querySelectorAll('[data-pdf-color]').forEach(b=>b.onclick=()=>{el('pdfHighlightColor').value=b.dataset.pdfColor;syncOptions();styleInline();});
    tools.querySelectorAll('[data-pdf-size]').forEach(b=>b.onclick=()=>resize(Number(b.dataset.pdfSize)));
    // Bar buttons keep the text selection, so the action applies to it.
    selectionTools.addEventListener('pointerdown',event=>event.preventDefault());
    selectionTools.querySelectorAll('[data-pdf-selection]').forEach(b=>b.onclick=()=>selectionAction(b.dataset.pdfSelection));
    const pane=document.createElement('aside');pane.id='pdfPagesPane';pane.className='pdf-pages-pane';pane.setAttribute('aria-label','PDF pages and search');pane.innerHTML='<div class="pdf-pane-heading">Pages &amp; search</div><div class="pdf-search-field"><input id="pdfSearchText" type="search" maxlength="200" placeholder="Find in document…" aria-label="Find in PDF"><button id="pdfRunSearch" type="button" aria-label="Search PDF">Find</button></div><div class="pdf-search-nav"><button id="pdfSearchPrevious" type="button" aria-label="Previous PDF match">Previous</button><button id="pdfSearchNext" type="button" aria-label="Next PDF match">Next</button></div><div id="pdfSearchResults" class="pdf-search-results"></div><div class="pdf-pane-tabs" role="tablist" aria-label="Document navigation"><button type="button" role="tab" data-pdf-pane="pages" aria-controls="pdfThumbnails">Pages</button><button type="button" role="tab" data-pdf-pane="contents" aria-controls="pdfOutline">Contents</button></div><nav id="pdfOutline" class="pdf-outline" aria-label="PDF contents" hidden></nav><div id="pdfThumbnails"></div>';dialog.querySelector('.pdf-reader-body').prepend(pane);
    pane.querySelectorAll('[data-pdf-pane]').forEach(b=>b.onclick=()=>showPane(b.dataset.pdfPane));let paneName='pages';try{paneName=localStorage.getItem('pulse-pdf-pane')==='contents'?'contents':'pages';}catch{}showPane(paneName);
    const empty=document.createElement('div');empty.id='pdfEmptyView';empty.className='pdf-empty-view';empty.innerHTML='<span aria-hidden="true">PDF</span><h3>Open a PDF in Pulse</h3><p>Use Find open PDF to retrieve an accessible copy, or attach a PDF from your computer.</p>';el('pdfViewport').prepend(empty);
    el('pdfRunSearch').onclick=search;el('pdfSearchText').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();search();}};el('pdfSearchPrevious').onclick=()=>showMatch(searchIndex-1);el('pdfSearchNext').onclick=()=>showMatch(searchIndex+1);
    const sidebar=el('pdfAnnotationSidebar');sidebar.querySelector('h3').textContent='Properties & comments';
    el('pdfHighlightColor').addEventListener('change',syncOptions);
    for(const [value,label] of [['black','Black'],['red','Red']])el('pdfHighlightColor').add(new Option(label,value));
    const count=document.createElement('span');count.id='pdfCommentCount';count.className='pdf-comment-count';sidebar.querySelector('h3').append(count);
    el('pdfUndoAnnotation').textContent='↶';el('pdfUndoAnnotation').setAttribute('aria-label','Undo');el('pdfUndoAnnotation').title='Undo (Cmd/Ctrl+Z)';el('pdfUndoAnnotation').classList.add('pdf-icon-button');el('pdfUndoAnnotation').onclick=()=>restore(history,future);
    const redo=document.createElement('button');redo.id='pdfRedo';redo.type='button';redo.textContent='↷';redo.setAttribute('aria-label','Redo');redo.title='Redo (Cmd/Ctrl+Shift+Z)';redo.className='pdf-icon-button';redo.disabled=true;redo.onclick=()=>restore(future,history);el('pdfUndoAnnotation').after(redo);
    const sidebarToggle=document.createElement('button');sidebarToggle.id='pdfSidebarToggle';sidebarToggle.type='button';sidebarToggle.textContent='Comments';sidebarToggle.setAttribute('aria-controls','pdfAnnotationSidebar');sidebarToggle.setAttribute('aria-expanded','false');sidebarToggle.onclick=()=>{if(sidebarOpen)setTool('select');setSidebarOpen(!sidebarOpen);};dialog.querySelector('.pdf-toolbar').append(sidebarToggle);
    // Document controls share one row with the copy's status and download actions.
    el('pdfReadMode').parentElement.insertBefore(dialog.querySelector('.pdf-toolbar'),el('pdfDownloadCopy'));
    dialog.append(el('pdfReaderStatus'));el('pdfReaderStatus').classList.add('pdf-status-bar');
    const stack=el('pdfPageStack');stack.addEventListener('pointerdown',pointerDown);
    stack.addEventListener('click',event=>{const pin=event.target.closest('.pdf-note-pin');if(!pin||!editable())return;const mark=ctx().paper?.pdfAnnotations?.find(row=>row.id===pin.dataset.markId),page=PulsePDF.pageFor(pin);if(mark&&page)openInline('note',page,viewPoint(mark.point,page.rotation),{mark});});
    document.addEventListener('selectionchange',()=>{const selection=window.getSelection();if(!el('pdfSelectionBar').hidden&&(!selection?.rangeCount||selection.isCollapsed))hideSelectionBar();});
    el('pdfViewport').addEventListener('scroll',hideSelectionBar,{passive:true});
    document.addEventListener('pointerdown',event=>{if(!el('pdfPageMenu').hidden&&!event.target.closest('#pdfPageMenu,#pdfPageMenuButton'))showPageMenu(false);});stack.addEventListener('pointermove',pointerMove);stack.addEventListener('pointerup',pointerUp);stack.addEventListener('pointercancel',()=>{const page=drawing?.page;drawing=null;if(page)paintPage(page);});
    document.addEventListener('pulse:pdf-state',onState);document.addEventListener('pulse:pdf-page',()=>{onState();thumbnails();renderAnnotations();markSection();});document.addEventListener('pulse:pdf-outline',renderOutline);
    dialog.addEventListener('close',()=>{closeInline(false);hideSelectionBar();showPageMenu(false);searchController?.abort();thumbObserver?.disconnect();thumbRevision++;thumbQueue=[];identity='';});
    dialog.addEventListener('keydown',event=>{const input=event.target.matches('input,textarea,select,[contenteditable=true]');
      // Escape steps back out of menus and tools before it closes the reader.
      if(event.key==='Escape'&&!input){const handled=!el('pdfPageMenu').hidden?(showPageMenu(false),true):!el('pdfSelectionBar').hidden?(hideSelectionBar(),true):tool!=='select'?(setTool('select'),true):false;if(handled){event.preventDefault();event.stopPropagation();}return;}
      if(event.metaKey||event.ctrlKey){const key=event.key.toLowerCase();
      if(key==='f'){event.preventDefault();event.stopPropagation();el('pdfSearchText').focus();}
      else if(key==='s'){event.preventDefault();event.stopPropagation();if(editable())exportPDF();else el('pdfDownloadCopy').click();}
      else if(!input&&(key==='z'||key==='y')){event.preventDefault();event.stopPropagation();if(key==='y'||event.shiftKey)restore(future,history);else restore(history,future);}}
    });
    let size='',frame=0;new ResizeObserver(entries=>{const box=entries[0].contentRect,next=Math.round(box.width)+'x'+Math.round(box.height);if(next===size)return;size=next;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{if(ctx().open)PulsePDF.drawPage();});}).observe(el('pdfViewport'));
    setTool('select');
  });
  return{checkpoint,viewRect,canonicalRect,renderAnnotations,paintPage,markupKind:()=>['underline','strikeout'].includes(tool)?tool:'highlight',selectionChanged:()=>{if(editable()&&['highlight','underline','strikeout'].includes(tool))PulsePDF.save();else if(tool==='select')showSelectionBar();}};
})();
