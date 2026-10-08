/* Paged Mendeley import with local edit protection and removal tombstones. */
function mendeleyRemoteKey(account, id) { return account + ':' + id; }
function rememberMendeleyRemovals(papers) {
  const ignored = new Set(state.mendeleyIgnored || []);
  for (const paper of papers) if (paper.mendeleySource) {ignored.add(mendeleyRemoteKey(paper.mendeleySource.account, paper.mendeleySource.id)); ignored.add(mendeleyRemoteKey(paper.mendeleySource.account,'identity:'+paperIdentityKey(paper)));}
  state.mendeleyIgnored = [...ignored];
}
function mergeMendeleyRecords(records, account) {
  const ignored = new Set(state.mendeleyIgnored || []);
  let added=0, updated=0, preserved=0, removed=0;
  for (const record of records) {
    const key=mendeleyRemoteKey(account, record.remoteId);
    if (ignored.has(key) || ignored.has(mendeleyRemoteKey(account,'identity:'+paperIdentityKey(record)))) {removed++; continue;}
    let paper=state.papers.find(p=>p.mendeleySource?.account===account && p.mendeleySource.id===record.remoteId);
    if (!paper) paper=state.papers.find(p=>paperIdentityKey(p)===paperIdentityKey(record));
    const snapshot=Object.fromEntries([...bibliographicFields,'paperKeywords'].map(k=>[k,record[k] || (k==='authors' || k==='paperKeywords' ? [] : '')]));
    if (!paper) {
      paper=normalizeImportedPaper({...record,name:record.title},'Mendeley');
      state.papers.push(paper);added++;
    } else {
      const previous=paper.mendeleySource?.account===account ? paper.mendeleySource.snapshot : null;
      const localDoi=normalizeDoi(paper.doi || '').toLowerCase(), incomingDoi=normalizeDoi(record.doi || '').toLowerCase();
      if (localDoi && incomingDoi && localDoi!==incomingDoi) {preserved++; continue;}
      let edited=false, changed=false;
      for (const field of bibliographicFields) {
        const local=paper[field], incoming=record[field];
        const untouched=previous && JSON.stringify(local || '')===JSON.stringify(previous[field] || '');
        if ((!local || (Array.isArray(local) && !local.length) || untouched) && incoming && JSON.stringify(local)!==JSON.stringify(incoming)) {
          paper[field]=incoming;changed=true;
        } else if (incoming && JSON.stringify(local || '')!==JSON.stringify(incoming)) edited=true;
      }
      paper.paperKeywords=[...new Set([...(paper.paperKeywords || []), ...(record.paperKeywords || [])])];
      if (changed) updated++;
      if (edited) preserved++;
    }
    paper.mendeleySource={account,id:record.remoteId,snapshot};
  }
  return {added,updated,preserved,removed};
}
async function syncMendeleyLibrary(manual=false) {
  if (managerUi.syncing || !state.autosaveReady || state.libraryMutation || state.clearingLibrary || !managerUi.status?.mendeley?.connected) return;
  if (!manual && (state.mendeleySyncPaused || managerUi.status.mendeley.automaticSync===false)) return;
  managerUi.syncing=true;const epoch=state.syncEpoch || 0;
  managerUi.syncMessage='Checking your Mendeley library…';updateManagers();
  try {
    const records=[],seenPages=new Set();let page=null,account=null,skipped=0;
    do {
      if ((state.syncEpoch || 0)!==epoch) throw new Error('Sync paused because your workspace changed.');
      const result=await pulseRecordsRequest('/api/managers/mendeley/sync-page',{page,accountId:account});
      if ((state.syncEpoch || 0)!==epoch) throw new Error('Sync paused because your workspace changed.');
      if (account && account!==result.accountId) throw new Error('Your Mendeley account changed. Start sync again.');
      account=result.accountId;records.push(...result.items);skipped+=result.skipped || 0;page=result.next;
      if (page && seenPages.has(page)) throw new Error('Mendeley repeated a page. Please try again.');
      if (page) seenPages.add(page);
      if (records.length>10000 || seenPages.size>100) throw new Error('This library is larger than the current sync limit. Import an exported library file instead.');
      managerUi.syncMessage=`Checking ${records.length} citations…`;updateManagers();
    } while (page);
    const result=mergeMendeleyRecords(records,account);
    state.mendeleySyncPaused=false;render();
    if (!await saveLibrary()) throw new Error('Imported details are visible but could not be saved. Retry after checking the connection.');
    await pulseRecordsRequest('/api/managers/mendeley/sync-preferences',{completed:true,accountId:account});
    managerUi.syncMessage=`${result.added} added · ${result.updated} updated${result.preserved ? ' · '+result.preserved+' local edits kept' : ''}${result.removed ? ' · '+result.removed+' removed papers kept out' : ''}${skipped ? ' · '+skipped+' records without a title skipped' : ''}.`;
    showToast('Mendeley library synced.');
  } catch(error) {managerUi.syncMessage=error.message;}
  finally {managerUi.syncing=false;updateManagers();}
}
document.getElementById('mendeleySyncNow').addEventListener('click',()=>syncMendeleyLibrary(true));
document.getElementById('mendeleyAutomaticSync').addEventListener('change',async event=>{
  const automatic=event.target.checked;
  try {
    await pulseRecordsRequest('/api/managers/mendeley/sync-preferences',{automatic});
    managerUi.status.mendeley.automaticSync=automatic;
    if (automatic) {state.mendeleySyncPaused=false;syncMendeleyLibrary();}
    else managerUi.syncMessage='Automatic sync paused. Use Sync now when you want to import changes.';
  } catch(error) {managerUi.syncMessage=error.message;}
  updateManagers();
});
// Sync follows the connection state without reopening dialogs or requesting credentials.
let lastAutomaticMendeleySync=0;
setInterval(()=>{
  if (!managerUi.status?.mendeley?.connected || managerUi.status.mendeley.automaticSync===false || state.mendeleySyncPaused) return;
  if (Date.now()-lastAutomaticMendeleySync<300000) return;
  lastAutomaticMendeleySync=Date.now();syncMendeleyLibrary();
},5000);
