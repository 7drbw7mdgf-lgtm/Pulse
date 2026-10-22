/* Explicit screening projects are independent of relevance-training labels. */
const PulseScreening = (() => {
  let active=false, data=null,stage='title-abstract',queue=Promise.resolve(),busy=0;
  let recordIndex=new Map();
  const decisions=new Map();
  const requestId=()=>globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+uid()+uid();
  const canonical=p=>p.doi?'doi:'+String(p.doi).trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//,'').replace(/^doi:\s*/,'').replace(/[.,;]+$/,''):
    p.pmid?'pmid:'+p.pmid:p.s2PaperId?'s2:'+p.s2PaperId:p.openAlexId?'oa:'+p.openAlexId:
    'title:'+String(p.title||'').toLowerCase().replace(/\W+/g,' ')+'|'+(p.year||'');
  const current=()=>data?.project;
  function assign(result){data=result;recordIndex=new Map(Object.values(result?.records||{}).map(r=>[canonical(r.paper),r]));}
  function row(paper){return recordIndex.get(canonical(paper));}
  function focused(){return (state.discoveryResults||[]).find(p=>discoveryPaperKey(p)===state.discoveryFocusKey);}
  function targets(){const selected=typeof selectedDiscoveryPapers==='function'?selectedDiscoveryPapers():[];return selected.length?selected:focused()?[focused()]:[];}
  async function send(payload){
    const response=await fetch(backendUrl('/api/reviews'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify(payload)});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Screening could not be saved.');return result;
  }
  function enqueue(task){
    busy++;render();
    const pending=queue.then(task);queue=pending.catch(()=>{});
    state.pendingLibraryWrites ||= new Set();state.pendingLibraryWrites.add(pending);
    pending.then(()=>{},()=>{}).finally(()=>{busy--;state.pendingLibraryWrites.delete(pending);render();});
    return pending;
  }
  function accept(result,project){if(!project||current()===project)assign(result);render();return result;}
  function edit(title,initial,multiline=false){
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='research-dialog';
      dialog.innerHTML='<form><h2></h2><label></label><p><button class="mac-btn" type="button" data-cancel>Cancel</button> <button class="mac-btn primary" type="submit">Save</button></p></form>';
      dialog.querySelector('h2').textContent=title;
      const input=document.createElement(multiline?'textarea':'input');input.value=initial||'';input.maxLength=multiline?10000:500;
      dialog.querySelector('label').append(input);document.body.append(dialog);
      let settled=false;function finish(value){if(settled)return;settled=true;dialog.close();dialog.remove();resolve(value);}
      dialog.querySelector('form').onsubmit=event=>{event.preventDefault();finish(input.value);};
      dialog.querySelector('[data-cancel]').onclick=()=>finish(null);dialog.oncancel=event=>{event.preventDefault();finish(null);};
      dialog.showModal();input.focus();
    });
  }
  async function open(project){
    try {
      await enqueue(async()=>{
        const context=discoveryReviewContext();
        assign(await send(project?{action:'open',project}:{action:'open',context:discoveryContextKey(context),name:context.researchQuestion||context.seedPapers?.[0]?.title||'Literature screening'}));
        active=true;
        const result=discoveryRunInfoForModal();
        if(!project&&(state.discoveryResults||[]).length)await capture(state.discoveryResults,result,context);
        const projects=await send({action:'list'});const select=document.getElementById('screeningProject');
        if(select){select.innerHTML=projects.projects.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');select.value=data.project;}
      });render();
    }catch(error){showToast(error.message);}
  }
  async function capture(papers,info={},context={},project=current()){
    if(!project)return;
    info._screeningRunId ||= info.id||('retained-'+uid());
    const result=await send({action:'ingest',project,runId:info._screeningRunId,papers:papers.slice(0,2000).map(citationPaperPayload),
      query:context.researchQuestion||'',runInfo:{sourceCounts:info.sourceCounts,errors:info.errors,candidateCount:info.candidateCount,stoppedEarly:info.stoppedEarly}});
    return accept(result,project);
  }
  function afterSearch(papers,info,context){const project=current();if(active&&project)enqueue(()=>capture(papers,info,context,project)).catch(error=>showToast(error.message));}
  function recordGrade(paper,grade,priorGrade){
    return recordGrades([paper],grade,[priorGrade]);
  }
  function recordGrades(papers,grade,priorGrades){
    if(!active||!current())return;
    const tracked=papers.map((paper,i)=>{const key=discoveryPaperKey(paper),serial=(decisions.get(key)||0)+1;decisions.set(key,serial);return {paper,key,serial,priorGrade:priorGrades[i]};});
    const project=current(),screenStage=stage;
    enqueue(async()=>{
      let reason='';
      if(grade===0&&screenStage==='full-text'){
        reason=await edit('Reason for full-text exclusion','');
        if(!reason?.trim())throw Error('Full-text exclusion was not recorded. Add an exclusion reason to continue.');
      }
      const result=await send({action:'decision',project,requestId:requestId(),papers:tracked.map(item=>({...citationPaperPayload(item.paper),_priorGrade:item.priorGrade??null})),stage:screenStage,
        decision:grade===0?'exclude':grade>0?'include':'pending',reason});
      accept(result,project);
    }).catch(error=>{
      for(const item of tracked)if(decisions.get(item.key)===item.serial)labelDiscoveryPaper(item.paper,item.priorGrade,{screening:false,rerank:false,deferRender:true});
      scheduleAutosave();renderDiscoveryModal({preservePosition:true});
      showToast(error.message);
    });
  }
  async function annotate(kind){
    const papers=targets();if(!active||!papers.length)return showToast('Enable screening and focus or select papers first.');
    const project=current(),first=row(papers[0]);
    const value=await edit(kind==='memo'?'Screening memo':'Screening tags (comma separated)',kind==='memo'?first?.memo:(first?.tags||[]).join(', '),kind==='memo');
    if(value===null)return;
    const fields=kind==='memo'?{memo:value}:{tags:value.split(',').map(s=>s.trim()).filter(Boolean)};
    enqueue(async()=>accept(await send({action:'annotate',project,requestId:requestId(),papers:papers.map(citationPaperPayload),...fields}),project)).catch(error=>showToast(error.message));
  }
  async function undo(){
    if(!active||busy||!data?.canUndo)return;
    const project=current();
    enqueue(async()=>{
      const result=await send({action:'undo',project,requestId:requestId()});accept(result,project);
      if(result.undoneAction==='decision'&&current()===project){
        const affected=new Set((result.undoneRecords||[]).map(key=>canonical(result.records[key].paper)));
        for(const paper of state.discoveryResults||[]){const record=row(paper);if(record&&affected.has(canonical(paper)))labelDiscoveryPaper(paper,record.feedbackGrade??undefined,{screening:false,rerank:false,deferRender:true});}
        scheduleAutosave();
        renderDiscoveryModal({preservePosition:true});
      }
    }).catch(error=>showToast(error.message));
  }
  async function exportProject(){
    if(!current())return;
    const format=document.getElementById('screeningExportFormat').value;
    try{await queue;const result=await send({action:'export',project:current(),format});downloadRecordFile(result.filename,result.content,result.mime);}
    catch(error){showToast(error.message);}
  }
  async function viewPrismaFlow(){
    if(!current())return showToast('Open a screening project first.');
    try{
      await queue;
      const result=await send({action:'export',project:current(),format:'prisma-svg'});
      const dialog=document.createElement('dialog');dialog.className='pulse-tool-dialog prisma-flow-dialog';
      dialog.innerHTML=`<header><h2>PRISMA 2020 Flow Diagram</h2><button type="button" data-close-tool aria-label="Close PRISMA Flow">×</button></header><div class="prisma-preview-container" style="text-align:center;overflow:auto;max-height:72vh;padding:12px;background:#fff;border-radius:8px;border:1px solid var(--line);">${result.content}</div><p style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px;"><button class="mac-btn" type="button" data-download-prisma>Download SVG</button><button class="mac-btn primary" type="button" data-close-tool>Done</button></p>`;
      document.body.append(dialog);
      dialog.querySelectorAll('[data-close-tool]').forEach(btn=>btn.onclick=()=>{dialog.close();dialog.remove();});
      dialog.querySelector('[data-download-prisma]').onclick=()=>downloadRecordFile(result.filename,result.content,result.mime);
      dialog.showModal();
    }catch(error){showToast(error.message);}
  }
  async function reconcileReviewer2(){
    if(!current())return showToast('Open a screening project first.');
    const fileInput=document.createElement('input');fileInput.type='file';fileInput.accept='.json,application/json';
    fileInput.onchange=async()=>{
      const file=fileInput.files[0];if(!file)return;
      try{
        const text=await file.text();const r2=JSON.parse(text);
        const res=await send({action:'reconcile',project:current(),reviewer2:r2});
        const dialog=document.createElement('dialog');dialog.className='pulse-tool-dialog reconcile-dialog';
        const kappaInterp=res.kappa>=0.8?'Almost perfect agreement':res.kappa>=0.6?'Substantial agreement':res.kappa>=0.4?'Moderate agreement':'Fair / Slight agreement';
        dialog.innerHTML=`<header><h2>Dual-Reviewer Blind Reconciliation</h2><button type="button" data-close-tool aria-label="Close reconciliation">×</button></header><div class="reconcile-stats" style="display:flex;flex-wrap:wrap;gap:16px;margin-bottom:16px;padding:12px;background:var(--surface-2);border-radius:8px;"><div><strong>Cohen's Kappa (&kappa;):</strong> <span style="font-size:16px;color:var(--accent);font-weight:700;">${res.kappa}</span> (${kappaInterp})</div><div><strong>Concordant:</strong> ${res.concordant}</div><div><strong>Discrepant:</strong> <span style="color:${res.discrepant?'#dc2626':'inherit'};font-weight:600;">${res.discrepant}</span></div><div><strong>Total Evaluated:</strong> ${res.totalEvaluated}</div></div>${res.discrepancies?.length?`<h3>Discrepancies to Reconcile (${res.discrepancies.length})</h3><div class="discrepancy-list" style="max-height:48vh;overflow:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid var(--line);text-align:left;"><th style="padding:6px;">Paper</th><th style="padding:6px;">Reviewer 1</th><th style="padding:6px;">Reviewer 2</th></tr></thead><tbody>${res.discrepancies.map(d=>`<tr style="border-bottom:1px solid var(--line);"><td style="padding:6px;">${escapeHtml(d.title||d.recordId)}</td><td style="padding:6px;"><strong style="color:${d.reviewer1==='include'?'#16a34a':'#dc2626'}">${escapeHtml(d.reviewer1)}</strong>${d.reason1?`<small style="display:block;color:var(--muted);">${escapeHtml(d.reason1)}</small>`:''}</td><td style="padding:6px;"><strong style="color:${d.reviewer2==='include'?'#16a34a':'#dc2626'}">${escapeHtml(d.reviewer2)}</strong>${d.reason2?`<small style="display:block;color:var(--muted);">${escapeHtml(d.reason2)}</small>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<p style="color:#16a34a;font-weight:600;">✓ No discrepancies found! All overlapping decisions are in 100% agreement.</p>'}<p style="margin-top:16px;text-align:right;"><button class="mac-btn primary" type="button" data-close-tool>Close</button></p>`;
        document.body.append(dialog);
        dialog.querySelectorAll('[data-close-tool]').forEach(btn=>btn.onclick=()=>{dialog.close();dialog.remove();});
        dialog.showModal();
      }catch(err){showToast(err.message||'Failed to parse Reviewer 2 project JSON.');}
    };
    fileInput.click();
  }
  function prioritizeScreeningQueue(){
    if(!Array.isArray(state.discoveryResults)||state.discoveryResults.length<2)return showToast('No candidate papers to sort.');
    const feedback=[];
    for(const r of state.discoveryResults){
      const rec=row(r);const dec=rec?.stages?.[stage]?.decision;
      if(dec==='include')feedback.push({grade:2,paper:r});
      else if(dec==='exclude')feedback.push({grade:0,paper:r});
    }
    if(!feedback.length&&(!state.discoveryJudgements||!state.discoveryJudgements.length)){
      showToast('Record at least one include (R) or exclude (N) to train the active-learning model.');
      return;
    }
    const allFeedback=[...feedback,...(state.discoveryJudgements||[]).map(j=>({grade:j.grade,paper:j.paper}))];
    if(typeof rerankDiscoveryPoolWithFeedback==='function'){
      const {records,movedUp}=rerankDiscoveryPoolWithFeedback(state.discoveryResults,allFeedback);
      state.discoveryResults=records;
      if(typeof renderDiscoveryModal==='function')renderDiscoveryModal({preservePosition:true});
      showToast(`Active learning: queue prioritized (${movedUp} unjudged candidate${movedUp===1?'':'s'} surfaced).`);
    }
  }
  function render(){
    const tools=document.getElementById('screeningControls');if(!tools)return;
    tools.hidden=!active;
    const toggle=document.getElementById('screeningToggle');toggle.setAttribute('aria-pressed',String(active));toggle.textContent=active?'Pause screening':'Screening project';
    const status=document.getElementById('screeningStatus');
    const counts=data?.counts?.stages?.[stage];status.textContent=busy?'Saving screening…':counts?`${counts.screened} screened · ${counts.include} included · ${counts.exclude} excluded`:'Ready';
    document.getElementById('screeningUndo').disabled=busy>0||!data?.canUndo;
    const paper=focused(),record=paper?row(paper):null;
    const detail=document.getElementById('screeningRecord');if(detail)detail.textContent=record?[record.stages?.[stage]?.decision||'pending',record.tags?.join(', '),record.memo].filter(Boolean).join(' · '):'';
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const anchor=document.getElementById('discoverySourceNotice');if(!anchor)return;
    const tools=document.createElement('div');tools.className='research-tools screening-toolbar';
    tools.innerHTML='<button id="screeningToggle" class="dv-btn" type="button" aria-pressed="false">Screening project</button><div id="screeningControls" class="research-tools" hidden><select id="screeningProject" aria-label="Screening project"></select><select id="screeningStage" aria-label="Screening stage"><option value="title-abstract">Title / abstract screening</option><option value="full-text">Full-text eligibility</option></select><button id="screeningMemo" class="dv-btn" type="button">Memo (M)</button><button id="screeningTags" class="dv-btn" type="button">Tags (T)</button><button id="screeningUndo" class="dv-btn" type="button">Undo</button><button id="screeningPrisma" class="dv-btn" type="button" title="Interactive PRISMA 2020 Flowchart">PRISMA Flow</button><button id="screeningReconcile" class="dv-btn" type="button" title="Dual-reviewer blind reconciliation">Reconcile (R2)</button><button id="screeningActiveLearn" class="dv-btn" type="button" title="Prioritize screening queue via active-learning Rocchio model">Active Queue</button><select id="screeningExportFormat" aria-label="Screening export format"><option value="csv">Decisions CSV</option><option value="ris">Tagged RIS</option><option value="prisma">PRISMA working data</option><option value="prisma-svg">PRISMA 2020 Flowchart (SVG)</option><option value="blind-json">Blind project for Reviewer 2 (JSON)</option><option value="json">Project and audit history</option></select><button id="screeningExport" class="dv-btn" type="button">Export review</button><span id="screeningStatus" role="status"></span><small>R/N record screening decisions while enabled. Identification totals and included study counts need review.</small><span id="screeningRecord"></span></div>';
    anchor.after(tools);
    document.getElementById('screeningToggle').onclick=()=>{if(active){active=false;render();}else open();};
    document.getElementById('screeningProject').onchange=event=>open(event.target.value);
    document.getElementById('screeningStage').onchange=event=>{stage=event.target.value;render();};
    document.getElementById('screeningMemo').onclick=()=>annotate('memo');document.getElementById('screeningTags').onclick=()=>annotate('tags');
    document.getElementById('screeningUndo').onclick=undo;document.getElementById('screeningExport').onclick=exportProject;
    document.getElementById('screeningPrisma').onclick=viewPrismaFlow;
    document.getElementById('screeningReconcile').onclick=reconcileReviewer2;
    document.getElementById('screeningActiveLearn').onclick=prioritizeScreeningQueue;
    render();
  });
  document.addEventListener('keydown',event=>{
    if(!active||els.discoveryModal?.hidden||event.target.closest?.('input,textarea,select,[contenteditable=true]')||document.querySelector('dialog[open]'))return;
    const key=event.key.toLowerCase();
    if((event.metaKey||event.ctrlKey)&&key==='z'&&!event.shiftKey){event.preventDefault();event.stopImmediatePropagation();undo();}
    else if(!event.metaKey&&!event.ctrlKey&&!event.altKey&&(key==='m'||key==='t')){event.preventDefault();event.stopImmediatePropagation();annotate(key==='m'?'memo':'tags');}
  },true);
  return {recordGrade,recordGrades,canBatch:count=>!active||count<=500,afterSearch,render};
})();
