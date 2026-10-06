      document.querySelectorAll('[data-method]').forEach(button => {
        const active = Boolean(state.discoveryBranches[branches[button.dataset.method]]);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      document.querySelectorAll('[data-depth]').forEach(button => {
        const active = button.dataset.depth === state.explorationDepth;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      if (els.graphLegend) {
        els.graphLegend.innerHTML = state.clusters.map((cluster, index) => {
          const paper = state.papers.find(item => item.id === cluster[0]);
          const label = mergedKeywords(paper || {}).slice(0, 1)[0] || `Cluster ${index + 1}`;
          return `<div class="legend-row"><span class="legend-dot" style="background:${palette[index % palette.length]}"></span><span class="legend-label">${escapeHtml(label)} (${cluster.length})</span></div>`;
        }).join('');
      }
      if (els.railRecentList) {
        els.railRecentList.innerHTML = state.papers.slice(-4).reverse().map(paper => `<button type="button" class="recent-session-item" data-session-query="${escapeHtml(paper.doi || paper.pmid || paper.title)}"><span class="session-dot"></span><span class="session-info"><strong class="session-name">${escapeHtml(compactTitle(paper.title))}</strong><small class="session-time">${escapeHtml(paper.year || 'In library')}</small></span></button>`).join('') || '<p class="rail-empty">Recent papers will appear here.</p>';
      }
      if(state.workspaceView==='discover')renderDiscoveryWorkspace();
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
      els.cloudProviderInput.value = 'gemini';
      els.ollamaChatEndpointInput.value = settings.ollamaChatEndpoint || defaults.ollamaChatEndpoint || 'http://127.0.0.1:11434/api/chat';
      els.gemmaModelInput.value = settings.gemmaModel || defaults.chatModel || 'gemma3:4b';
      els.embeddingModelInput.value = settings.embeddingModel || defaults.embeddingModel || 'nomic-embed-text';
      if (els.autoGemmaExtractionInput) els.autoGemmaExtractionInput.checked = settings.autoGemmaExtraction !== false;
      const isLocalProvider = els.aiProviderInput.value === 'local';
      els.cloudProviderInput.disabled = isLocalProvider;
      els.ollamaChatEndpointInput.disabled = !isLocalProvider;
      els.ollamaModelSelect.disabled = !isLocalProvider;
      els.embeddingModelInput.disabled = !isLocalProvider;
      els.testBackendButton.disabled = false;
      syncProviderControls();
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
      els.aiAnalyzeButton.disabled = localDisabled;
      els.aiAnalyzeButton.dataset.localInferenceEnabled = String(!localDisabled);
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

    async function saveBackendSettings(options = {}) {
      const clearDimensionsApiKey = Boolean(options.clearDimensionsApiKey);
      const clearSemanticScholarApiKey = Boolean(options.clearSemanticScholarApiKey);
      els.saveSettingsButton.disabled = true;
      if (els.clearDimensionsKeyButton) els.clearDimensionsKeyButton.disabled = true;
      if (els.clearSemanticScholarKeyButton) els.clearSemanticScholarKeyButton.disabled = true;
      try {
        const response = await fetch(backendUrl('/api/settings'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            aiProvider: els.aiProviderInput.value,
            cloudProvider: els.cloudProviderInput.value,
            cloudModel: els.cloudModelInput ? els.cloudModelInput.value.trim() : 'gemini-2.5-flash',
            apiKey: els.geminiKeyInput ? els.geminiKeyInput.value.trim() : undefined,
            ollamaChatEndpoint: els.ollamaChatEndpointInput.value.trim() || 'http://127.0.0.1:11434/api/chat',
            dimensionsApiKey: clearDimensionsApiKey ? '' : (els.dimensionsKeyInput ? els.dimensionsKeyInput.value.trim() : ''),
            clearDimensionsApiKey,
            semanticScholarApiKey: clearSemanticScholarApiKey ? '' : (els.semanticScholarKeyInput ? els.semanticScholarKeyInput.value.trim() : ''),
            clearSemanticScholarApiKey,
            gemmaModel: els.gemmaModelInput.value.trim() || 'gemma3:4b',
            embeddingModel: els.embeddingModelInput.value.trim() || 'nomic-embed-text',
            autoGemmaExtraction: els.autoGemmaExtractionInput?.checked !== false
          })
        });
        const settings = await response.json();
        if (!response.ok) throw new Error(settings.error || 'Could not save backend settings.');
        if (els.dimensionsKeyInput) els.dimensionsKeyInput.value = '';
        if (els.semanticScholarKeyInput) els.semanticScholarKeyInput.value = '';
        renderBackendStatus(settings, 'Settings saved.');
        if (clearSemanticScholarApiKey) showToast('Semantic Scholar key cleared.');
        else if (clearDimensionsApiKey) showToast('Dimensions key cleared.');
        else showToast('Backend settings saved.');
      } catch (error) {
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = error.message;
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = error.message;
      } finally {
        els.saveSettingsButton.disabled = false;
        if (els.clearDimensionsKeyButton) els.clearDimensionsKeyButton.disabled = false;
        if (els.clearSemanticScholarKeyButton) els.clearSemanticScholarKeyButton.disabled = false;
      }
    }

    async function testBackend() {
      els.testBackendButton.disabled = true;
      els.backendStatus.textContent = 'Testing Ollama chat and embeddings...';
      try {
        const response = await fetch(backendUrl('/api/test'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({})
        });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error(result.error || result.message || 'Connection test failed.');
        populateOllamaModels(result.models || [], result.model);
        await loadBackendSettings();
        showToast(result.message || 'Connection detected.');
      } catch (error) {
        const model = els.gemmaModelInput.value.trim() || 'gemma3:4b';
        const embedModel = els.embeddingModelInput.value.trim() || 'nomic-embed-text';
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = error.message;
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = `${error.message}\n\nIf Ollama is offline, run: ollama serve\nIf the chat model is missing, run: ollama pull ${model}\nIf the embedding model is missing, run: ollama pull ${embedModel}`;
      } finally {
        els.testBackendButton.disabled = false;
      }
    }

    function aiPayload() {
      return {
        prompt: els.aiPrompt.value.trim(),
        threshold: state.threshold,
        mode: state.mode,
        graphStyle: { ...state.graphStyle },
        areas: state.areas.map(area => ({ ...area })),
        papers: state.papers.map(paper => ({
          id: paper.id,
          title: paper.title,
          authors: paper.authors || [],
          date: paper.date || '',
          year: paper.year || '',
          journal: paper.journal || '',
          doi: paper.doi || '',
          openAlexId: paper.openAlexId || '',
          openAlexUrl: paper.openAlexUrl || '',
          referenceIds: paper.referenceIds || [],
          citedByIds: paper.citedByIds || [],
          citedByCount: paper.citedByCount || 0,
          influentialCitationCount: paper.influentialCitationCount,
          abstract: paper.abstract || '',
          text: paper.text.slice(0, 12000),
          keywords: mergedKeywords(paper),
        })),
        links: state.links.slice().sort((a,b)=>b.score-a.score).slice(0,2500).map(link => {
          const source = papersById.get(link.source);
          const target = papersById.get(link.target);
          return {
            source: source?.title || link.source,
            target: target?.title || link.target,
            score: Number(link.score.toFixed(4)),
            type: link.type || 'similarity',
            evidence: link.evidence || ''
          };
        })
      };
    }

    async function analyzeWithGemma() {
      if (!state.papers.length) {
        setAiPanelOpen(true);
        els.aiResult.classList.add('is-muted');
        els.aiResult.textContent = 'Load at least one paper before asking the local chat model to analyze the map.';
        return;
      }
      if (els.aiProviderInput?.value === 'local' && els.aiAnalyzeButton.dataset.localInferenceEnabled === 'false') {
        setAiPanelOpen(true);
        els.aiResult.classList.add('is-muted');
        els.aiResult.textContent = 'Local AI runtime not detected. Start Ollama or choose a cloud provider.';
        return;
      }

      setAiPanelOpen(true);
      els.aiAnalyzeButton.disabled = true;
      els.aiResult.classList.add('is-muted');
      els.aiResult.textContent = 'Running the local Ollama chat model over the nearest paper chunks...';

      try {
        const response = await fetch(backendUrl('/api/analyze'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(aiPayload())
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Local chat analysis failed.');
        }

        els.aiResult.classList.remove('is-muted');
        const parsed = parseChatControlResponse(data.analysis || '');
        const applied = applyChatActions(parsed.actions);
        els.aiResult.textContent = [
          parsed.analysis || 'The local chat model returned an empty response.',
          applied.length ? `\n\nApplied to graph:\n${applied.map(item => `- ${item}`).join('\n')}` : ''
        ].filter(Boolean).join('');
      } catch (error) {
        els.aiResult.classList.add('is-muted');
        const model = els.gemmaModelInput.value.trim() || 'gemma3:4b';
        const embedModel = els.embeddingModelInput.value.trim() || 'nomic-embed-text';
        els.aiResult.textContent = `${error.message}\n\nCheck Settings, then run: ollama serve\nIf needed: ollama pull ${model}\nFor embeddings: ollama pull ${embedModel}`;
      } finally {
        els.aiAnalyzeButton.disabled = false;
      }
    }

    function parseChatControlResponse(text) {
      const raw = String(text || '');
      const match = raw.match(/(?:PULSE_ACTIONS_START|IRATXE_ACTIONS_START)\s*([\s\S]*?)\s*(?:PULSE_ACTIONS_END|IRATXE_ACTIONS_END)/i);
      if (!match) return { analysis: raw.trim(), actions: [] };
      let actions = [];
      try {
        const parsed = JSON.parse(match[1].trim());
        actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      } catch {
        actions = [];
      }
      return {
        analysis: raw.replace(match[0], '').trim(),
        actions
      };
    }

    function setMapMode(mode) {
      if (!['network', 'clusters', 'radial', 'table', 'timeline'].includes(mode)) return false;
      state.workspaceView = mode === 'table' ? 'library' : mode === 'timeline' ? 'timeline' : 'network';
      state.mode = mode;
      state.centerId = null;
      document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('is-active', item.dataset.mode === mode));
      return true;
