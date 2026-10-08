
    function renderLibraryTagCloud() {
      if (!els.libraryTagCloud) return;
      const allTags = getLibraryAllTags();
      const query = (els.tagFilterSearchInput?.value || '').trim().toLowerCase();
      const filtered = query
        ? allTags.filter(item => item.tag.toLowerCase().includes(query))
        : allTags;

      if (!filtered.length) {
        els.libraryTagCloud.innerHTML = allTags.length === 0
          ? '<div class="subtle-empty">No tags in library yet. Add tags or sample papers.</div>'
          : '<div class="subtle-empty">No matching tags found.</div>';
        return;
      }

      els.libraryTagCloud.innerHTML = filtered.slice(0, 48).map(item => {
        const isActive = state.filterTags.some(t => t.toLowerCase() === item.tag.toLowerCase());
        return `<button class="cloud-tag-chip${isActive ? ' is-active' : ''}" type="button" data-action="toggle-cloud-tag" data-tag="${escapeHtml(item.tag)}" title="Filter library by &quot;${escapeHtml(item.tag)}&quot;">
          ${escapeHtml(item.tag)} <span class="cloud-tag-count">${item.count}</span>
        </button>`;
      }).join('');

      els.libraryTagCloud.querySelectorAll('[data-action="toggle-cloud-tag"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          toggleFilterTag(btn.dataset.tag);
        });
      });
    }

    function toggleFilterTag(tag) {
      const cleaned = cleanField(tag);
      if (!cleaned) return;
      const idx = state.filterTags.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.filterTags.splice(idx, 1);
        showToast(`Removed tag filter: "${cleaned}"`);
      } else {
        state.filterTags.push(cleaned);
        showToast(`Filtering by tag: "${cleaned}"`);
      }
      renderTagFilterBar();
      render();
    }

    function addFilterTag(tag) {
      const cleaned = cleanField(tag);
      if (!cleaned) return;
      if (!state.filterTags.some(t => t.toLowerCase() === cleaned.toLowerCase())) {
        state.filterTags.push(cleaned);
        showToast(`Filtering by tag: "${cleaned}"`);
        renderTagFilterBar();
        render();
      }
    }

    function removeFilterTag(tag) {
      const cleaned = cleanField(tag);
      state.filterTags = state.filterTags.filter(t => t.toLowerCase() !== cleaned.toLowerCase());
      showToast(`Removed tag filter: "${cleaned}"`);
      renderTagFilterBar();
      render();
    }

    function clearFilterTags() {
      state.filterTags = [];
      if (els.tagFilterSearchInput) els.tagFilterSearchInput.value = '';
      showToast('Cleared all tag filters.');
      renderTagFilterBar();
      render();
    }

    function toggleRecommendationSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.recommendationSteerKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.recommendationSteerKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from recommendation steering.`);
      } else {
        state.recommendationSteerKeywords = dedupeList([cleaned, ...state.recommendationSteerKeywords]).slice(0, 12);
        state.recommendationSteerOpen = true;
        showToast(`Steering recommendations toward "${cleaned}".`);
      }
      renderDetails();
    }

    function toggleGraphSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.graphSteerKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.graphSteerKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from map focus.`);
      } else {
        state.graphSteerKeywords = dedupeList([cleaned, ...state.graphSteerKeywords]).slice(0, 12);
        showToast(`Refocusing map around "${cleaned}".`);
      }
      render();
    }

    function toggleExcludeSteer(term) {
      const cleaned = cleanField(term);
      if (!cleaned) return;
      const idx = state.recommendationExcludeKeywords.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if (idx >= 0) {
        state.recommendationExcludeKeywords.splice(idx, 1);
        showToast(`Removed "${cleaned}" from exclusions.`);
      } else {
        state.recommendationExcludeKeywords = dedupeList([cleaned, ...state.recommendationExcludeKeywords]).slice(0, 16);
        showToast(`Excluding recommendations with "${cleaned}".`);
      }
      renderDetails();
    }

    let currentTagActionTerm = '';

    function openTagActionMenu(term, anchorEl) {
      const cleaned = cleanField(term);
      if (!cleaned || !els.tagActionMenu || !anchorEl) return;
      currentTagActionTerm = cleaned;

      if (els.tagActionMenuTitle) els.tagActionMenuTitle.textContent = cleaned;

      const isFiltered = state.filterTags.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isSteered = state.recommendationSteerKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isGraphSteered = state.graphSteerKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());
      const isExcluded = state.recommendationExcludeKeywords.some(t => t.toLowerCase() === cleaned.toLowerCase());

      if (els.tagActionFilterLabel) {
        els.tagActionFilterLabel.textContent = isFiltered
          ? `Remove "${cleaned}" from library filter`
          : `Filter library by "${cleaned}"`;
      }
      if (els.tagActionSteerLabel) {
        els.tagActionSteerLabel.textContent = isSteered
          ? `Remove "${cleaned}" from recommendation steering`
          : `Steer recommendations toward "${cleaned}"`;
      }
      if (els.tagActionGraphLabel) {
        els.tagActionGraphLabel.textContent = isGraphSteered
          ? `Remove "${cleaned}" from map focus`
          : `Focus map graph around "${cleaned}"`;
      }
      if (els.tagActionExcludeLabel) {
        els.tagActionExcludeLabel.textContent = isExcluded
          ? `Remove "${cleaned}" from exclusions`
          : `Exclude recommendations with "${cleaned}"`;
      }

      const rect = anchorEl.getBoundingClientRect();
      const menuWidth = 260;
      const menuHeight = 220;
      let left = rect.left;
      let top = rect.bottom + 6;

      if (left + menuWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - menuWidth - 12);
      }
      if (top + menuHeight > window.innerHeight - 12) {
        top = Math.max(12, rect.top - menuHeight - 6);
      }

      els.tagActionMenu.style.left = `${Math.round(left)}px`;
      els.tagActionMenu.style.top = `${Math.round(top)}px`;
      els.tagActionMenu.hidden = false;
    }

    function closeTagActionMenu() {
      if (els.tagActionMenu) els.tagActionMenu.hidden = true;
      currentTagActionTerm = '';
    }

    function setPaperPanelHidden(hidden) {
      if (els.app) els.app.classList.toggle('panel-hidden', hidden);
      if (els.panelToggleButton) {
        els.panelToggleButton.textContent = hidden ? '>' : '<';
        els.panelToggleButton.title = hidden ? 'Show paper panel' : 'Hide paper panel';
        els.panelToggleButton.setAttribute('aria-label', hidden ? 'Show paper panel' : 'Hide paper panel');
        els.panelToggleButton.setAttribute('aria-expanded', String(!hidden));
      }
      if (els.showPanelButton) els.showPanelButton.setAttribute('aria-expanded', String(!hidden));
      window.requestAnimationFrame(() => render());
    }

    function backendUrl(path) {
      return `${apiBase}${path}`;
    }

    function backendNavigationUrl(path) {
      const url = new URL(backendUrl(path), window.location.href);
      if (apiToken) url.searchParams.set('token', apiToken);
      return url.toString();
    }

    function apiHeaders(extra = {}) {
      const headers = { ...extra };
      if (apiToken) {
        headers['X-Pulse-Token'] = apiToken;
        headers['X-Iratxe-Token'] = apiToken;
      }
      return headers;
    }

    function renderBackendStatus(settings, message) {
      const url = apiBase || window.location.origin;
      els.backendUrlInput.value = url;
      els.backendStatus.classList.remove('is-ready', 'is-error');
      if (!settings) {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = message || 'The app backend is offline. Reopen Pulse and try the connection check again.';
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = `${els.backendStatus.textContent}\nBackend URL: ${url}`;
        return;
      }

      const defaults = settings.defaults || {};
      els.aiProviderInput.value = settings.aiProvider || defaults.aiProvider || 'local';
      els.cloudProviderInput.value = settings.cloudProvider || defaults.cloudProvider || 'not-configured';
      els.ollamaChatEndpointInput.value = settings.ollamaChatEndpoint || defaults.ollamaChatEndpoint || 'http://127.0.0.1:11434/api/chat';
      els.gemmaModelInput.value = settings.gemmaModel || defaults.chatModel || 'gemma3:4b';
      els.embeddingModelInput.value = settings.embeddingModel || defaults.embeddingModel || 'nomic-embed-text';
      if (els.autoGemmaExtractionInput) els.autoGemmaExtractionInput.checked = settings.autoGemmaExtraction !== false;
      const isLocalProvider = els.aiProviderInput.value === 'local';
      const localCard = document.getElementById('localOllamaSettingsStep');
      const cloudCard = document.getElementById('cloudSettingsStep');
      const cloudGroup = document.getElementById('cloudProviderGroup');
      if (localCard) localCard.hidden = !isLocalProvider;
      if (cloudCard) cloudCard.hidden = isLocalProvider;
      if (cloudGroup) cloudGroup.hidden = isLocalProvider;
      els.cloudProviderInput.disabled = isLocalProvider;
      els.ollamaChatEndpointInput.disabled = !isLocalProvider;
      els.ollamaModelSelect.disabled = !isLocalProvider;
      els.embeddingModelInput.disabled = !isLocalProvider;
      els.testBackendButton.disabled = !isLocalProvider;
      const providers = settings.providers || {};
      const gemma = providers.gemma || {};
      const embeddings = providers.embeddings || {};
      const vectorDb = providers.vectorDb || {};
      const dimensions = providers.dimensions || {};
      const semanticScholar = providers.semanticScholar || {};
      const ollama = providers.ollama || {};
      const bundled = ollama.bundled || {};
      const bundledBoot = bundled.boot || {};
      populateOllamaModels(ollama.models || [], settings.gemmaModel || defaults.chatModel || 'gemma3:4b');
      const gemmaStatus = ollama.online
        ? (gemma.configured ? `Ready (${gemma.model || settings.gemmaModel})` : 'Model missing')
        : 'Ollama offline';
      const embeddingStatus = ollama.online
        ? (embeddings.available ? embeddings.active : 'Embedding missing')
        : 'Ollama offline';
      const vectorStatus = vectorDb.available ? vectorDb.active : 'sklearn cosine fallback';
      const dimensionsStatus = dimensions.configured ? `Configured (${dimensions.preview})` : 'Optional';
      const s2Status = semanticScholar.configured ? `Configured (${semanticScholar.preview})` : 'Active (Free S2AG public graph)';
      if (els.gemmaStatus) els.gemmaStatus.textContent = gemmaStatus;
      if (els.embeddingStatus) els.embeddingStatus.textContent = embeddingStatus;
      if (els.vectorStatus) els.vectorStatus.textContent = vectorStatus;
      if (els.dimensionsStatus) els.dimensionsStatus.textContent = dimensionsStatus;
      const runtimeWarning = settings.runtimeWarning || (!settings.localInferenceEnabled ? 'Local AI runtime not detected. Start Ollama or choose a cloud provider.' : '');
      const warnings = [...new Set([runtimeWarning, ollama.error, gemma.warning, embeddings.warning].filter(Boolean))];
      const localDisabled = (settings.aiProvider || 'local') === 'local' && !settings.localInferenceEnabled;
      state.localInferenceEnabled = !localDisabled;
      // The paper-summary agent independently discovers installed local Ollama models.
      if (ollama.online && gemma.configured) {
        els.backendStatus.classList.add('is-ready');
        els.backendStatus.textContent = `Local AI is ready. Imported PDFs will be scanned with ${gemma.model || settings.gemmaModel}.`;
      } else if (ollama.online) {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = gemma.warning || `The selected chat model is not installed. Run: ollama pull ${settings.gemmaModel || 'gemma3:4b'}`;
      } else {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = runtimeWarning || 'Local AI runtime not detected. Start Ollama or choose a cloud provider.';
      }
      const diagnostics = [
        `Backend: online`,
        `AI provider: ${(settings.aiProvider || 'local') === 'cloud' ? 'Cloud provider' : 'Local (Ollama)'}`,
        `Ollama chat endpoint: ${settings.ollamaChatEndpoint || 'http://127.0.0.1:11434/api/chat'}`,
        `Ollama tags endpoint: ${settings.ollamaTagsEndpoint || 'http://127.0.0.1:11434/api/tags'}`,
        `Ollama embeddings endpoint: ${settings.ollamaEmbeddingsEndpoint || 'http://127.0.0.1:11434/api/embeddings'}`,
        `Bundled Ollama: ${bundled.available ? (bundled.processRunning ? 'running from app bundle' : 'available') : 'not bundled'}`,
        `Bundled runtime status: ${bundledBoot.reason || 'unknown'}`,
        `Ollama model storage: ${bundled.modelsDir || '~/Library/Application Support/pulse/models'}`,
        `PDF extraction: ${settings.workflow?.pdfExtraction || 'byte scan fallback'}`,
        `Section detection: ${settings.workflow?.sectionDetection || 'heading heuristics'}`,
        `Metadata extraction: local parser + local chat model`,
        `Chunking: paragraphs`,
        `Embedding model: ${embeddingStatus}`,
        `Vector database: ${vectorStatus}`,
        `Chat model: ${gemmaStatus}`,
        `Fallback embeddings: ${embeddings.fallback || 'hashed-local-fallback'} only if Ollama embeddings fail`,
        `Semantic Scholar (S2AG): ${s2Status}`,
        `Dimensions recommender: ${dimensionsStatus}`,
        `Literature Discovery: S2AG (SPECTER2) + OpenAlex + Crossref${dimensions.configured ? ' + Dimensions' : ''}`,
        warnings.length ? `Warnings:\n${warnings.map(item => `- ${item}`).join('\n')}` : '',
        `Config: ${settings.configPath || 'local backend'}`
      ].filter(Boolean).join('\n');
      if (els.backendDiagnostics) els.backendDiagnostics.textContent = diagnostics;
    }

    function populateOllamaModels(models, selectedModel) {
      const uniqueModels = [...new Set((models || []).filter(Boolean))];
      els.ollamaModelSelect.innerHTML = uniqueModels.length
        ? uniqueModels.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')
        : '<option value="">Test Connection to load installed models</option>';
      if (uniqueModels.includes(selectedModel)) {
        els.ollamaModelSelect.value = selectedModel;
      } else if (uniqueModels.length) {
        els.ollamaModelSelect.insertAdjacentHTML('afterbegin', `<option value="${escapeHtml(selectedModel)}">Selected: ${escapeHtml(selectedModel)} (not installed)</option>`);
        els.ollamaModelSelect.value = selectedModel;
      }
    }


    function initFrankTheme() {
      const saved = localStorage.getItem('pulse-theme') || localStorage.getItem('iratxe-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyFrankTheme(saved);
      els.themeLight?.addEventListener('click', () => applyFrankTheme('light'));
      els.themeDark?.addEventListener('click', () => applyFrankTheme('dark'));
    }

    function applyFrankTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('pulse-theme', theme);
      els.themeLight?.classList.toggle('active', theme === 'light');
      els.themeDark?.classList.toggle('active', theme === 'dark');
    }

    function updateSaveStatePill(status) {
      if (!els.saveStatePill) return;
      els.saveStatePill.textContent = status;
      els.saveStatePill.className = 'save-state-pill ' + status.toLowerCase().replace(/[^a-z]/g, '');
    }

    async function loadBackendSettings() {
      try {
        await backendReady;
        const response = await fetch(backendUrl('/api/settings'), { headers: apiHeaders() });
        const settings = await response.json();
        if (!response.ok) throw new Error(settings.error || 'Could not read backend settings.');
        if (settings.hasApiKey && els.geminiKeyInput) {
          els.geminiKeyInput.placeholder = settings.apiKeyPreview ? ('Configured (' + settings.apiKeyPreview + ')') : 'Configured';
        }
        if (settings.cloudModel && els.cloudModelInput) {
          els.cloudModelInput.value = settings.cloudModel;
        }
        if (settings.aiProvider && els.aiProviderInput) {
          els.aiProviderInput.value = settings.aiProvider;
        }
        if (settings.cloudProvider && els.cloudProviderInput) {
          els.cloudProviderInput.value = settings.cloudProvider;
        }
        renderBackendStatus(settings);
      } catch (error) {
        renderBackendStatus(null, `${error.message}\n\nBackend URL: ${apiBase || window.location.origin}`);
      }
    }
