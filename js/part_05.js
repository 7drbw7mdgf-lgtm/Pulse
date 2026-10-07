
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
        if (!response.ok) throw new Error(result.error || 'Ollama test failed.');
        populateOllamaModels(result.models || [], result.model);
        await loadBackendSettings();
        showToast('Ollama connection detected.');
      } catch (error) {
        const model = els.gemmaModelInput.value.trim() || 'gemma3:4b';
        const embedModel = els.embeddingModelInput.value.trim() || 'nomic-embed-text';
        els.backendStatus.classList.add('is-error');
        els.backendStatus.textContent = error.message;
        if (els.backendDiagnostics) els.backendDiagnostics.textContent = `${error.message}\n\nIf Ollama is offline, run: ollama serve\nIf the chat model is missing, run: ollama pull ${model}\nIf the embedding model is missing, run: ollama pull ${embedModel}`;
      } finally {
        els.testBackendButton.disabled = els.aiProviderInput.value !== 'local';
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
          abstract: paper.abstract || '',
          text: paper.text.slice(0, 12000),
          keywords: mergedKeywords(paper),
        })),
        links: state.links.map(link => {
          const source = state.papers.find(paper => paper.id === link.source);
          const target = state.papers.find(paper => paper.id === link.target);
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
      if (!['network', 'clusters', 'radial', 'table'].includes(mode)) return false;
      state.mode = mode;
      state.centerId = null;
      document.querySelectorAll('[data-mode]').forEach(item => item.classList.toggle('is-active', item.dataset.mode === mode));
      return true;
    }

    function hexColor(value, fallback = '#0d837b') {
      const text = String(value || '').trim();
      return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
    }

    function findAreaByName(name) {
      const key = String(name || '').trim().toLowerCase();
      return state.areas.find(area => area.name.toLowerCase() === key);
    }

    function createNamedArea(action = {}) {
      const index = state.areas.length;
      const area = {
        id: uid(),
        name: cleanField(action.name || `Area ${index + 1}`),
        color: hexColor(action.color, palette[index % palette.length]),
        x: Math.max(40, Math.min(1600, Number(action.x || state.view.x + 110 + index * 34))),
        y: Math.max(40, Math.min(1400, Number(action.y || state.view.y + 110 + index * 28))),
        width: Math.max(120, Math.min(520, Number(action.width || 260))),
        height: Math.max(90, Math.min(380, Number(action.height || 170)))
      };
      state.areas.push(area);
      state.selectedAreaId = area.id;
      return area;
    }

    function applyChatActions(actions = []) {
      const applied = [];
      const safeActions = Array.isArray(actions) ? actions.slice(0, 16) : [];
      for (const action of safeActions) {
        if (!action || typeof action !== 'object') continue;
        const type = String(action.type || '').trim();
        if (type === 'set_threshold') {
          const value = Math.max(0.01, Math.min(0.75, Number(action.value)));
          if (Number.isFinite(value)) {
            state.threshold = value;
            els.threshold.value = Math.round(value * 100);
            applied.push(`set threshold to ${Math.round(value * 100)}%`);
          }
        } else if (type === 'set_mode') {
          if (setMapMode(String(action.mode || ''))) applied.push(`switched to ${state.mode} mode`);
        } else if (type === 'set_graph_style') {
          const updates = {};
          if (Number.isFinite(Number(action.nodeSize))) updates.nodeSize = Math.max(14, Math.min(42, Number(action.nodeSize)));
          if (Number.isFinite(Number(action.edgeScale))) updates.edgeScale = Math.max(0.25, Math.min(1.8, Number(action.edgeScale)));
          if (Number.isFinite(Number(action.spacing))) updates.spacing = Math.max(0.7, Math.min(1.65, Number(action.spacing)));
          if (['short', 'full', 'keywords', 'none'].includes(action.labelMode)) updates.labelMode = action.labelMode;
          if (typeof action.showGrid === 'boolean') updates.showGrid = action.showGrid;
          if (typeof action.showAreas === 'boolean') updates.showAreas = action.showAreas;
          if (Object.keys(updates).length) {
            state.graphStyle = { ...state.graphStyle, ...updates };
            syncGraphControls();
            applied.push('updated graph style');
          }
        } else if (type === 'center_paper') {
          const paper = state.papers.find(item => item.id === action.paperId);
          if (paper) {
            state.centerId = paper.id;
            applied.push(`centered ${compactTitle(paper.title)}`);
          }
        } else if (type === 'color_paper') {
          const paper = state.papers.find(item => item.id === action.paperId);
          if (paper) {
            paper.color = hexColor(action.color, paper.color || '#0d837b');
            applied.push(`colored ${compactTitle(paper.title)}`);
          }
        } else if (type === 'create_area') {
          const area = createNamedArea(action);
          applied.push(`created area ${area.name}`);
        } else if (type === 'rename_area') {
          const area = findAreaByName(action.from);
          const nextName = cleanField(action.to || '');
          if (area && nextName) {
            area.name = nextName;
            applied.push(`renamed area to ${area.name}`);
          }
        } else if (type === 'assign_area') {
          const paper = state.papers.find(item => item.id === action.paperId);
          if (paper) {
            let area = findAreaByName(action.areaName);
            if (!area) area = createNamedArea({ name: action.areaName || 'Chat area', color: action.color });
            paper.areaId = area.id;
            if (action.color) paper.color = hexColor(action.color, paper.color || area.color);
            applied.push(`assigned ${compactTitle(paper.title)} to ${area.name}`);
          }
        } else if (type === 'open_panel') {
          const panel = String(action.panel || '');
          if (panel === 'graph') setGraphPanelOpen(true);
          if (panel === 'areas') setAreaPanelOpen(true);
          if (panel === 'links') setLinkagePanelOpen(true);
          if (panel === 'settings') setSettingsOpen(true);
          if (['graph', 'areas', 'links', 'settings'].includes(panel)) applied.push(`opened ${panel} panel`);
        }
      }
      if (applied.length) {
        render();
        scheduleAutosave();
        showToast(`Chat applied ${applied.length} graph change${applied.length === 1 ? '' : 's'}.`);
      }
      return applied;
    }

    function normalizeTitle(name, text) {
      const cleanName = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
      const titleLine = lines.find(line => line.length > 18 && line.length < 160 && !/[{}@]/.test(line));
      return titleLine || cleanName || 'Untitled paper';
    }

    function extractTitle(raw, cleanedText, fileName) {
      const title = fieldMatch(raw, ['title', 'TI', 'T1'], 1200)
        || fieldMatch(cleanedText, ['title'], 400);
      if (title) return cleanField(title).replace(/\.$/, '');
      return normalizeTitle(fileName, cleanedText);
    }

    function firstMatch(text, patterns) {
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return match[1].trim();
      }
      return '';
    }

    function cleanField(value) {
      return stripMarkup(value || '')
        .replace(/\r/g, '\n')
        .replace(/-\n(?=[a-z])/g, '')
        .replace(/\n(?=[a-z])/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[{["']+|[}\]"']+$/g, '')
        .trim();
    }

    function stripMarkup(value) {
      const text = String(value || '');
      const abstractMatch = text.match(/<jats:sec[^>]*>\s*<jats:title>\s*Abstract\s*<\/jats:title>([\s\S]*?)(?=<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*<\/jats:title>|<\/jats:sec>\s*$)/i);
      const scoped = abstractMatch ? abstractMatch[1] : text;
      const withoutKeyPoints = scoped.replace(/<jats:sec[^>]*>\s*<jats:title>\s*(?:Key points?|Keywords?)\s*<\/jats:title>[\s\S]*?<\/jats:sec>/gi, ' ');
      const textarea = document.createElement('textarea');
      textarea.innerHTML = withoutKeyPoints
        .replace(/<\/?(?:jats:)?title[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
      return textarea.value.replace(/\u00a0/g, ' ').replace(/\s+([,.;:])/g, '$1');
    }

    function splitKeywords(value) {
      return cleanField(value)
        .replace(/\bkeywords?\b\s*[:.\-]*/i, '')
        .split(/\s*(?:;|,|\||\n|•|·)\s*/)
        .map(item => item.trim())
        .filter(item => item.length > 1 && item.length < 80 && !/^(keywords?|index terms?)$/i.test(item))
        .slice(0, 24);
    }

    function cleanAuthorName(str) {
      if (!str) return '';
      let s = String(str)
        .replace(/\s*\([^)]*\)/g, '')
        .replace(/\s*\[[^\]]*\]/g, '')
        .trim();
      s = s.replace(/^[\s\d*†‡§#.,;:"'([\]{}<>/\\-]+/, '').trim();
      s = s.replace(/[\s*†‡§#,:;"'([\]{}<>/\\-]+$/, '').trim();
      if (/[a-zA-Z\u00C0-\u024F\u1E00-\u1EFF]{2,}\.$/.test(s)) {
        s = s.slice(0, -1).trim();
      }
      return s;
    }
