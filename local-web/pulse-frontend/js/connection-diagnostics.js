async function checkPulseConnections() {
  const button=document.getElementById('checkPulseConnections'),list=document.getElementById('pulseConnectionResults');
  button.disabled=true;list.textContent='Checking the library and configured connections…';
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(backendUrl('/api/connections/check'),{method:'POST',headers:apiHeaders({'Content-Type':'application/json'}),body:'{}',signal:controller.signal});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Connection check failed.');
    list.innerHTML=result.checks.map(check=>`<div class="pulse-connection-result" data-status="${escapeHtml(check.status)}"><strong>${escapeHtml(check.name)}</strong><p>${escapeHtml(check.message)}</p></div>`).join('');
    list.innerHTML+=`<small>${result.runtime.bundledPython?'Python is included in this app.':'Development Python '+escapeHtml(result.runtime.pythonVersion)+'.'}</small>`;
  } catch(error) {list.textContent=error.name==='AbortError'?'The check took too long. Check your connection and try again.':error.message;}
  finally{clearTimeout(timer);button.disabled=false;}
}
document.addEventListener('DOMContentLoaded',()=>document.getElementById('checkPulseConnections')?.addEventListener('click',checkPulseConnections));
