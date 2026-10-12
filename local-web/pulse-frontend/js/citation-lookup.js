const citationLookup = {generation:0, controller:null, text:'', groups:[], selected:new Map(), parent:null, busy:false};
function isInTextCitationInput(value) {
  const text=String(value||'').trim();
  if(!text || text.length>800 || text.includes('\n'))return false;
  const inner=text.startsWith('(')&&text.endsWith(')')?text.slice(1,-1):text;
  const parts=inner.split(';');if(parts.length>6)return false;
  return parts.every(part=>{
    const match=part.trim().match(/^([\p{L}][\p{L}\p{M}\s.'’\-‐‑–&]+?)(?:,\s*|\(\s*|\s+)((?:18|19|20)\d{2}[a-z]?)\s*\)?\.?$/iu);
    if(!match)return false;
    const names=match[1].trim().replace(/\s+et\s+al\.?$/i,'');
    if(['pmid','doi','title','abstract'].includes(names.toLowerCase()))return false;
    return names.split(/\s*(?:&|\band\b)\s*/i).every(name=>name.split(/\s+/).length<=5 && name.split(/\s+/).every(word=>
      !/^\p{Ll}/u.test(word)||['van','von','de','del','der','da','di','la','le','du','den'].includes(word)));
  });
}
function closeCitationLookup() {
  citationLookup.generation++;citationLookup.controller?.abort();citationLookup.busy=false;
  document.getElementById('citationLookupDialog').close();
}
function syncCitationLookupSelection() {
  const button=document.getElementById('citationLookupAdd');
  button.disabled=citationLookup.busy||!citationLookup.selected.size;
  button.textContent=citationLookup.busy?'Verifying DOI records…':`Add selected${citationLookup.selected.size?' ('+citationLookup.selected.size+')':''}`;
}
function renderCitationCandidates() {
  const container=document.getElementById('citationLookupResults');
  container.innerHTML=citationLookup.groups.map((group,i)=>`<section class="citation-lookup-group">
    <h3>${escapeHtml(group.citation)}</h3>${group.lookupStrategy==='bibliography'?'<p class="subtle">Matched to the selected paper’s full reference list.</p>':''}
    ${group.suffix&&group.lookupStrategy!=='bibliography'?'<p class="subtle">The year suffix identifies an entry in the original bibliography. Choose its title below.</p>':''}
    ${group.partial?'<p class="record-feedback">One source is unavailable. These matches are from the responding source.</p>':''}
    ${group.candidates.length?`<ul>${group.candidates.map((paper,j)=>`<li><label><input type="radio" name="citation-group-${i}" data-citation-group="${i}" data-citation-index="${j}"><span><strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml((paper.authors||[]).join(', '))} · ${escapeHtml(paper.year||'')} ${paper.journal?' · '+escapeHtml(paper.journal):''}</small><small>${escapeHtml(paper.doi?'DOI: '+paper.doi:'No DOI indexed')} · ${escapeHtml((paper.lookupSources||[paper.metadataSource]).filter(Boolean).join(' + '))}</small></span></label>${paper.doi?`<a href="https://doi.org/${escapeHtml(normalizeDoi(paper.doi))}" target="_blank" rel="noreferrer">Open paper ↗</a>`:''}</li>`).join('')}</ul>`:
      `<p class="subtle">${group.partial?'Online lookup could not complete. Try again shortly.':'No matching first author and year found. Add a title word or paste the full reference.'}</p>`}
  </section>`).join('');
  container.querySelectorAll('[data-citation-group]').forEach(input=>input.addEventListener('change',()=>{
    citationLookup.selected.set(Number(input.dataset.citationGroup),Number(input.dataset.citationIndex));syncCitationLookupSelection();
  }));
}
async function searchInTextCitations(text,context='') {
  if(citationLookup.busy)return;
  const dialog=document.getElementById('citationLookupDialog');
  citationLookup.controller?.abort();const controller=new AbortController();citationLookup.controller=controller;
  const generation=++citationLookup.generation;citationLookup.text=text;citationLookup.groups=[];citationLookup.selected.clear();
  const status=document.getElementById('citationLookupStatus'),results=document.getElementById('citationLookupResults'),refine=document.getElementById('citationLookupSearch');
  status.textContent='Checking the bibliography and online sources…';results.replaceChildren();refine.disabled=true;syncCitationLookupSelection();
  if(!dialog.open)dialog.showModal();
  const timer=setTimeout(()=>controller.abort(),30000);
  try {
    const response=await fetch(backendUrl('/api/metadata/citation'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({text,context,parentPaper:document.getElementById('citationUseBibliography').checked?citationLookup.parent:null}),signal:controller.signal});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Citation lookup failed.');
    if(generation!==citationLookup.generation)return;
    citationLookup.groups=result.groups||[];renderCitationCandidates();
    status.textContent=result.candidateCount?`${result.candidateCount} possible paper${result.candidateCount===1?'':'s'}. Select the title from your bibliography.`:'No papers selected. Refine the search or paste a full reference.';
  } catch(error) {
    if(generation===citationLookup.generation)status.textContent=error.name==='AbortError'?'Search timed out. Try again or add a title word.':'Online lookup is unavailable. Try again shortly.';
  } finally {
    clearTimeout(timer);if(generation===citationLookup.generation)refine.disabled=false;
  }
}
async function addInTextCitations(text) {
  const paper=state.papers.find(p=>p.id===state.selectedId);
  citationLookup.parent=paper?{id:paper.id,title:paper.title,bibliographyText:paper.bibliographyText||extractBibliographyText(paper.text||''),text:paper.text||''}:null;
  const input=document.getElementById('citationUseBibliography');input.checked=Boolean(citationLookup.parent?.bibliographyText);input.disabled=!citationLookup.parent?.bibliographyText;
  document.getElementById('citationBibliographyLabel').textContent=citationLookup.parent?.bibliographyText?'Use bibliography from '+paper.title:paper?'No bibliography text available for the selected paper':'Select a paper to use its bibliography';
  document.getElementById('citationLookupContext').value='';
  await searchInTextCitations(text);
}
document.getElementById('citationLookupClose')?.addEventListener('click',closeCitationLookup);
document.getElementById('citationLookupDialog')?.addEventListener('cancel',event=>{event.preventDefault();closeCitationLookup();});
document.getElementById('citationLookupForm')?.addEventListener('submit',event=>{event.preventDefault();searchInTextCitations(citationLookup.text,document.getElementById('citationLookupContext').value);});
document.getElementById('citationLookupAdd')?.addEventListener('click',async()=>{
  if(citationLookup.busy)return;
  const selectedGroups=[...citationLookup.selected.keys()];
  const chosen=[...citationLookup.selected].map(([group,index])=>citationLookup.groups[group]?.candidates[index]).filter(Boolean);
  if(!chosen.length)return;
  const generation=citationLookup.generation,controller=new AbortController();citationLookup.controller=controller;citationLookup.busy=true;syncCitationLookupSelection();
  const status=document.getElementById('citationLookupStatus'),refine=document.getElementById('citationLookupSearch');refine.disabled=true;
  const timer=setTimeout(()=>controller.abort(),35000);
  try {
    const response=await fetch(backendUrl('/api/metadata/citation/verify'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({papers:chosen}),signal:controller.signal});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Verification failed');
    if(generation!==citationLookup.generation)return;
    const papers=(result.results||[]).filter(row=>row.verified&&row.metadata?.metadataVerification?.verified)
      .map(row=>normalizeImportedPaper({...row.metadata,name:row.metadata.title,text:row.metadata.abstract||'',metadataCheckedAt:row.verification?.checkedAt||new Date().toISOString(),
        metadataMatch:{matched:true,strategy:'doi'},metadataNote:'DOI, title, authors and publication dates verified.'},'Verified citation'));
    const failures=(result.results||[]).filter(row=>!row.verified);
    if(!papers.length){status.textContent=failures.map(row=>row.reason).join(' ')||'No DOI records could be verified. Nothing added.';return;}
    const added=addParsedPapers(papers);state.selectedId=state.papers.find(p=>paperIdentityKey(p)===paperIdentityKey(papers[0]))?.id||papers[0].id;
    render();
    if(failures.length){
      for(const [group,index] of [...citationLookup.selected])if((result.results||[])[selectedGroups.indexOf(group)]?.verified)citationLookup.selected.delete(group);
      status.textContent=`Added ${added.added} verified papers. `+failures.map(row=>row.reason).join(' ');
    } else closeCitationLookup();
    showToast(`Added ${added.added} verified paper${added.added===1?'':'s'}.`);
  } catch(error) {
    if(generation===citationLookup.generation)status.textContent='DOI verification is unavailable. Nothing added; retry shortly.';
  } finally {
    clearTimeout(timer);if(citationLookup.controller===controller)citationLookup.busy=false;if(generation===citationLookup.generation){refine.disabled=false;syncCitationLookupSelection();}
  }
});
