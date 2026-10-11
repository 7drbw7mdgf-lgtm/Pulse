// Paper inspector helpers (1.7): tabs, compact metadata lines, citation text,
// links into the user's library and the personal reading fields.
const INSPECTOR_TABS = ['overview', 'connections', 'notes'];
const READING_STATUSES = [['to-read', 'To read'], ['reading', 'Reading'], ['read', 'Read']];
const RELEVANCE_CHOICES = [['relevant', 'Relevant'], ['not-relevant', 'Not relevant']];
const NAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'da', 'di', 'du', 'le', 'la', 'ó', 'o', 'mac', 'bin', 'al', 'el', 'dos', 'das']);

function inspectorTab() {
  if (!INSPECTOR_TABS.includes(state.inspectorTab)) {
    let saved = '';
    try { saved = localStorage.getItem('pulse-inspector-tab') || ''; } catch {}
    state.inspectorTab = INSPECTOR_TABS.includes(saved) ? saved : 'overview';
  }
  return state.inspectorTab;
}

function setInspectorTab(tab) {
  if (!INSPECTOR_TABS.includes(tab)) return;
  state.inspectorTab = tab;
  try { localStorage.setItem('pulse-inspector-tab', tab); } catch {}
}

// "Abdi Elmi" -> "Elmi A"; "Dominic C. Mills" -> "Mills DC"; "Tadhg Ó Cróinín" -> "Ó Cróinín T".
function shortAuthorName(name) {
  const value = String(name || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  let surname, given;
  if (value.includes(',')) {
    [surname, given] = value.split(/,(.*)/s).map(part => (part || '').trim());
  } else {
    const words = value.split(' ');
    // Already "Surname AB" (common in RIS and Mendeley records).
    if (words.length > 1 && /^([A-Z]\.?){1,3}$/.test(words[words.length - 1])) {
      return `${words.slice(0, -1).join(' ')} ${words[words.length - 1].replace(/\./g, '')}`;
    }
    let start = words.length - 1;
    while (start > 0 && NAME_PARTICLES.has(words[start - 1].toLowerCase())) start--;
    surname = words.slice(start).join(' ');
    given = words.slice(0, start).join(' ');
  }
  // Initials already written as "AB" stay as they are.
  const initials = /^[A-Z]{1,3}$/.test(given) ? given
    : given.split(/[\s.-]+/).filter(Boolean).map(part => part[0].toUpperCase()).join('');
  return initials ? `${surname} ${initials}` : surname;
}

function inspectorAuthorLine(paper) {
  const authors = paperAuthors(paper);
  if (!authors.length) return '';
  const shown = authors.slice(0, 3).map(shortAuthorName).join(', ');
  return authors.length > 3 ? `${shown} +${authors.length - 3}` : shown;
}

function inspectorPagination(paper) {
  const volume = String(paper.volume || '').trim();
  const issue = String(paper.issue || '').trim();
  const pages = String(paper.pages || paper.articleNumber || '').trim().replace(/[-–]/, '–');
  if (!volume) return pages;
  return `${volume}${issue ? `(${issue})` : ''}${pages ? `:${pages}` : ''}`;
}

// Vancouver style, the common biomedical form: authors, title, journal, year;vol(issue):pages.
function paperCitationText(paper) {
  const authors = paperAuthors(paper);
  const names = authors.slice(0, 6).map(shortAuthorName).join(', ') + (authors.length > 6 ? ', et al' : '');
  const title = String(paper.title || 'Untitled paper').trim().replace(/[.\s]+$/, '');
  const pagination = inspectorPagination(paper).replace('–', '-');
  const source = [paper.journal, [paper.year, pagination].filter(Boolean).join(';')].filter(Boolean).join('. ');
  return [names, title, source, paper.doi ? `doi:${paper.doi}` : ''].filter(Boolean).join('. ') + '.';
}

// Other papers in the library linked to this one, strongest first.
function libraryNeighbours(paper) {
  return (state.links || [])
    .filter(link => link.source === paper.id || link.target === paper.id)
    .map(link => {
      const other = state.papers.find(item => item.id === (link.source === paper.id ? link.target : link.source));
      if (!other) return null;
      // Skip fragments of a longer shared term ("jejuni" beside "Campylobacter jejuni").
      const terms = sharedKeywords(paper, other);
      const shared = terms.filter(term => !terms.some(longer => longer !== term && longer.toLowerCase().includes(term.toLowerCase())));
      return { link, other, score: Number(link.score) || 0, shared: shared.slice(0, 3) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function paperHasCitationData(paper) {
  return Boolean((paper.referenceIds || []).length || (paper.citedByIds || []).length);
}

function paperUserTags(paper) {
  return Array.isArray(paper.userTags) ? paper.userTags : [];
}

function addPaperUserTag(paper, value) {
  const tag = cleanField(String(value || '')).slice(0, 60);
  if (!tag) return false;
  const tags = paperUserTags(paper);
  if (tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) return false;
  paper.userTags = [...tags, tag].slice(0, 24);
  return true;
}

function removePaperUserTag(paper, value) {
  const before = paperUserTags(paper).length;
  paper.userTags = paperUserTags(paper).filter(tag => tag.toLowerCase() !== String(value || '').toLowerCase());
  return paper.userTags.length !== before;
}

function normalizedReadingStatus(value) {
  return READING_STATUSES.some(([key]) => key === value) ? value : '';
}

function normalizedRelevance(value) {
  return RELEVANCE_CHOICES.some(([key]) => key === value) ? value : '';
}

// The library list's order: tag filters, then the chosen sort.
function libraryDisplayPapers() {
  const papers = state.papers.filter(paperMatchesFilters);
  const sortKey = state.librarySortKey || 'year';
  const isAsc = Boolean(state.librarySortAsc);
  return papers.sort((a, b) => {
    let valA = a[sortKey] || '';
    let valB = b[sortKey] || '';
    if (sortKey === 'authors') {
      valA = (paperAuthors(a)[0] || '').toLowerCase();
      valB = (paperAuthors(b)[0] || '').toLowerCase();
    } else if (sortKey === 'citations') {
      valA = (paperCitationCount(a) ?? -1);
      valB = (paperCitationCount(b) ?? -1);
      return isAsc ? valA - valB : valB - valA;
    } else if (sortKey === 'year') {
      valA = String(valA);
      valB = String(valB);
      return isAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
    } else {
      valA = String(valA).toLowerCase();
      valB = String(valB).toLowerCase();
    }
    return isAsc ? valA.localeCompare(valB) : valB.localeCompare(valA);
  });
}
