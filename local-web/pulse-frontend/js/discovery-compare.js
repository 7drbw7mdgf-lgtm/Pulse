/* Compare selected discovered papers in an evidence table. */
    let _lastComparedMatrix = null;
    let _lastComparedPapers = [];
    async function openDiscoveryCompareDialog(papers) {
      const dialog = document.getElementById('discoveryCompareDialog');
      if (!dialog) return;
      _lastComparedPapers = (papers || []).slice(0, 15);
      const closeBtn = document.getElementById('discoveryCompareCloseBtn');
      if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = '1';
        closeBtn.addEventListener('click', () => dialog.close());
      }
      const exportCsvBtn = document.getElementById('compareExportCsvBtn');
      if (exportCsvBtn && !exportCsvBtn.dataset.bound) {
        exportCsvBtn.dataset.bound = '1';
        exportCsvBtn.addEventListener('click', async () => {
          if (!_lastComparedMatrix) return;
          try {
            const res = await fetch(backendUrl('/api/discovery/compare'), {
              method: 'POST',
              headers: apiHeaders({'Content-Type': 'application/json'}),
              body: JSON.stringify({ papers: _lastComparedPapers.map(typeof comparisonPaperPayload==='function'?comparisonPaperPayload:citationPaperPayload), format: 'csv', useOpenAccess:false })
            });
            const data = await res.json();
            if (data.csv && typeof downloadRecordFile === 'function') {
              downloadRecordFile('pulse-evidence-matrix.csv', data.csv, 'text/csv');
              showToast('Exported evidence matrix CSV.');
            }
          } catch (err) { showToast(err.message); }
        });
      }
      const exportMdBtn = document.getElementById('compareExportMdBtn');
      if (exportMdBtn && !exportMdBtn.dataset.bound) {
        exportMdBtn.dataset.bound = '1';
        exportMdBtn.addEventListener('click', async () => {
          if (!_lastComparedMatrix) return;
          try {
            const res = await fetch(backendUrl('/api/discovery/compare'), {
              method: 'POST',
              headers: apiHeaders({'Content-Type': 'application/json'}),
              body: JSON.stringify({ papers: _lastComparedPapers.map(typeof comparisonPaperPayload==='function'?comparisonPaperPayload:citationPaperPayload), format: 'markdown', useOpenAccess:false })
            });
            const data = await res.json();
            if (data.markdown && typeof downloadRecordFile === 'function') {
              downloadRecordFile('pulse-evidence-matrix.md', data.markdown, 'text/markdown');
              showToast('Exported evidence matrix Markdown.');
            }
          } catch (err) { showToast(err.message); }
        });
      }
      const rerunBtn = document.getElementById('compareRerunBtn');
      if (rerunBtn && !rerunBtn.dataset.bound) {
        rerunBtn.dataset.bound = '1';
        rerunBtn.addEventListener('click', () => openDiscoveryCompareDialog(_lastComparedPapers));
      }
      dialog.showModal();
      const status = document.getElementById('compareStatus');
      const thead = document.getElementById('compareTableHead');
      const tbody = document.getElementById('compareTableBody');
      if (status) status.textContent = `Comparing ${_lastComparedPapers.length} papers…`;
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="padding:24px;text-align:center;color:var(--muted)">Extracting grounded claims and verbatim supporting quotations…</td></tr>';
      try {
        const res = await fetch(backendUrl('/api/discovery/compare'), {
          method: 'POST',
          headers: apiHeaders({'Content-Type': 'application/json'}),
          body: JSON.stringify({ papers: _lastComparedPapers.map(typeof comparisonPaperPayload==='function'?comparisonPaperPayload:citationPaperPayload), useOpenAccess:document.getElementById('compareUseOpenAccess')?.checked!==false })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Comparison failed.');
        _lastComparedMatrix = data;
        renderCompareTable(data);
      } catch (err) {
        if (status) status.textContent = `Error: ${err.message}`;
      }
    }

    function renderCompareTable(matrix) {
      if(typeof PulseEvidence!=='undefined')PulseEvidence.accept(matrix);
      const status = document.getElementById('compareStatus');
      const thead = document.getElementById('compareTableHead');
      const tbody = document.getElementById('compareTableBody');
      if (status) status.textContent = `Compared ${(matrix.rows || []).length} papers · ${matrix.provider || 'Automatic sentence extraction (no AI)'} · each cell is copied from the paper; check it against its quote`;
      const columns = matrix.columns || [];
      if (thead) {
        thead.innerHTML = `<tr>
          <th>Paper</th>
          ${columns.map(c => `<th>${escapeHtml(c.name || c.id)}</th>`).join('')}
        </tr>`;
      }
      // Render Consensus & Contradiction banner if detected across targets
      let consensusEl = document.getElementById('compareConsensusBanner');
      if (!consensusEl && thead) {
        consensusEl = document.createElement('div');
        consensusEl.id = 'compareConsensusBanner';
        consensusEl.className = 'compare-consensus-banner';
        document.querySelector('.compare-table-container')?.before(consensusEl);
      }
      if (consensusEl) {
        const con = matrix.consensus;
        if (con && (con.concordant?.length || con.conflicting?.length)) {
          consensusEl.hidden = false;
          consensusEl.style.cssText = 'margin:10px 0; padding:10px 14px; background:var(--surface-2); border-radius:8px; border:1px solid var(--line); font-size:12px;';
          consensusEl.innerHTML = `
            <div style="font-weight:700; margin-bottom:6px; color:var(--ink);">Target Findings Synthesis:</div>
            <div style="display:flex; flex-direction:column; gap:4px;">
              ${(con.concordant || []).map(item => `
                <div style="color:#16a34a; display:flex; align-items:center; gap:6px;">
                  <span style="font-weight:600; padding:1px 6px; background:rgba(22,163,74,0.12); border-radius:4px;">✓ Concordant</span>
                  <span>${escapeHtml(item.summary)}</span>
                </div>
              `).join('')}
              ${(con.conflicting || []).map(item => `
                <div style="color:#dc2626; display:flex; align-items:center; gap:6px;">
                  <span style="font-weight:600; padding:1px 6px; background:rgba(220,38,38,0.12); border-radius:4px;">⚡ Conflicting</span>
                  <span>${escapeHtml(item.summary)}</span>
                </div>
              `).join('')}
            </div>
          `;
        } else {
          consensusEl.hidden = true;
          consensusEl.innerHTML = '';
        }
      }
      if (tbody) {
        tbody.innerHTML = (matrix.rows || []).map((r,rowIndex) => {
          const cells = columns.map(c => {
            const cell = (r.cells || {})[c.id || c.name] || {};
            const val = escapeHtml(cell.value || 'Not stated');
            const quote = cell.quote ? escapeHtml(cell.quote) : '';
            const isNotStated = !cell.grounded || /^not stated/i.test(cell.value || '');
            return `<td class="${isNotStated ? 'is-not-stated' : 'is-extracted'}" title="${quote ? `Extracted from: “${quote}”` : ''}">
              <div class="compare-cell-val">${val}</div>
              ${quote ? `<small class="compare-cell-quote">“${quote}”</small><button class="mac-btn evidence-source" data-evidence-cell="${rowIndex}" data-evidence-column="${escapeHtml(c.id||c.name)}">View source${cell.provenance?.page?' · p. '+escapeHtml(cell.provenance.page):''}</button>` : ''}
            </td>`;
          }).join('');
          return `<tr>
            <td class="compare-paper-cell">
              <strong>${escapeHtml(cleanDiscoveryTitle(r.title))}</strong>
              <small>${escapeHtml(r.meta || '')}</small>
              <small>${escapeHtml(r.source||r.sourceType||'')}${r.warning?' · '+escapeHtml(r.warning):''}</small>
            </td>
            ${cells}
          </tr>`;
        }).join('');
      }
    }
