// Native webviews can suppress target=_blank windows. Send their external
// links through Pulse's navigation handler, which opens the system browser.
// Regular browsers retain normal link behavior, including modifier keys.
document.addEventListener('click', event => {
  if (event.defaultPrevented || !window.__TAURI_INTERNALS__) return;
  const link = event.target.closest?.('a[target="_blank"][href]');
  if (!link || link.hasAttribute('download')) return;
  let url;
  try { url = new URL(link.href, window.location.href); }
  catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === window.location.origin || url.username || url.password) return;
  event.preventDefault();
  window.location.assign(url.href);
});
