
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
