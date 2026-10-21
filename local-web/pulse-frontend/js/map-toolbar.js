(() => {
  const menu = document.getElementById('mapToolsMenu');
  const summary = menu?.querySelector('summary');
  if (!menu || !summary) return;

  function sizeMenu() {
    const canvas = menu.closest('.pulse-col-canvas');
    const dock = menu.closest('.canvas-dock-modern');
    if (!canvas || !dock) return;
    const available = Math.max(0, dock.getBoundingClientRect().top - canvas.getBoundingClientRect().top - 16);
    menu.style.setProperty('--map-tools-height', `${available}px`);
  }

  function closeMenu(returnFocus = false) {
    if (!menu.open) return;
    menu.open = false;
    if (returnFocus) summary.focus({ preventScroll: true });
  }

  // Native details supplies keyboard opening and the expanded state.
  menu.addEventListener('toggle', sizeMenu);
  window.addEventListener('resize', sizeMenu);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(sizeMenu);
    observer.observe(menu.closest('.canvas-dock-modern'));
    observer.observe(menu.closest('.pulse-col-canvas'));
  }
  sizeMenu();
  document.addEventListener('pointerdown', event => {
    if (!menu.contains(event.target)) closeMenu();
  });
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu(true);
  });
  menu.addEventListener('focusout', event => {
    if (event.relatedTarget && !menu.contains(event.relatedTarget)) closeMenu();
  });
  menu.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    const panel = document.getElementById(button.getAttribute('aria-controls'));
    closeMenu(true);
    // Panel handlers have already run. Keyboard users land in the opened panel.
    if (panel && !panel.hidden) panel.querySelector('button, input, select, textarea')?.focus({ preventScroll: true });
  });
})();
