    }

    function joinWrappedDois(text) {
      const always = text.replace(
        new RegExp(`(${DOI_PREFIX}/(?:${DOI_CHARS}*[-/])?)[ \\t]*\\r?\\n[ \\t]*${DOI_NEW_ITEM_GUARD}(?=[A-Za-z0-9(])`, 'g'),
        '$1'
      );
      return always.replace(
        new RegExp(`(${DOI_PREFIX}/${DOI_CHARS}*[._])[ \\t]*\\r?\\n[ \\t]*(?!\\d{1,3}[.)][ \\t])${DOI_NEW_ITEM_GUARD}(?=[a-z0-9])`, 'g'),
        '$1'
      );
    }

    function balanceDoiBrackets(doi) {
      let depth = 0;
      let openAt = -1;
      for (let index = 0; index < doi.length; index++) {
        const char = doi[index];
        if (char === '<') {
          if (depth === 0) openAt = index;
          depth++;
        } else if (char === '>') {
          if (depth === 0) return doi.slice(0, index);
          depth--;
        }
      }
      return depth ? doi.slice(0, openAt) : doi;
    }

    function cleanDoiCandidate(value) {
      let clean = prepareDoiText(value).trim()
        .replace(/^\s*(?:https?:\/\/)?(?:www\.|dx\.)?doi\.org\//i, '')
        .replace(/^\s*doi\s*[:=]?\s*/i, '')
        .replace(/\s+/g, '')
        .replace(/^["'{}[\]]+|["'{}[\]]+$/g, '');
      clean = clean.split(/<(?=[/!?A-Za-z])/)[0];
      clean = clean.split(/\)?(?:Tj|TJ|ET|BT|Tf|Tm|Td|TD|Do)\b/)[0];
      // PDF link annotations: "/URI (https://doi.org/10.x/y)/S/URI".
      clean = clean.split(/\)\/(?:S|URI|Type|Subtype|Rect|Border|BS|A|F|H|C|D|Dest|Next|NM|M|P|StructParent)\b/)[0];
      clean = clean.split(/(?:>>|<<|endobj|\bobj\b|\bstream\b)/i)[0];
      clean = balanceDoiBrackets(clean).replace(DOI_GLUED_TAIL, '$1');
      const count = (text, char) => text.split(char).length - 1;
      for (let pass = 0; pass < 3; pass++) {
        const before = clean;
        clean = clean.replace(/[.,;:'"]+$/, '');
        while (clean.endsWith(')') && count(clean, '(') < count(clean, ')')) {
          clean = clean.slice(0, -1).replace(/[.,;:]+$/, '');
        }
        clean = clean.replace(DOI_URL_SUFFIX, '')
          .replace(/^(10\.1101\/(?:\d{4}\.\d{2}\.\d{2}\.)?\d{6,})v\d+$/, '$1');
        if (clean === before) break;
      }
      return clean;
    }

    function validDoiCandidate(doi) {
      if (!doi || !/^10\.\d{4,9}(?:\.\d+)*\//i.test(doi)) return false;
      if (DOI_NON_PAPER_PREFIXES.some(prefix => doi.toLowerCase().startsWith(prefix))) return false;
      const suffix = doi.split('/').slice(1).join('/');
      if (suffix.length < 2 || doi.length > 200) return false;
      if (/[^\x20-\x7E]/.test(doi) || /[\\{}[\]|^`\s]/.test(doi)) return false;
      if (balanceDoiBrackets(doi) !== doi) return false;
      if (/^10\.\d+\/(?:obj|stream|length|filter|type|height|width|xobject|smask|bitspercomponent)\b/i.test(doi)) return false;
      if (/(?:\/Length|\/Filter|\/FlateDecode|\/Type|\/XObject|\/Width|\/Height|>>|<<|stream)/i.test(doi)) return false;
      return true;
    }

    // Every cleaned DOI as { doi, position, text, sourceIndex } in document order.
    function doiMatches(...values) {
      const found = [];
      const seen = new Set();
      for (const value of values) {
        const prepared = prepareDoiText(value);
        const joined = joinWrappedDois(prepared);
        const texts = joined === prepared ? [joined] : [joined, prepared];
        texts.forEach((text, sourceIndex) => {
          const pattern = new RegExp(`(^|[^0-9.])(${DOI_PREFIX}/${DOI_CHARS}+)`, 'g');
          for (const match of text.matchAll(pattern)) {
            const doi = cleanDoiCandidate(match[2]);
            const key = doi.toLowerCase();
            if (seen.has(key) || !validDoiCandidate(doi)) continue;
            if (sourceIndex && found.some(other => other.doi.toLowerCase().startsWith(key))) continue;
            seen.add(key);
            found.push({ doi, position: match.index + match[1].length, text, sourceIndex });
          }
        });
      }
      return found;
    }

    function normalizeDoi(value) {
      return doiMatches(value)[0]?.doi || '';
    }

    function sameDoi(left, right) {
      const a = normalizeDoi(left);
      return Boolean(a) && a.toLowerCase() === normalizeDoi(right).toLowerCase();
    }

    function findDoiCandidates(...values) {
      return doiMatches(...values).map(item => item.doi);
    }

    function findBestDoi(...values) {
      const refsByText = new Map();
      const ranked = doiMatches(...values).map(item => {
        if (!refsByText.has(item.text)) refsByText.set(item.text, [...item.text.matchAll(DOI_REFERENCES)].map(match => match.index));
        const refs = refsByText.get(item.text);
        let score = 0;
        if (DOI_MARKER.test(item.text.slice(Math.max(0, item.position - 40), item.position))) score += 4;
        if (refs.length && item.position > refs[refs.length - 1]) score -= 5;
        if (item.position < 4000) score += 1;
        if (item.sourceIndex) score -= 1;
        return { ...item, score };
      });
      ranked.sort((a, b) => (b.score - a.score) || (a.sourceIndex - b.sourceIndex) || (a.position - b.position));
      return ranked[0]?.doi || '';
    }

    function controlFindDoi(raw, cleanedText, buffer) {
      const candidates = [raw, cleanedText];
      if (buffer) {
        const bytes = new Uint8Array(buffer);
        const ascii = [];
        let current = '';
        for (const byte of bytes.subarray(0, Math.min(bytes.length, 8000000))) {
          if (byte >= 32 && byte <= 126) {
            current += String.fromCharCode(byte);
          } else if (current.length) {
            if (current.length >= 8) ascii.push(current);
            current = '';
          }
        }
        if (current.length >= 8) ascii.push(current);
        candidates.push(ascii.join('\n\n'));
      }
      return findBestDoi(...candidates);
    }

    function extractMetadata(raw, cleanedText) {
      const date = extractDate(raw, cleanedText);
      return {
        authors: extractAuthors(raw, cleanedText),
        date,
        year: (date.match(/\b(19|20)\d{2}\b/) || [''])[0],
        journal: extractJournal(raw, cleanedText),
        doi: extractDoi(raw, cleanedText)
      };
    }

    function extractAbstract(raw, cleanedText) {
      if (looksBinary(cleanedText)) return '';
      const labelled = firstMatch(raw, [
        /abstract\s*=\s*[{"]([\s\S]{80,5000}?)[}"],?\s*(?:\n\s*\w+\s*=|$)/i,
        /^\s*(?:AB|N2)\s*-\s*([\s\S]{80,5000}?)(?=\n\s*(?:[A-Z][A-Z0-9]\s*-|ER\s*-)|$)/im,
        /\babstract\b\s*[:.\-]?\s*([\s\S]{80,5000}?)(?=\n\s*(?:keywords?|key words|index terms|introduction|background|1\.?\s+introduction|i\.?\s+introduction|references)\b|$)/i,
        /^\s*summary\s*[:.\-]?\s*([\s\S]{80,3500}?)(?=\n\s*(?:keywords?|introduction|references)\b|$)/im
      ]);
      if (labelled) {
        const clean = cleanAbstract(labelled);
        return looksBinary(clean) ? '' : clean;
      }

      const paragraphs = cleanedText
        .split(/\n\s*\n|(?<=\.)\s{3,}/)
        .map(cleanAbstract)
        .filter(paragraph => paragraph.length > 120 && paragraph.length < 2200)
        .filter(paragraph => !/^(references|bibliography|acknowledg(e)?ments)\b/i.test(paragraph));
      const abstract = paragraphs.find(paragraph => abstractishScore(paragraph) >= 2) || paragraphs[0] || '';
      return looksBinary(abstract) ? '' : abstract;
    }

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
      const idMap = new Map();
      for (const paper of papers) {
        const key = paperIdentityKey(paper);
        const existing = key ? state.papers.find(item => paperIdentityKey(item) === key) : null;
        if (existing) {
          idMap.set(paper.id, existing.id);
          mergePaperIntoExisting(existing, paper);
          merged += 1;
        } else {
          idMap.set(paper.id, paper.id);
          state.papers.push(paper);
          added += 1;
        }
      }
      (state.pendingImportLinks || []).forEach(link => state.explicitLinks.push({
        ...link, source: idMap.get(link.source) || link.source, target: idMap.get(link.target) || link.target
      }));
      state.pendingImportLinks = [];
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
