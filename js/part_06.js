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

    function extractLastName(raw) {
      const cleaned = cleanAuthorName(raw);
      if (!cleaned) return '';
      if (cleaned.includes(',')) {
        const beforeComma = cleanAuthorName(cleaned.split(',')[0]);
        if (beforeComma && !/^(?:dr|prof|mr|ms|mrs)\.?$/i.test(beforeComma)) {
          return beforeComma;
        }
      }
      const tokens = cleaned.split(/\s+/).filter(Boolean);
      if (!tokens.length) return '';
      const len = tokens.length;
      if (len >= 3 && /^(?:van\s+der|von\s+der)$/i.test(tokens[len - 3] + ' ' + tokens[len - 2])) {
        return cleanAuthorName(tokens.slice(len - 3).join(' '));
      }
      if (len >= 2 && /^(?:van|von|de|del|da|der|ten|di|le|la|du)$/i.test(tokens[len - 2])) {
        return cleanAuthorName(tokens.slice(len - 2).join(' '));
      }
      return cleanAuthorName(tokens[len - 1].replace(/[0-9*†‡§#]+/g, ''));
    }

    function paperAuthors(paper) {
      if (!paper) return [];
      let list = [];
      if (Array.isArray(paper.authors) && paper.authors.length > 0) {
        list = paper.authors;
      } else if (typeof paper.author === 'string' && paper.author.trim()) {
        list = splitAuthors(paper.author);
      } else if (Array.isArray(paper.author) && paper.author.length > 0) {
        list = paper.author;
      } else if (typeof paper.authors === 'string' && paper.authors.trim()) {
        list = splitAuthors(paper.authors);
      }
      const seen = new Set();
      const cleaned = [];
      for (const item of list) {
        const c = cleanAuthorName(item);
        if (c.length > 1 && c.length < 120 && !/^(?:authors?|editors?|by|unknown|none)$/i.test(c)) {
          const key = c.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            cleaned.push(c);
          }
        }
      }
      return cleaned;
    }

    function splitAuthors(value) {
      const text = cleanField(value)
        .replace(/\b(?:edited|published|reviewed|translated)\s+by\s*[:.\-]?\s*/gi, '')
        .trim();
      if (!text) return [];

      let rawList = [];
      if (/[;\n|]/.test(text)) {
        rawList = text.split(/\s*(?:;|\n|\|)\s*/);
      } else if (/\s+\band\b\s+/i.test(text)) {
        const withSemi = text.replace(/\s+\band\b\s+/gi, '; ');
        rawList = withSemi.split(/\s*(?:;|,)\s*/);
      } else if (text.includes(',')) {
        const parts = text.split(/\s*,\s*/);
        if (parts.length === 2 && !/\s+/.test(parts[0]) && /^[A-Z\u00C0-\u024F\u1E00-\u1EFF]/.test(parts[0])) {
          rawList = [text];
        } else {
          rawList = parts;
        }
      } else {
        rawList = [text];
      }

      return rawList
        .map(cleanAuthorName)
        .filter(author => author.length > 1 && author.length < 120 && !/^(?:authors?|editors?|by)$/i.test(author))
        .slice(0, 24);
    }

    function fieldMatch(raw, labels, limit = 1600) {
      const labelGroup = labels.join('|');
      return firstMatch(raw, [
        new RegExp(`\\b(?:${labelGroup})\\s*=\\s*[{"]([\\s\\S]{1,${limit}}?)[}"],?\\s*(?:\\n\\s*\\w+\\s*=|$)`, 'i'),
        new RegExp(`^\\s*(?:${labelGroup})\\s*-\\s*([\\s\\S]{1,${limit}}?)(?=\\n\\s*(?:[A-Z][A-Z0-9]\\s*-|ER\\s*-)|$)`, 'im'),
        new RegExp(`\\b(?:${labelGroup})\\b\\s*[:.\\-]\\s*([^\\n]{1,${Math.min(limit, 900)}})`, 'i')
      ]);
    }

    function looksLikePersonName(token) {
      const cleaned = cleanAuthorName(token);
      if (!cleaned || cleaned.length < 2 || cleaned.length > 60) return false;
      if (/[:/=?#@$%&]/.test(cleaned)) return false;
      const words = cleaned.split(/\s+/);
      if (words.length > 4) return false;
      const nonNames = /\b(?:factors|role|sensing|adapting|competing|mechanisms|analysis|journal|review|study|effect|evidence|university|department|faculty|hospital|institute|school|laboratory|press|springer|elsevier|wiley|nature|frontiers|plos)\b/i;
      if (nonNames.test(cleaned)) return false;
      return words.every(w => /^[A-Z\u00C0-\u024F\u1E00-\u1EFF]/.test(w) || /^(?:van|von|de|del|da|der|ten|di|le|la|du)$/i.test(w));
    }

    function extractAuthors(raw, cleanedText) {
      const authorField = fieldMatch(raw, ['author', 'authors', 'AU', 'A1', 'FAU', 'creator', 'creators', 'byline'], 2400)
        || fieldMatch(cleanedText, ['author', 'authors', 'byline'], 900);
      if (authorField) return splitAuthors(authorField);

      const lines = cleanedText.split(/\n+/).map(line => cleanField(line)).filter(Boolean);
      const titleIndex = lines.findIndex(line => line.length > 18 && line.length < 180);
      const windowStart = Math.max(0, titleIndex + 1);
      const candidates = lines.slice(windowStart, windowStart + 6);

      let bestCandidate = null;
      let bestScore = 0;
      for (const line of candidates) {
        if (!/(?:,| and |;|&)/i.test(line) || line.length > 280) continue;
        if (/^(?:edited by|published by|reviewed by|translated by|abstract|keywords?|introduction|faculty|department)\b/i.test(line)) continue;
        const parts = line.replace(/\s+\band\b\s+/gi, ', ').split(/\s*,\s*/).map(cleanAuthorName).filter(Boolean);
        if (parts.length < 2) continue;
        const validNames = parts.filter(looksLikePersonName).length;
        const ratio = validNames / parts.length;
        if (ratio >= 0.7 && validNames > bestScore) {
          bestScore = validNames;
          bestCandidate = line;
        }
      }
      return bestCandidate ? splitAuthors(bestCandidate) : [];
    }

    function extractDate(raw, cleanedText) {
      const dateField = fieldMatch(raw, ['date', 'year', 'PY', 'Y1', 'DA', 'publication date', 'published', 'issued'], 300)
        || fieldMatch(cleanedText, ['date', 'year', 'publication date', 'published'], 300);
      const source = dateField || raw;
      const iso = source.match(/\b(19|20)\d{2}[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
      if (iso) return iso[0].replace(/\//g, '-');
      const monthDate = source.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+(19|20)\d{2}\b/i);
      if (monthDate) return cleanField(monthDate[0]);
      const year = source.match(/\b(19|20)\d{2}\b/);
      return year ? year[0] : '';
    }

    function extractJournal(raw, cleanedText) {
      const journal = fieldMatch(raw, ['journal', 'journaltitle', 'booktitle', 'JF', 'JO', 'T2', 'source', 'publication', 'container-title'], 900)
        || fieldMatch(cleanedText, ['journal', 'source', 'publication', 'published in'], 500);
      return cleanField(journal).replace(/\.$/, '');
    }

    function extractDoi(raw, cleanedText) {
      const doiField = fieldMatch(raw, ['doi', 'DO'], 400);
      const source = doiField || raw || cleanedText;
      return findBestDoi(source);
    }

    // DOI parsing mirrors pulse_backend.py (prepare_doi_text / doi_matches).
    // No regex lookbehind: older macOS WebKit cannot parse it.
    const DOI_PREFIX = '10\\.\\d{4,9}(?:\\.\\d+)*';
    const DOI_CHARS = '[-._;()/:A-Za-z0-9<>+]';
    const DOI_NEW_ITEM_GUARD = '(?![Dd][Oo][Ii]\\b|[Hh][Tt][Tt][Pp][Ss]?:|[Ww][Ww][Ww]\\.|\\S*?10\\.\\d{4,9}/)';
    const DOI_NON_PAPER_PREFIXES = ['10.13039/'];
    const DOI_GLUED_TAIL = /([0-9a-z)])(?:Received|Accepted|Published|Available|Copyright|Citation|Cite|Keywords|Abstract|Downloaded|Supplementary|Correspondence|Article|ORCID|PMID|PMCID|ISSN|Email|E-mail|https?:|www\.)[\s\S]*$/;
    const DOI_URL_SUFFIX = /(?:\/(?:full|abstract|pdf|epdf|pdfdirect|fulltext|summary|references|meta|html)|\.(?:full|abstract|supplementary)(?:\.pdf(?:\+html)?|\.html)?|\.pdf)+$/i;
    const DOI_MARKER = /(?:\bdoi\b|doi\.org\/|prism:doi|dc:identifier|identifier)[\s:=>"'(/]*(?:(?:abs|full|pdf|epdf|pdfdirect)\/)?$/i;
    const DOI_REFERENCES = /\n[ \t]*(?:\d+\.?[ \t]*)?(?:References(?: and Notes)?|REFERENCES|Bibliography|BIBLIOGRAPHY|Literature Cited|LITERATURE CITED|Works Cited|Reference List)[ \t:]*\n/g;

    function prepareDoiText(value) {
      let text = String(value || '')
        .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, '-')
        .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
        .replace(/\uff0f/g, '/')
        .replace(/\\\//g, '/');
      if (text.includes('&')) {
        text = text
          .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
          .replace(/&#x2f;|&#47;/gi, '/').replace(/&amp;/gi, '&');
      }
      text = text.replace(/(^|\s)([^\s%]*%(?:2F|3C|3E|28|29|3A|3B)\S*)/gi, (all, lead, token) => {
        try { return lead + decodeURIComponent(token); } catch { return lead + token.replace(/%2F/gi, '/'); }
      });
      // Letter-spaced extraction ("1 0 . 1 0 3 8 / n a t u r e") from tracked fonts.
      text = text.replace(/(^|\s)((?:\S{1,2} ){5,}\S{1,2})(?=\s|$)/g, (all, lead, run) => {
        const joined = run.replace(/ /g, '');
        return lead + (/10\.\d{4}/.test(joined) ? joined : run);
      });
      return text.replace(new RegExp(`(${DOI_PREFIX})[ \\t]*/[ \\t]*`, 'g'), '$1/');
