/* Keep the ribbon compact without losing the existing search controls. */
function updateSearchOptionsPill() {
  const summary=document.getElementById('searchOptionsSummary');
  const label=document.getElementById('searchOptionsState');
  if(!summary||!label)return;
  const scope=state.discoverySearchScope==='library'?'Library':'Online';
  const match=state.discoveryQueryMatch==='any'?'Any':'All';
  const tags=state.discoverySearchTags?.length||0;
  label.textContent=`${scope} · ${match}${tags?` · ${tags} tag${tags===1?'':'s'}`:''}`;
  summary.title=`${scope==='Library'?'My library':'Online papers'} · ${match} terms · ${state.discoveryRankingMode==='enhanced'?'Enhanced':'Fast'} ranking${tags?` · ${tags} selected tags`:''}`;
}

document.addEventListener('DOMContentLoaded',()=>{
  const menu=document.getElementById('searchOptionsMenu');
  const summary=document.getElementById('searchOptionsSummary');
  if(menu&&summary){
    const close=(restoreFocus=false)=>{
      menu.open=false;
      menu.querySelectorAll('details[open]').forEach(item=>{item.open=false;});
      if(restoreFocus)summary.focus();
    };
    document.getElementById('searchOptionsClose').addEventListener('click',()=>close(true));
    document.addEventListener('pointerdown',event=>{if(menu.open&&!menu.contains(event.target))close();});
    menu.addEventListener('focusout',event=>{
      // A rerender can remove a focused saved-search button. In that case,
      // retain the popup rather than treating the missing target as navigation.
      if(event.relatedTarget&&!menu.contains(event.relatedTarget))close();
    });
    menu.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;
      event.preventDefault();event.stopPropagation();
      const nested=event.target.closest('details[open]');
      if(nested&&nested!==menu){nested.open=false;nested.querySelector('summary').focus();}
      else close(true);
    });
    menu.addEventListener('toggle',()=>{
      if(!menu.open)menu.querySelectorAll('details[open]').forEach(item=>{item.open=false;});
    });
    updateSearchOptionsPill();
  }
  const library=document.getElementById('colLibrary');
  const filter=library?.querySelector('.library-search-filter');
  if(!filter)return;
  const toolbar=document.createElement('div');
  toolbar.className='library-compact-toolbar';
  filter.before(toolbar);
  const status=document.getElementById('researchFilterStatus');
  library.querySelector('.col-header-left')?.append(status);
  for(const selector of ['.library-organise-tools','.research-library-tools','.library-search-filter']){
    const element=library.querySelector(selector);
    if(element)toolbar.append(element);
  }
});
