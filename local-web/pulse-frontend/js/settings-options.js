/* A single preferences surface; existing controls keep their original IDs. */
const PulseSettings = (() => {
  const pages={
    general:['General','Personalize the way Pulse looks on this computer.'],
    search:['Search & discovery','Manage scholarly sources, search quality and ranking preferences.'],
    backend:['AI & models','Choose the services and models used for your research.'],
    extraction:['Paper scanning','Choose how Pulse reads papers you import.'],
    managers:['Reference managers','Connect your citation libraries and manage account access.'],
    sync:['Sync & privacy','Control library sync and the information you share.'],
    storage:['Storage & recovery','Review your local library and manage stored data.'],
    updates:['Updates','Keep Pulse up to date from within the app.']
  };
  let ready=false,previousFocus=null,themeQueue=Promise.resolve(),themeRevision=0;
  let savedTheme=window.__PULSE_THEME_PREFERENCE__||null,themeJobs=0;
  const byId=id=>document.getElementById(id);
  function pageChanged(tab){
    if(!ready)return;
    byId('settingsSearch').value='';
    byId('settingsSearchResults').hidden=true;
    document.querySelector('#settingsPanel .options-body').hidden=false;
    byId('settingsPageTitle').textContent=pages[tab][0];byId('settingsPageDescription').textContent=pages[tab][1];
    byId('settingsApplyButton').hidden=!['search','backend','extraction'].includes(tab);
    byId('settingsFooterStatus').textContent=tab==='general'?'Appearance is saved automatically on this computer.':
      ['search','backend','extraction'].includes(tab)?'Use Apply changes to save your preferences.':'Use the controls in this category to make changes.';
    document.querySelector('#settingsPanel .options-body').scrollTop=0;
  }
  function opened(){
    if(!ready)return;
    previousFocus=document.activeElement;
    setSettingsTab(state.settingsTab||'general');
    byId('settingsSearch').focus({preventScroll:true});
  }
  function closed(){
    if(ready&&byId('settingsPanel').contains(document.activeElement))previousFocus?.focus?.({preventScroll:true});
  }
  function themeChanged(theme,force=false){
    if(!ready)return;
    byId('settingsTheme').value=theme;
    document.querySelectorAll('input[name=pulseTheme]').forEach(input=>{input.checked=input.value===theme;});
    if(theme===savedTheme&&!themeJobs&&!force){byId('themePreferenceStatus').textContent='Appearance saved. It will be restored when Pulse reopens.';byId('settingsThemeRetry').hidden=true;return;}
    const revision=++themeRevision;
    themeJobs++;
    byId('themePreferenceStatus').textContent='Saving appearance…';
    byId('settingsThemeRetry').hidden=true;
    const pending=themeQueue.catch(()=>{}).then(async()=>{
      if(revision!==themeRevision)return;
      try {
        await backendReady;
        const response=await fetch(backendUrl('/api/appearance'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:JSON.stringify({theme})});
        const data=await response.json();if(!response.ok)throw Error(data.error||'Appearance could not be saved.');
        savedTheme=data.theme;
        if(revision===themeRevision)byId('themePreferenceStatus').textContent='Appearance saved. It will be restored when Pulse reopens.';
      }catch(error){if(revision===themeRevision){byId('themePreferenceStatus').textContent='Theme applied, but it could not be saved for next time.';byId('settingsThemeRetry').hidden=false;}}
    });
    themeQueue=pending;state.pendingLibraryWrites ||= new Set();state.pendingLibraryWrites.add(pending);
    pending.finally(()=>{themeJobs--;state.pendingLibraryWrites.delete(pending);});
  }
  function search(){
    const query=byId('settingsSearch').value.trim().toLocaleLowerCase(),results=byId('settingsSearchResults');
    document.querySelector('#settingsPanel .options-body').hidden=!!query;results.hidden=!query;
    if(!query){pageChanged(state.settingsTab||'general');return;}
    byId('settingsPageTitle').textContent='Find a setting';byId('settingsPageDescription').textContent='Search across all preferences. Select a result to open its category.';
    byId('settingsApplyButton').hidden=true;
    const terms=query.split(/\s+/),matches=[];
    document.querySelectorAll('#settingsPanel [data-settings-pane]').forEach(pane=>{
      const key=pane.dataset.settingsPane;
      pane.querySelectorAll('.mac-group-card').forEach(card=>{
        const title=card.querySelector('.mac-group-title')?.textContent||pages[key][0];
        const text=(pages[key][0]+' '+card.textContent).toLocaleLowerCase();
        const labels=(title+' '+[...card.querySelectorAll('label')].map(label=>label.textContent).join(' ')).toLocaleLowerCase();
        if(terms.every(term=>text.includes(term)))matches.push({key,title,card,score:title.toLocaleLowerCase().includes(query)?100:terms.every(term=>labels.includes(term))?50:0});
      });
    });
    results.replaceChildren();const count=document.createElement('p');count.setAttribute('role','status');count.textContent=matches.length?`${matches.length} matching ${matches.length===1?'group':'groups'}`:'No matching settings. Try “theme”, “Mendeley”, “API key” or “updates”.';results.append(count);
    for(const match of matches.sort((a,b)=>b.score-a.score)){
      const button=document.createElement('button');button.type='button';button.className='options-search-result';
      const title=document.createElement('strong'),category=document.createElement('span');title.textContent=match.title;category.textContent=pages[match.key][0];button.append(title,category);
      button.onclick=()=>{setSettingsTab(match.key);match.card.scrollIntoView({block:'nearest'});match.card.classList.add('options-setting-highlight');setTimeout(()=>match.card.classList.remove('options-setting-highlight'),1600);(match.card.querySelector('input,select,button,a')||byId('settingsSearch')).focus({preventScroll:true});};results.append(button);
    }
  }
  document.addEventListener('DOMContentLoaded',()=>{
    ready=true;
    byId('settingsTheme').onchange=event=>applyFrankTheme(event.target.value);
    byId('settingsThemeRetry').onclick=()=>themeChanged(document.documentElement.getAttribute('data-pulse-theme'),true);
    document.querySelectorAll('input[name=pulseTheme]').forEach(input=>input.onchange=()=>{if(input.checked)applyFrankTheme(input.value);});
    byId('settingsSearch').oninput=search;
    byId('settingsDoneButton').onclick=()=>setSettingsOpen(false);
    byId('settingsOpenRecovery').onclick=()=>byId('libraryRecovery').click();
    byId('settingsApplyButton').onclick=async()=>{
      const button=byId('settingsApplyButton');button.disabled=true;byId('settingsFooterStatus').textContent='Saving preferences…';
      try{await themeQueue;if(await state.settingsLoadPromise===false)throw Error('Settings unavailable');const saved=await saveBackendSettings();byId('settingsFooterStatus').textContent=saved?'Preferences saved.':'Preferences could not be saved. Check the connection status and try again.';}
      catch(error){byId('settingsFooterStatus').textContent='Preferences could not be saved. Try again.';}
      finally{button.disabled=false;}
    };
    const nav=document.querySelector('#settingsPanel .options-nav');
    byId('settingsSearch').parentElement.querySelector('kbd').textContent=/Mac|iPhone|iPad/.test(navigator.platform)?'⌘F':'Ctrl+F';
    nav.addEventListener('keydown',event=>{
      const buttons=[...nav.querySelectorAll('[data-settings-tab]')],index=buttons.indexOf(event.target);
      if(index<0)return;
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:['ArrowDown','ArrowRight'].includes(event.key)?(index+1)%buttons.length:['ArrowUp','ArrowLeft'].includes(event.key)?(index-1+buttons.length)%buttons.length:null;
      if(next!==null){event.preventDefault();setSettingsTab(buttons[next].dataset.settingsTab);buttons[next].focus();}
    });
    themeChanged(document.documentElement.getAttribute('data-pulse-theme')||'system');
    pageChanged(state.settingsTab||'general');
  });
  document.addEventListener('keydown',event=>{
    if(!ready||byId('settingsPanel').hidden||document.querySelector('dialog[open]'))return;
    if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='f'){event.preventDefault();event.stopImmediatePropagation();byId('settingsSearch').focus();byId('settingsSearch').select();}
    else if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(byId('settingsSearch').value){byId('settingsSearch').value='';search();byId('settingsSearch').focus();}else setSettingsOpen(false);}
    else if(event.key==='Tab'){
      const nodes=[...byId('settingsPanel').querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')].filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
      const first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  },true);
  return {opened,closed,pageChanged,themeChanged,pages};
})();
