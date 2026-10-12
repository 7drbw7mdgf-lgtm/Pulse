const citationLookup = {generation:0, controller:null, text:'', groups:[], selected:new Map()};
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
  citationLookup.generation++;citationLookup.controller?.abort();
  document.getElementById('citationLookupDialog').close();
}
function syncCitationLookupSelection() {
  const button=document.getElementById('citationLookupAdd');
  button.disabled=!citationLookup.selected.size;
  button.textContent=`Add selected${citationLookup.selected.size?' ('+citationLookup.selected.size+')':''}`;
}
function renderCitationCandidates() {
  const container=document.getElementById('citationLookupResults');
  container.innerHTML=citationLookup.groups.map((group,i)=>`<section class="citation-lookup-group">
    <h3>${escapeHtml(group.citation)}</h3>
    ${group.suffix?'<p class="subtle">The year suffix identifies an entry in the original bibliography. Choose its title below.</p>':''}
    ${group.partial?'<p class="record-feedback">One source is unavailable. These matches are from the responding source.</p>':''}
    ${group.candidates.length?`<ul>${group.candidates.map((paper,j)=>`<li><label><input type="radio" name="citation-group-${i}" data-citation-group="${i}" data-citation-index="${j}"><span><strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml((paper.authors||[]).join(', '))} · ${escapeHtml(paper.year||'')} ${paper.journal?' · '+escapeHtml(paper.journal):''}</small><small>${escapeHtml(paper.doi?'DOI: '+paper.doi:'No DOI indexed')} · ${escapeHtml((paper.lookupSources||[paper.metadataSource]).filter(Boolean).join(' + '))}</small></span></label>${paper.doi?`<a href="https://doi.org/${escapeHtml(normalizeDoi(paper.doi))}" target="_blank" rel="noreferrer">Open paper ↗</a>`:''}</li>`).join('')}</ul>`:
      `<p class="subtle">${group.partial?'Online lookup could not complete. Try again shortly.':'No matching first author and year found. Add a title word or paste the full reference.'}</p>`}
  </section>`).join('');
  container.querySelectorAll('[data-citation-group]').forEach(input=>input.addEventListener('change',()=>{
    citationLookup.selected.set(Number(input.dataset.citationGroup),Number(input.dataset.citationIndex));syncCitationLookupSelection();
  }));
}
async function searchInTextCitations(text,context='') {
  const dialog=document.getElementById('citationLookupDialog');
  citationLookup.controller?.abort();const controller=new AbortController();citationLookup.controller=controller;
  const generation=++citationLookup.generation;citationLookup.text=text;citationLookup.groups=[];citationLookup.selected.clear();
  const status=document.getElementById('citationLookupStatus'),results=document.getElementById('citationLookupResults'),refine=document.getElementById('citationLookupSearch');
  status.textContent='Searching author and publication year online…';results.replaceChildren();refine.disabled=true;syncCitationLookupSelection();
  if(!dialog.open)dialog.showModal();
  const timer=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(backendUrl('/api/metadata/citation'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({text,context}),signal:controller.signal});
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
  document.getElementById('citationLookupContext').value='';
  await searchInTextCitations(text);
}
document.getElementById('citationLookupClose')?.addEventListener('click',closeCitationLookup);
document.getElementById('citationLookupDialog')?.addEventListener('cancel',event=>{event.preventDefault();closeCitationLookup();});
document.getElementById('citationLookupForm')?.addEventListener('submit',event=>{event.preventDefault();searchInTextCitations(citationLookup.text,document.getElementById('citationLookupContext').value);});
document.getElementById('citationLookupAdd')?.addEventListener('click',()=>{
  const papers=[...citationLookup.selected].map(([group,index])=>citationLookup.groups[group]?.candidates[index]).filter(Boolean)
    .map(metadata=>normalizeImportedPaper({...metadata,name:metadata.title,text:metadata.abstract||'',metadataCheckedAt:new Date().toISOString(),
      metadataMatch:{matched:true,strategy:'in-text-citation'},metadataNote:'Selected from an online author–year lookup.'},'Citation lookup'));
  const result=addParsedPapers(papers);
  if(papers.length)state.selectedId=state.papers.find(p=>paperIdentityKey(p)===paperIdentityKey(papers[0]))?.id||papers[0].id;
  closeCitationLookup();render();showToast(`Added ${result.added} paper${result.added===1?'':'s'} from citations.`);
});
