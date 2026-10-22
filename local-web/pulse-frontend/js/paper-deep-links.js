/* Open a paper in this Pulse window from another Pulse page (such as a sandbox view): a same-origin
   'open-paper' message, or an #paper=ID / #pdf=ID link. Only papers already in the library open. */
(() => {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('pulse-workspace') : null;
  async function libraryReady() {
    for (let tries = 0; tries < 300 && !state.autosaveReady; tries++) await new Promise(resolve => setTimeout(resolve, 100));
  }
  async function openPaper(id, view) {
    await libraryReady();
    if (!state.papers.some(paper => paper.id === id)) {
      showToast('That paper is not in this library.');
      return false;
    }
    if (view === 'pdf' && typeof PulsePDF !== 'undefined') PulsePDF.open(id);
    else inspectPaper(id);
    return true;
  }
  channel?.addEventListener('message', async event => {
    const message = event.data || {};
    if (message.type !== 'open-paper' || typeof message.id !== 'string' || message.id.length > 200) return;
    channel.postMessage({ type: 'opened-paper', id: message.id, request: message.request, ok: await openPaper(message.id, message.view === 'pdf' ? 'pdf' : 'details') });
  });
  function openFromHash() {
    const match = location.hash.match(/^#(paper|pdf)=([^&]{1,200})$/);
    if (!match) return;
    history.replaceState(null, '', location.pathname + location.search);
    openPaper(decodeURIComponent(match[2]), match[1] === 'pdf' ? 'pdf' : 'details');
  }
  window.addEventListener('hashchange', openFromHash);
  document.addEventListener('DOMContentLoaded', openFromHash);
})();
