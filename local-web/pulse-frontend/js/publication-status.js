const publicationChecks=new Map();
function publicationMarkup(paper){
  const notices=Array.isArray(paper.publicationNotices)?paper.publicationNotices:[];
  const status=paper.publicationRole==='notice'?'notice':paper.isRetracted?'retracted':paper.publicationStatus?.status||'';
  const labels={retracted:'Retracted',concern:'Publication concern',corrected:'Correction recorded',updated:'Publication update',notice:'Publication notice'};
  const links=notices.filter(notice=>notice&&typeof notice==='object').map(notice=>{
    const doi=normalizeDoi(notice.doi||'');if(!doi)return '';
    const label=notice.relation==='updates'?'Original article':String(notice.type||'Publication update').replaceAll('-',' ');
    return `<a href="https://doi.org/${encodeURIComponent(doi)}" target="_blank" rel="noreferrer">${escapeHtml(label)}${notice.date?' · '+escapeHtml(notice.date):''} ↗</a>`;
  });
  const versions=(Array.isArray(paper.publicationRelations)?paper.publicationRelations:[]).filter(relation=>relation&&normalizeDoi(relation.doi||''));
  for(const relation of versions){const label=relation.type==='is-preprint-of'?'Published version':relation.type==='has-preprint'?'Preprint version':'Related version';
    links.push(`<a href="https://doi.org/${encodeURIComponent(normalizeDoi(relation.doi))}" target="_blank" rel="noreferrer">${label} ↗</a>`);}
  if(!labels[status]&&!links.length)return '';
  return `<div class="publication-notices ${status==='retracted'||status==='concern'?'is-warning':''}">${labels[status]?`<strong>${labels[status]}</strong>`:''}${[...new Set(links)].join(' ')}<small>${escapeHtml(paper.publicationStatus?.source||notices[0]?.source||'Registry relationship')}${paper.publicationStatus?.checkedAt?' · '+escapeHtml(new Date(paper.publicationStatus.checkedAt).toLocaleDateString()):''}</small></div>`;
}
async function checkSelectedPublication(paper){
  const doi=normalizeDoi(paper.doi||'');if(!doi||!(paper.doiVerified||paper.metadataVerification?.verified))return;
  const existing=publicationChecks.get(doi),now=Date.now();
  if(existing&&(existing.pending||now-existing.at<(existing.available?3600000:60000)))return;
  if(paper.publicationStatus?.checkedAt&&now-Date.parse(paper.publicationStatus.checkedAt)<3600000)return;
  publicationChecks.set(doi,{pending:true,at:now});
  try{
    const response=await fetch(backendUrl('/api/papers/status'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({doi}),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok)throw Error('Status unavailable');
    publicationChecks.set(doi,{pending:false,at:Date.now(),available:result.available});
    const current=state.papers.find(item=>item.id===paper.id);
    if(!result.available||!current||normalizeDoi(current.doi||'')!==doi)return;
    const metadata=result.metadata||{};
    for(const field of ['publicationStatus','publicationRelations','publicationNotices','publicationRole'])if(metadata[field]!==undefined)current[field]=metadata[field];
    if(metadata.isRetracted===true)current.isRetracted=true;
    scheduleAutosave();if(state.selectedId===current.id)renderDetails();
  }catch{publicationChecks.set(doi,{pending:false,at:Date.now(),available:false});}
  while(publicationChecks.size>512)publicationChecks.delete(publicationChecks.keys().next().value);
}
