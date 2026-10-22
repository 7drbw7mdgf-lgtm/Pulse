/* Pulse Release Highlights Splash Screen: appears once per new version. */
const PulseWhatsNew = (() => {
  const CURRENT_VERSION = '2.1.7';
  const STORAGE_KEY = 'pulse_last_seen_release';

  function createDialog() {
    let dialog = document.getElementById('whatsNewSplashDialog');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'whatsNewSplashDialog';
      dialog.className = 'pulse-tool-dialog whats-new-dialog';
      dialog.innerHTML = `
        <header>
          <div class="whats-new-header-title">
            <span class="whats-new-badge">v${CURRENT_VERSION}</span>
            <h2>What's New in Pulse</h2>
            <p class="subtle">Analytical graph topology, systematic screening, and large library scaling.</p>
          </div>
          <button type="button" data-close-tool aria-label="Close">×</button>
        </header>
        <div class="whats-new-feature-grid">
          <div class="whats-new-card">
            <div class="whats-new-icon">🌐</div>
            <div class="whats-new-content">
              <h3>Subfield Boundary Envelopes</h3>
              <p>Automatic organic boundary hulls demarcate research clusters with auto-labeled thematic topics derived from high-centrality papers.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">⚡</div>
            <div class="whats-new-content">
              <h3>Citation Cascade Animation</h3>
              <p>The timeline player visualizes streaming citation influence propagating outward from seminal seed papers to translational breakthroughs.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">🌉</div>
            <div class="whats-new-content">
              <h3>Bridge Papers & Bottlenecks</h3>
              <p>Brandes' betweenness centrality isolates the seminal connector papers bridging two distinct disciplines with one-click map halo highlighting.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">📋</div>
            <div class="whats-new-content">
              <h3>PRISMA 2020 & Blind Reconciliation</h3>
              <p>Interactive PRISMA 2020 SVG flow diagrams, dual-reviewer blind mode with Cohen's &kappa; agreement metrics, and Rocchio active-learning candidate ranking.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">🔬</div>
            <div class="whats-new-content">
              <h3>Section-Targeted Evidence & Consensus</h3>
              <p>Multi-column PDF layout parsing extracts methods and limitations with >80% fill rates and groups findings to flag concordant vs. conflicting results.</p>
            </div>
          </div>
          <div class="whats-new-card">
            <div class="whats-new-icon">🚀</div>
            <div class="whats-new-content">
              <h3>Two-Tier Lazy Hydration & Backups</h3>
              <p>Metadata-first SQLite loading cuts startup heap by ~85% on 10,000+ papers, paired with single-file portable <code>.pulse-workspace</code> archive backups.</p>
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
          try { localStorage.setItem(STORAGE_KEY, CURRENT_VERSION); } catch (_) {}
        };
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
    let lastSeen = null;
    try { lastSeen = localStorage.getItem(STORAGE_KEY); } catch (_) {}
    if (force || lastSeen !== CURRENT_VERSION) {
      const dialog = createDialog();
      if (!dialog.open) dialog.showModal();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Check and show splash screen on update launch for real user sessions
    if (!isAutomatedTest()) {
      setTimeout(() => show(false), 800);
    }

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

  return { show, version: CURRENT_VERSION };
})();
