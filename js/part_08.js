      const buffer = await file.arrayBuffer();
      const scanned = await scanFileMetadata(file, buffer);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      const browserTextIsUnsafe = isPdfOrBinary(file, text);
      const backendText = scanned?.text && !looksBinary(scanned.text) ? scanned.text : '';
      const safeRaw = backendText || (browserTextIsUnsafe ? '' : text);
      const usableText = backendText ? extractCitationText(backendText) : (browserTextIsUnsafe ? '' : extractCitationText(text));
      const abstract = usableText ? extractAbstract(safeRaw, usableText) : '';
      const paperKeywords = usableText ? extractPaperKeywords(safeRaw, usableText) : [];
      const metadata = usableText ? extractMetadata(safeRaw, usableText) : { authors: [], date: '', year: '', journal: '', doi: '' };
      const foundDoi = controlFindDoi(text, usableText, buffer);
      const doiCandidates = uniqueDoiCandidates([
        scanned?.doi,
        metadata.doi,
        foundDoi,
        ...(scanned?.candidates || [])
      ]);
      if (scanned?.doi) metadata.doi = scanned.doi;
      else if (foundDoi) metadata.doi = foundDoi;
      const paper = {
        id: uid(),
        name: file.name,
        title: usableText ? extractTitle(safeRaw, usableText, file.name) : normalizeTitle(file.name, ''),
        abstract,
        paperKeywords,
        ...metadata,
        text: usableText.slice(0, 120000),
        size: file.size,
        x: 0,
        y: 0
      };
      if (scanned?.metadata && Object.keys(scanned.metadata).length) {
        mergeDoiMetadata(paper, scanned.metadata);
        paper.metadataSource = `${scanned.source || 'DOI'} via Python scan`;
      }
      const backendHandledGemma = Object.prototype.hasOwnProperty.call(scanned || {}, 'gemmaProcessed');
      const gemmaResult = backendHandledGemma
        ? (scanned.gemma || null)
        : await extractWithGemmaLayer(paper, { usableText, doiCandidates });
      const gemmaCandidates = uniqueDoiCandidates([gemmaResult?.doi, ...(gemmaResult?.candidates || [])]);
      await fillMetadataFromDoiLoop(paper, doiCandidates);
      await fillMetadataFromDoiLoop(paper, gemmaCandidates);
      if (!metadataLooksFilled(paper) && scanned?.error) {
        paper.metadataNote = `Python DOI scan unavailable: ${scanned.error}`;
      } else if (backendText) {
        paper.metadataNote = `Text extracted locally with ${scanned.extractionSource || 'the backend workflow'}; local chat terms feed discovery.`;
      } else if (browserTextIsUnsafe) {
        paper.metadataNote = 'PDF text looked binary and no local PDF extractor was available. Add PyMuPDF or pdfplumber for full-text extraction.';
      }
      return paper;
    }

    async function readImportFile(file) {
      const lowerName = (file.name || '').toLowerCase();
      if (lowerName.endsWith('.pdf')) return [await readFile(file)];
      const text = await file.text();
      if (lowerName.endsWith('.json')) {
        const imported = parsePulseJson(text);
        if (imported) return imported;
      }
      if (lowerName.endsWith('.xml') || /<\?xml|<xml|<record[\s>]|<records[\s>]/i.test(text.slice(0, 2000))) {
        const papers = parseEndnoteXml(text, file.name);
        if (papers.length) return papers;
      }
      if (lowerName.endsWith('.bib') || /@\w+\s*{/.test(text)) {
        const papers = parseBibtexRecords(text, file.name);
        if (papers.length) return papers;
      }
      if (lowerName.endsWith('.ris') || lowerName.endsWith('.enw') || /^\s*TY\s*-/im.test(text)) {
        const papers = parseRisRecords(text, file.name);
        if (papers.length) return papers;
      }
      if (lowerName.endsWith('.csv')) {
        const papers = parseCsvRecords(text, file.name);
        if (papers.length) return papers;
      }
      return [await readFile(file)];
    }

    function parsePulseJson(text) {
      try {
        const data = JSON.parse(text);
        const papers = Array.isArray(data.papers) ? data.papers : (Array.isArray(data) ? data : []);
        if (!papers.length) return null;
        state.pendingImportLinks = [...(state.pendingImportLinks || []), ...(data.explicitLinks || data.links || [])];
        if (typeof data.threshold === 'number') {
          state.threshold = Math.min(0.75, Math.max(0.01, data.threshold));
          els.threshold.value = Math.round(state.threshold * 100);
        }
        if (data.view && typeof data.view.x === 'number' && typeof data.view.y === 'number') {
          state.view.x = data.view.x;
          state.view.y = data.view.y;
        }
        if (Array.isArray(data.areas)) {
          state.areas = data.areas.map((area, index) => ({
            id: area.id || uid(),
            name: cleanField(area.name || `Area ${index + 1}`),
            color: area.color || palette[index % palette.length],
            x: Number(area.x || 80 + index * 28),
            y: Number(area.y || 80 + index * 22),
            width: Number(area.width || 260),
            height: Number(area.height || 170)
          }));
        }
        return papers.map(paper => normalizeImportedPaper({
          ...paper,
          paperKeywords: paper.paperKeywords || paper.keywords || [],
          text: paper.text || paper.fullText || paper.abstract || ''
        }, 'Imported JSON map'));
      } catch {
        return null;
      }
    }
    const parseIratxeJson = parsePulseJson;

    function parseEndnoteXml(text, name) {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return [];
      return [...doc.querySelectorAll('record')].map((record, index) => {
        const authors = [...record.querySelectorAll('contributors authors author, authors author, author')]
          .map(node => cleanField(node.textContent))
          .filter(Boolean);
        const keywords = [...record.querySelectorAll('keywords keyword, keyword')]
          .map(node => cleanField(node.textContent))
          .filter(Boolean);
        const year = textFrom(record, 'dates year, year');
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`,
          title: textFrom(record, 'titles title, title') || `Untitled EndNote record ${index + 1}`,
          authors,
          date: textFrom(record, 'dates date, pub-dates date, date') || year,
          year,
          journal: textFrom(record, 'periodical full-title, periodical abbrev-1, secondary-title, journal'),
          doi: normalizeDoi(textFrom(record, 'electronic-resource-num, doi')),
          abstract: textFrom(record, 'abstract, notes style'),
          paperKeywords: keywords,
          text: cleanField(record.textContent)
        }, 'EndNote XML');
      }).filter(paper => paper.title && !/^Untitled EndNote record/i.test(paper.title) || paper.doi);
    }

    function textFrom(root, selectors) {
      for (const selector of selectors.split(',')) {
        const node = root.querySelector(selector.trim());
        if (node?.textContent) return cleanField(node.textContent);
      }
      return '';
    }

    function parseBibtexRecords(text, name) {
      const records = text.split(/(?=@\w+\s*{)/g).filter(record => /^@\w+\s*{/.test(record.trim()));
      return records.map((record, index) => {
        const metadata = extractMetadata(record, extractCitationText(record));
        const abstract = extractAbstract(record, extractCitationText(record));
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`,
          title: extractTitle(record, extractCitationText(record), `${name} record ${index + 1}`),
          abstract,
          paperKeywords: extractPaperKeywords(record, record),
          ...metadata,
          text: extractCitationText(record)
        }, 'BibTeX');
      });
    }

    function parseRisRecords(text, name) {
      const records = text.split(/(?=^\s*TY\s*-)/gim).filter(record => /^\s*TY\s*-/im.test(record));
      return records.map((record, index) => {
        const cleaned = extractCitationText(record);
        const metadata = extractMetadata(record, cleaned);
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`,
          title: extractTitle(record, cleaned, `${name} record ${index + 1}`),
          abstract: extractAbstract(record, cleaned),
          paperKeywords: extractPaperKeywords(record, cleaned),
          ...metadata,
          text: cleaned
        }, 'RIS/EndNote');
      });
    }

    function parseCsvRecords(text, name) {
      const rows = parseCsv(text);
      if (rows.length < 2) return [];
      const headers = rows[0].map(header => header.toLowerCase().trim());
      return rows.slice(1).map((row, index) => {
        const get = names => {
          const found = names.map(item => headers.indexOf(item)).find(i => i >= 0);
          return found >= 0 ? row[found] || '' : '';
        };
        const title = get(['title', 'paper title', 'article title']);
        if (!title) return null;
        return normalizeImportedPaper({
          name: `${name} row ${index + 2}`,
          title,
          authors: splitAuthors(get(['authors', 'author', 'creators'])),
          date: get(['date', 'publication date', 'year']),
          year: (get(['year', 'date']).match(/\b(19|20)\d{2}\b/) || [''])[0],
          journal: get(['journal', 'publication', 'source', 'container-title']),
          doi: normalizeDoi(get(['doi', 'DOI'])),
          abstract: get(['abstract', 'summary']),
          paperKeywords: splitKeywords(get(['keywords', 'keyword', 'tags'])),
          text: row.join(' ')
        }, 'CSV');
      }).filter(Boolean);
    }

    function parseCsv(text) {
      const rows = [];
      let row = [];
      let value = '';
      let quoted = false;
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (char === '"' && quoted && next === '"') {
          value += '"';
          index += 1;
        } else if (char === '"') {
          quoted = !quoted;
        } else if (char === ',' && !quoted) {
          row.push(value.trim());
          value = '';
        } else if ((char === '\n' || char === '\r') && !quoted) {
          if (value || row.length) rows.push([...row, value.trim()]);
          row = [];
          value = '';
          if (char === '\r' && next === '\n') index += 1;
        } else {
          value += char;
        }
      }
      if (value || row.length) rows.push([...row, value.trim()]);
      return rows;
    }

    function normalizeImportedPaper(paper, source) {
      return {
        id: paper.id || uid(),
        name: paper.name || source,
        title: cleanField(paper.title || paper.name || 'Untitled paper'),
        authors: paperAuthors(paper),
        date: cleanField(paper.date || ''),
        year: cleanField(paper.year || (String(paper.date || '').match(/\b(19|20)\d{2}\b/) || [''])[0]),
        journal: cleanField(paper.journal || ''),
        doi: normalizeDoi(paper.doi || ''),
        pmid: String(paper.pmid || ''),
        abstract: cleanAbstract(paper.abstract || ''),
        paperKeywords: Array.isArray(paper.paperKeywords) ? paper.paperKeywords : splitKeywords(paper.paperKeywords || paper.keywords || ''),
        gemmaKeywords: Array.isArray(paper.gemmaKeywords) ? paper.gemmaKeywords : splitKeywords(paper.gemmaKeywords || ''),
        keyFindings: Array.isArray(paper.keyFindings) ? paper.keyFindings.slice(0, 5) : [],
        organisms: Array.isArray(paper.organisms) ? paper.organisms.slice(0, 16) : splitKeywords(paper.organisms || ''),
        techniques: Array.isArray(paper.techniques) ? paper.techniques.slice(0, 16) : splitKeywords(paper.techniques || ''),
        discoveryTerms: Array.isArray(paper.discoveryTerms) ? paper.discoveryTerms.slice(0, 24) : splitKeywords(paper.discoveryTerms || ''),
        openAlexId: normalizeOpenAlexId(paper.openAlexId || paper.openAlexUrl || ''),
        openAlexUrl: paper.openAlexUrl || (paper.openAlexId ? `https://openalex.org/${normalizeOpenAlexId(paper.openAlexId)}` : ''),
        referenceIds: dedupeList((paper.referenceIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByIds: dedupeList((paper.citedByIds || []).map(normalizeOpenAlexId).filter(Boolean)).slice(0, 160),
        citedByCount: Number(paper.citedByCount || 0),
        influentialCitationCount: paper.influentialCitationCount,
        text: String(paper.text || paper.abstract || '').slice(0, 120000),
        size: Number(paper.size || 0),
        x: Number(paper.x || 0),
        y: Number(paper.y || 0),
        color: paper.color || '',
        areaId: paper.areaId || '',
        s2PaperId: paper.s2PaperId || '',
        url: paper.url || '',
        openAccessPdf: paper.openAccessPdf || '',
        metadataNote: paper.metadataNote || '',
        metadataSource: paper.metadataSource || source
      };
    }

    function normalizeOpenAlexId(value) {
      const match = String(value || '').match(/\bW\d+\b/i);
      return match ? match[0].toUpperCase() : '';
    }

    function uniqueDoiCandidates(values) {
      const seen = new Set();
      const result = [];
      values.forEach(value => {
        const doi = normalizeDoi(value || '');
        if (!doi || seen.has(doi.toLowerCase())) return;
        seen.add(doi.toLowerCase());
        result.push(doi);
      });
      return result;
    }

    function metadataCompletionScore(paper) {
      let score = 0;
      if (paper.doi) score += 3;
      if (paper.title && !/^untitled/i.test(paper.title)) score += 3;
      if ((paper.authors || []).length) score += 2;
      if (paper.date || paper.year) score += 1;
      if (paper.journal) score += 1;
      if ((paper.abstract || '').length >= 120 && !looksBinary(paper.abstract)) score += 2;
      if ((paper.paperKeywords || []).length) score += 1;
      return score;
    }

    function metadataLooksFilled(paper) {
      return Boolean(
        paper.doi
        && paper.title
        && (paper.authors || []).length
        && (paper.date || paper.year)
        && paper.journal
        && (((paper.abstract || '').length >= 120 && !looksBinary(paper.abstract)) || (paper.paperKeywords || []).length)
      );
    }

    async function fillMetadataFromDoiLoop(paper, candidates) {
      const dois = uniqueDoiCandidates([paper.doi, ...(candidates || [])]).slice(0, 8);
      let bestScore = metadataCompletionScore(paper);
      for (const doi of dois) {
        if (metadataLooksFilled(paper)) break;
        const before = metadataCompletionScore(paper);
        const ok = await enrichPaperFromDoi(paper, doi);
        const after = metadataCompletionScore(paper);
        if (ok && after > bestScore) bestScore = after;
        if (!ok && before === after && !paper.doi) paper.doi = doi;
      }
    }

    async function enrichPaperFromDoi(paper, doiOverride = '') {
      const doi = normalizeDoi(doiOverride || paper.doi || '');
      if (!doi) return false;
      try {
        const response = await fetch(backendUrl('/api/metadata/doi'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ doi, expectedTitle: paper.title || paper.name || '' })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'DOI lookup failed.');
        paper.doi = result.doi || doi;
        mergeDoiMetadata(paper, result.metadata || {});
        paper.metadataSource = result.source || 'DOI';
        return true;
      } catch (error) {
        paper.metadataNote = `DOI lookup unavailable: ${error.message}`;
        return false;
      }
    }

    function mergeDoiMetadata(paper, metadata) {
      if (metadata.title) paper.title = metadata.title;
