(() => {
  const menu = document.getElementById('mapToolsMenu');
  const summary = menu?.querySelector('summary');
  const workspace = menu?.closest('.pulse-workspace-cols');
  const footer = menu?.closest('.map-controls-footer');
  const dock = menu?.closest('.canvas-dock-modern');
  const mapViewport = workspace?.querySelector('.map-viewport');
  const library = workspace?.querySelector('#colLibrary');
  if (!menu || !summary || !workspace || !footer || !dock || !mapViewport) return;

  function sizeMenu() {
    const workspaceBox = workspace.getBoundingClientRect();
    const mapBox = mapViewport.getBoundingClientRect();
    // Full-width Bibliography hides the map; keep its navigation available.
    const libraryBox = library?.getBoundingClientRect();
    const bounds = mapBox.width > 0 ? mapBox : libraryBox?.width > 0 ? libraryBox : workspaceBox;
    footer.style.setProperty('--map-dock-left', `${bounds.left - workspaceBox.left}px`);
    footer.style.setProperty('--map-dock-width', `${bounds.width}px`);
    const dockBox = dock.getBoundingClientRect();
    workspace.style.setProperty('--map-dock-height', `${Math.ceil(dockBox.height)}px`);
    const available = Math.max(0, dockBox.top - bounds.top - 16);
    menu.style.setProperty('--map-tools-height', `${available}px`);
  }

  function closeMenu(returnFocus = false) {
    if (!menu.open) return;
    menu.open = false;
    if (returnFocus) summary.focus({ preventScroll: true });
  }

  let layoutFrame = 0;
  function scheduleLayout() {
    if (layoutFrame) return;
    // Apply geometry after ResizeObserver delivery so resizing the dock cannot
    // trigger another notification in the same delivery cycle.
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      sizeMenu();
    });
  }

  // Native details supplies keyboard opening and the expanded state.
  menu.addEventListener('toggle', scheduleLayout);
  window.addEventListener('resize', scheduleLayout);
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(dock);
    observer.observe(workspace);
    observer.observe(mapViewport);
    if (library) observer.observe(library);
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
