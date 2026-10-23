/* Pulse Release Highlights Splash Screen: appears once per new version. */
const PulseWhatsNew = (() => {
  const CURRENT_VERSION = '2.1.9';
  const STORAGE_KEY = 'pulse_last_seen_release';

  function createDialog() {
    let dialog = document.getElementById('whatsNewSplashDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'whatsNewSplashDialog';
      dialog.className = 'pulse-tool-dialog whats-new-dialog';
      dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-labelledby','whatsNewTitle');
      dialog.innerHTML = `
        <header>
          <div class="whats-new-header-title">
            <span class="whats-new-badge">v${CURRENT_VERSION}</span>
            <h2 id="whatsNewTitle">What's New in Pulse</h2>
            <p class="subtle">Network map visibility, clean subfield envelopes, Library Date added, and UI polish.</p>
          </div>
          <button type="button" data-close-tool aria-label="Close">×</button>
        </header>
        <div class="whats-new-feature-grid">
          <div class="whats-new-card">
            <div class="whats-new-icon">🗺️</div>
            <div class="whats-new-content">
              <h3>Map Visibility & Camera Fitting</h3>
              <p>Network papers, rendered labels, and topic hulls reliably fit above floating controls, with instant recovery from partially clipped or zero-dimension camera states.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">🌐</div>
            <div class="whats-new-content">
              <h3>Refined Subfield Envelopes</h3>
              <p>Automatic organic boundary envelopes demarcate research clusters cleanly without cluttering floating badges, padding collinear clusters seamlessly.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">📅</div>
            <div class="whats-new-content">
              <h3>Library Date Added Column</h3>
              <p>Sortable and persisted ISO timestamps for imported papers, surviving reloads and duplicate imports with remembered sorting preferences.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">🫧</div>
            <div class="whats-new-content">
              <h3>Trends Topic Map</h3>
              <p>Trends groups every paper by topic as bubbles with papers in orbit. The map, year chart and Groups → Concepts list share unified selections.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">📋</div>
            <div class="whats-new-content">
              <h3>PRISMA 2020 & Screening</h3>
              <p>Interactive PRISMA 2020 SVG flow diagrams, dual-reviewer blind mode with Cohen's &kappa; agreement metrics, and active-learning candidate ranking.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">🔬</div>
            <div class="whats-new-content">
              <h3>Evidence Consensus & Backups</h3>
              <p>Targeted PDF evidence extraction flags concordant vs. conflicting findings, paired with two-tier SQLite hydration and single-file backups.</p>
            </div>
          </div>
        </div>
        <div class="whats-new-footer">
          <button id="whatsNewDismissBtn" class="mac-btn primary" type="button">Explore Pulse ${CURRENT_VERSION}</button>
        </div>
      `;
      document.body.append(dialog);
      dialog.querySelectorAll('[data-close-tool], #whatsNewDismissBtn').forEach(btn => {
        btn.onclick = () => {
          dialog.close();
        };
      });
      dialog.addEventListener('close',()=>{
        state.lastSeenRelease=CURRENT_VERSION;
        try { localStorage.setItem(STORAGE_KEY,CURRENT_VERSION); } catch (_) {}
        if(state.autosaveReady)saveLibrary();
      });
    }
    return dialog;
  }

  function isAutomatedTest() {
    return Boolean(
      window.navigator.webdriver ||
      window.__PW_REPLAY__ ||
      window.__playwright ||
      window._pulseTestHarness
    );
  }

  function show(force = false) {
    if (!force && isAutomatedTest()) return;
    if(!force&&!state.autosaveReady)return;
    let lastSeen = state.lastSeenRelease || null;
    try { lastSeen ||= localStorage.getItem(STORAGE_KEY); } catch (_) {}
    if (force || lastSeen !== CURRENT_VERSION) {
      const dialog = createDialog();
      if (!dialog.open) dialog.showModal();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Check and show splash screen on update launch for real user sessions
    if(state.autosaveReady)show(false);

    // Provide re-open button from settings if available
    const settingsPanel = document.querySelector('.settings-card') || document.getElementById('settingsPanel');
    if (settingsPanel && !document.getElementById('openWhatsNewBtn')) {
      const btn = document.createElement('button');
      btn.id = 'openWhatsNewBtn';
      btn.type = 'button';
      btn.className = 'button secondary';
      btn.textContent = `What's New in ${CURRENT_VERSION}`;
      btn.style.marginTop = '10px';
      btn.onclick = () => show(true);
      settingsPanel.querySelector('.settings-footer, footer, div:last-child')?.append(btn);
    }
  });
  document.addEventListener('pulse:library-ready',()=>show(false));

  return { show, version: CURRENT_VERSION };
})();
