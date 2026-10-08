
    function extractPaperKeywords(raw, cleanedText) {
      const labelled = firstMatch(raw, [
        /keywords?\s*=\s*[{"]([\s\S]{3,1000}?)[}"],?\s*(?:\n\s*\w+\s*=|$)/i,
        /^\s*(?:KW|DE)\s*-\s*([\s\S]{3,1000}?)(?=\n\s*(?:[A-Z][A-Z0-9]\s*-|ER\s*-)|$)/im,
        /\b(?:keywords?|key words|index terms)\b\s*[:.\-]\s*([\s\S]{3,1000}?)(?=\n\s*(?:abstract|introduction|background|1\.?\s+introduction|references)\b|$)/i
      ]);
      if (labelled) return splitKeywords(labelled);

      const candidate = cleanedText.match(/\b(?:keywords?|key words|index terms)\b\s*[:.\-]\s*([^\n]{3,500})/i);
      return candidate ? splitKeywords(candidate[1]) : [];
    }

    function cleanAbstract(value) {
      return cleanField(value)
        .replace(/^abstract\s*[:.\-]?\s*/i, '')
        .replace(/^summary\s*[:.\-]?\s*/i, '')
        .replace(/\b(?:keywords?|key words|index terms)\b\s*[:.\-][\s\S]*$/i, '')
        .replace(/\b(?:introduction|references)\b\s*$/i, '')
        .trim();
    }

    function abstractishScore(paragraph) {
      const signals = [
        /\b(this paper|this study|we propose|we present|we examine|we investigate|we evaluate)\b/i,
        /\b(method|methods|approach|model|framework|experiment|analysis|dataset|data)\b/i,
        /\b(result|results|finding|findings|show|shows|demonstrate|conclude)\b/i,
        /\b(research|study|paper|article|literature)\b/i
      ];
      return signals.reduce((score, pattern) => score + (pattern.test(paragraph) ? 1 : 0), 0);
    }

    function looksBinary(value) {
      const text = String(value || '');
      if (!text.trim()) return false;
      const sample = text.slice(0, 1200);
      const replacementCount = (sample.match(/\uFFFD|�/g) || []).length;
      const pdfObjectCount = (sample.match(/\/(?:Length|Filter|FlateDecode|XObject|SMask|Width|Height|BitsPerComponent|stream|endstream)\b/g) || []).length;
      const controlCount = (sample.match(/[\x00-\x08\x0E-\x1F]/g) || []).length;
      const readable = (sample.match(/[A-Za-z]{3,}/g) || []).join('').length;
      return replacementCount > 5 || pdfObjectCount > 3 || controlCount > 8 || readable / Math.max(sample.length, 1) < 0.18;
    }

    function isPdfOrBinary(file, decodedText) {
      const name = (file.name || '').toLowerCase();
      return name.endsWith('.pdf') || decodedText.startsWith('%PDF') || looksBinary(decodedText);
    }

    function paperIdentityKey(paper) {
      const doi = normalizeDoi(paper.doi || '');
      if (doi) return `doi:${doi.toLowerCase()}`;
      const title = cleanField(paper.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return title ? `title:${title}` : '';
    }

    function mergePaperIntoExisting(existing, incoming) {
      mergeDoiMetadata(existing, incoming);
      if (!existing.name && incoming.name) existing.name = incoming.name;
      if (!existing.size && incoming.size) existing.size = incoming.size;
      if (!existing.text && incoming.text) existing.text = incoming.text;
      if (incoming.text && incoming.text.length > (existing.text || '').length && !looksBinary(incoming.text)) {
        existing.text = incoming.text;
      }
      if (incoming.metadataSource) existing.metadataSource = incoming.metadataSource;
      if (incoming.metadataNote) existing.metadataNote = incoming.metadataNote;
    }

    function addParsedPapers(papers) {
      let added = 0;
      let merged = 0;
      for (const paper of papers) {
        const key = paperIdentityKey(paper);
        const existing = key ? state.papers.find(item => paperIdentityKey(item) === key) : null;
        if (existing) {
          mergePaperIntoExisting(existing, paper);
          merged += 1;
        } else {
          state.papers.push(paper);
          added += 1;
        }
      }
      return { added, merged };
    }

    function mergedKeywords(paper) {
      return [...new Set([...(paper.paperKeywords || []), ...(paper.gemmaKeywords || []), ...(state.keywords.get(paper.id) || [])])].slice(0, 16);
    }

    function extractCitationText(raw) {
      return raw
        .replace(/\u0000/g, ' ')
        .replace(/%PDF-[\s\S]{0,240}/, ' ')
        .replace(/@\w+\s*{[^,]+,/g, ' ')
        .replace(/^\s*(TI|T1|AB|N2|KW|AU|PY|DE)\s*-\s*/gm, ' ')
        .replace(/[{}\\]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    async function scanFileMetadata(file, buffer) {
      try {
        const response = await fetch(backendUrl('/api/metadata/scan'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            name: file.name,
            contentBase64: arrayBufferToBase64(buffer)
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Python DOI scan failed.');
        return result;
      } catch (error) {
        return { ok: false, found: false, metadata: {}, error: error.message };
      }
    }

    async function extractWithGemmaLayer(paper, options = {}) {
      if (!state.localInferenceEnabled && els.aiProviderInput?.value === 'local') {
        paper.metadataNote = paper.metadataNote || 'Local AI runtime not detected. Start Ollama or choose a cloud provider.';
        return null;
      }
      const excerpt = [
        options.usableText || '',
        paper.abstract || '',
        paper.text || ''
      ].filter(Boolean).join('\n\n').slice(0, 18000);
      if (!excerpt && !(options.doiCandidates || []).length) return null;
      try {
        const response = await fetch(backendUrl('/api/metadata/gemma'), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            name: paper.name || '',
            title: paper.title || '',
            abstract: paper.abstract || '',
            keywords: paper.paperKeywords || [],
            doiCandidates: options.doiCandidates || [],
            text: excerpt
          })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Gemma extraction failed.');
        if (result.metadata && Object.keys(result.metadata).length) {
          mergeDoiMetadata(paper, result.metadata);
          paper.gemmaKeywords = result.metadata.paperKeywords || paper.gemmaKeywords || [];
          paper.metadataSource = result.source || 'Local chat abstraction';
          paper.metadataNote = '';
        }
        if ((result.keyFindings || []).length) paper.keyFindings = result.keyFindings.slice(0, 5);
        if ((result.organisms || []).length) paper.organisms = dedupeList([...(paper.organisms || []), ...result.organisms]).slice(0, 16);
        if ((result.techniques || []).length) paper.techniques = dedupeList([...(paper.techniques || []), ...result.techniques]).slice(0, 16);
        if ((result.discoveryTerms || []).length) paper.discoveryTerms = dedupeList([...(paper.discoveryTerms || []), ...result.discoveryTerms]).slice(0, 24);
        return result;
      } catch (error) {
        paper.metadataNote = paper.metadataNote || `Local chat extraction unavailable: ${error.message}`;
        return null;
      }
    }

    async function readFile(file) {
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
      else if (!scanned?.ok && foundDoi) metadata.doi = findPrimaryDoi(safeRaw);
      const initialTitle = scanned?.metadata?.title || scanned?.title || (usableText ? extractTitle(safeRaw, usableText, file.name) : normalizeTitle(file.name, ''));
      const paper = {
        id: uid(),
        name: file.name,
        title: initialTitle,
        abstract: scanned?.metadata?.abstract || abstract,
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
      if (scanned?.resolution) {
        const result = scanned.resolution;
        paper.doiVerified = Boolean(result.metadata?.doiVerified);
        paper.metadataMatch = { matched: result.matched, strategy: result.strategy, ambiguous: result.ambiguous,
          score: result.match?.score, candidates: result.candidates || [] };
        paper.metadataNote = result.matched ? `Matched using ${result.strategy === 'doi' ? 'DOI' : 'available metadata'} (${result.source}).`
          : result.ambiguous ? 'Several papers match. Original extracted details kept; add a DOI to identify the paper.'
          : 'No confident online match. Extracted details kept.';
      } else {
        await resolvePaperMetadata(paper);
      }
      if (browserTextIsUnsafe && !backendText && !paper.metadataMatch?.matched) {
        paper.metadataNote = 'No readable PDF text was found. Add the paper title, DOI or other metadata to search.';
      }
      return paper;
    }

    async function readImportFile(file) {
      const lowerName = (file.name || '').toLowerCase();
      if (lowerName.endsWith('.pdf')) return [await readFile(file)];
      const text = await file.text();
      let papers = null;
      if (lowerName.endsWith('.json')) {
        papers = parsePulseJson(text);
      } else if (lowerName.endsWith('.xml') || /<\?xml|<xml|<record[\s>]|<records[\s>]/i.test(text.slice(0, 2000))) {
        papers = parseEndnoteXml(text, file.name);
      } else if (lowerName.endsWith('.bib') || /@\w+\s*{/.test(text)) {
        papers = parseBibtexRecords(text, file.name);
      } else if (lowerName.endsWith('.ris') || lowerName.endsWith('.enw') || /^\s*TY\s*-/im.test(text)) {
        papers = parseRisRecords(text, file.name);
      } else if (lowerName.endsWith('.csv')) {
        papers = parseCsvRecords(text, file.name);
      } else {
        return [await readFile(file)];
      }
      if (!papers || !papers.length) return [];
      // Every record uses DOI first, then all parsed bibliographic fields.
      for (const paper of papers) {
        await resolvePaperMetadata(paper);
      }
      return papers;
    }

    function parsePulseJson(text) {
      try {
        const data = JSON.parse(text);
        const papers = Array.isArray(data.papers) ? data.papers : (Array.isArray(data) ? data : []);
        if (!papers.length) return null;
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
          doi: normalizeDoi(textFrom(record, 'electronic-resource-num, doi, urls web-urls url, url')),
          volume: textFrom(record, 'volume'), issue: textFrom(record, 'number, issue'), pages: textFrom(record, 'pages'),
          issn: textFrom(record, 'isbn, issn'), pmid: textFrom(record, 'pmid'),
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
      const records = [];
      const entry = /@(\w+)\s*([{(])/g;
      let match;
      while ((match = entry.exec(text))) {
        const closing = match[2] === '{' ? '}' : ')';
        let position = entry.lastIndex;
        let depth = 1, quoted = false;
        while (position < text.length && depth) {
          const ch = text[position];
          if (ch === String.fromCharCode(92)) { position += 2; continue; }
          if (ch === '"') quoted = !quoted;
          if (!quoted) {
            if (ch === match[2]) depth++;
            if (ch === closing) depth--;
          }
          position++;
        }
        if (depth) break;
        const body = text.slice(entry.lastIndex, position - 1);
        entry.lastIndex = position;
        if (/^(?:comment|string|preamble)$/i.test(match[1])) continue;
        const fields = {};
        let cursor = body.indexOf(',') + 1;
        while (cursor > 0 && cursor < body.length) {
          const field = /^\s*,?\s*([a-z][\w-]*)\s*=\s*/i.exec(body.slice(cursor));
          if (!field) break;
          cursor += field[0].length;
          let value = '';
          // Concatenation (#) joins quoted, braced and numeric field values.
          while (cursor < body.length) {
            while (/\s/.test(body[cursor] || '') && cursor < body.length) cursor++;
            const delimiter = body[cursor];
            if (delimiter === '{') {
              const begin = ++cursor;
              let nesting = 1;
              while (cursor < body.length && nesting) {
                if (body[cursor] === String.fromCharCode(92)) { cursor += 2; continue; }
                if (body[cursor] === '{') nesting++;
                if (body[cursor] === '}') nesting--;
                cursor++;
              }
              value += body.slice(begin, cursor - 1);
            } else if (delimiter === '"') {
              const begin = ++cursor;
              while (cursor < body.length && body[cursor] !== '"') {
                if (body[cursor] === String.fromCharCode(92)) cursor++;
                cursor++;
              }
              value += body.slice(begin, cursor++);
            } else {
              const begin = cursor;
              while (cursor < body.length && !/[,#]/.test(body[cursor])) cursor++;
              value += body.slice(begin, cursor).trim();
            }
            while (cursor < body.length && /\s/.test(body[cursor])) cursor++;
            if (body[cursor] !== '#') break;
            cursor++;
          }
          fields[field[1].toLowerCase()] = value.replace(/[{}]/g, '').trim();
          if (body[cursor] === ',') cursor++;
        }
        const raw = text.slice(match.index, position);
        records.push(normalizeImportedPaper({
          name: `${name} record ${records.length + 1}`, title: fields.title || '',
          authors: (fields.author || '').split(/\s+and\s+/i).filter(Boolean),
          year: fields.year || '', date: fields.date || fields.year || '',
          journal: fields.journaltitle || fields.journal || fields.booktitle || '',
          volume: fields.volume || '', issue: fields.number || fields.issue || '', pages: fields.pages || '', issn: fields.issn || '', publisher: fields.publisher || '', url: fields.url || '', articleNumber: fields.eid || fields.article_number || '', isbn: fields.isbn || '', language: fields.language || '', publicationType: {book:'book',inproceedings:'proceedings-article',phdthesis:'dissertation',mastersthesis:'dissertation'}[match[1].toLowerCase()] || 'journal-article',
          doi: normalizeDoi(fields.doi || fields.url || fields.eprint || '') || findPrimaryDoi(raw),
          abstract: fields.abstract || '', paperKeywords: splitKeywords(fields.keywords || ''), text: raw
        }, 'BibTeX'));
      }
      return records;
    }

    function parseRisRecords(text, name) {
      const records = text.split(/(?=^\s*TY\s+-)/gim).filter(record => /^\s*TY\s+-/im.test(record));
      return records.map((record, index) => {
        const fields = {};
        let previous = '';
        for (const line of record.split(/\r?\n/)) {
          const tagged = /^\s*([A-Z][A-Z0-9])\s+-\s?(.*)$/.exec(line);
          if (tagged) {
            previous = tagged[1];
            (fields[previous] ||= []).push(tagged[2].trim());
          } else if (previous && line.trim()) {
            const values = fields[previous];
            values[values.length - 1] += ' ' + line.trim();
          }
        }
        const first = (...tags) => tags.map(tag => fields[tag]?.[0]).find(Boolean) || '';
        return normalizeImportedPaper({
          name: `${name} record ${index + 1}`, title: first('TI','T1'),
          authors: fields.AU || fields.A1 || fields.FAU || [],
          journal: first('JF','JO','T2','JA'), date: first('DA','Y1','PY'), year: first('PY','Y1').slice(0,4),
          volume: first('VL'), issue: first('IS'), pages: [first('SP'),first('EP')].filter(Boolean).join('-'), issn: first('SN'), publisher: first('PB'), url: first('UR'), language: first('LA'), pmid: first('AN').replace(/^PMID:/i,''), date: first('DA') || first('Y1'),
          doi: normalizeDoi(first('DO','UR','L1')) || findPrimaryDoi(record), pmid: first('PM'),
          abstract: first('AB','N2'), paperKeywords: fields.KW || [], text: record
        }, 'RIS/EndNote');
      });
    }
