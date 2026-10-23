// Paper inspector 1.7: compact metadata, citation text, library links, personal fields and saving.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const helpers = fs.readFileSync('pulse-frontend/js/inspector.js', 'utf8');
const normalizeSource = fs.readFileSync('pulse-frontend/js/part_08.js', 'utf8').split('    function normalizeImportedPaper(paper, source) {')[1].split('    function normalizeOpenAlexId')[0];

function context(papers = [], links = []) {
  const stored = {};
  const ctx = {
    state: { papers, links, filterTags: [], keywords: new Map() },
    localStorage: { getItem: key => stored[key], setItem: (key, value) => { stored[key] = value; } },
    paperAuthors: paper => paper.authors || [],
    paperCitationCount: paper => paper.citedByCount ?? null,
    paperMatchesFilters: paper => !ctx.state.filterTags.length || ctx.state.filterTags.every(tag => (paper.userTags || []).includes(tag)),
    mergedKeywords: paper => paper.paperKeywords || [],
    sharedKeywords(source, target) {
      const left = new Set((source.paperKeywords || []).map(term => term.toLowerCase()));
      return (target.paperKeywords || []).filter(term => left.has(term.toLowerCase()));
    },
    cleanField: value => String(value || '').replace(/\s+/g, ' ').trim(),
    splitKeywords: value => String(value || '').split(/[;,]/).map(part => part.trim()).filter(Boolean),
    stored
  };
  vm.createContext(ctx);
  vm.runInContext(helpers, ctx);
  return ctx;
}

const elmi = {
  id: 'elmi', title: 'Campylobacter jejuni Outer Membrane Vesicles Play an Important Role in Bacterial Interactions with Human Intestinal Epithelial Cells.',
  authors: ['Abdi Elmi', 'Eleanor Watson', 'Pamela Sandu', 'Ozan Gundogdu', 'Dominic C. Mills', 'Neil F. Inglis', 'Erin Manson'],
  year: '2012', journal: 'Infection and Immunity', volume: '80', issue: '12', pages: '4089-4098', doi: '10.1128/IAI.00161-12',
  paperKeywords: ['Campylobacter jejuni', 'jejuni', 'outer membrane vesicles'], citedByCount: 162
};
const croinin = { id: 'croinin', title: 'Host Epithelial Cell Invasion by Campylobacter jejuni', authors: ['Tadhg Ó Cróinín', 'Steffen Backert'], year: '2012', paperKeywords: ['Campylobacter jejuni', 'jejuni', 'virulence'], citedByCount: 150 };
const tiku = { id: 'tiku', title: 'Host immunity and cellular responses to bacterial outer membrane vesicles', authors: ['Varnesh Tiku', 'Man-Wah Tan'], year: '2021', paperKeywords: ['outer membrane vesicles'], citedByCount: 113 };

{
  const ctx = context();
  assert.equal(ctx.shortAuthorName('Abdi Elmi'), 'Elmi A');
  assert.equal(ctx.shortAuthorName('Dominic C. Mills'), 'Mills DC');
  assert.equal(ctx.shortAuthorName('Tadhg Ó Cróinín'), 'Ó Cróinín T');
  assert.equal(ctx.shortAuthorName('Kansakar, Pranaya'), 'Kansakar P');
  assert.equal(ctx.shortAuthorName('Ludwig van Beethoven'), 'van Beethoven L');
  assert.equal(ctx.shortAuthorName('Huang C'), 'Huang C');
  assert.equal(ctx.inspectorAuthorLine(elmi), 'Elmi A, Watson E, Sandu P +4');
  assert.equal(ctx.inspectorAuthorLine({ authors: ['Tadhg Ó Cróinín', 'Steffen Backert'] }), 'Ó Cróinín T, Backert S');
  assert.equal(ctx.inspectorPagination(elmi), '80(12):4089–4098');
  assert.equal(ctx.inspectorPagination({ pages: 'e1002' }), 'e1002');
  console.log('PASS: compact author and volume lines handle initials, particles, surname-first names and article numbers.');
}

{
  const ctx = context();
  assert.equal(ctx.paperCitationText(elmi),
    'Elmi A, Watson E, Sandu P, Gundogdu O, Mills DC, Inglis NF, et al. Campylobacter jejuni Outer Membrane Vesicles Play an Important Role in Bacterial Interactions with Human Intestinal Epithelial Cells. Infection and Immunity. 2012;80(12):4089-4098. doi:10.1128/IAI.00161-12.');
  assert.equal(ctx.paperCitationText({ title: 'Untitled draft' }), 'Untitled draft.');
  console.log('PASS: copied citations use Vancouver style and omit missing parts cleanly.');
}

{
  const ctx = context([elmi, croinin, tiku], [{ source: 'elmi', target: 'croinin', score: 0.19, type: 'similarity' }, { source: 'tiku', target: 'elmi', score: 0.31, type: 'citation' }, { source: 'tiku', target: 'croinin', score: 0.5 }]);
  const links = ctx.libraryNeighbours(elmi);
  assert.deepEqual(links.map(item => item.other.id), ['tiku', 'croinin'], 'strongest first, only links touching this paper');
  assert.deepEqual(links[1].shared, ['Campylobacter jejuni'], 'a fragment of a longer shared term is not repeated');
  assert.equal(ctx.paperHasCitationData(elmi), false);
  assert.equal(ctx.paperHasCitationData({ referenceIds: ['W1'] }), true);
  console.log('PASS: library connections list linked papers strongest first with de-duplicated shared concepts.');
}

{
  const ctx = context();
  const paper = {};
  assert.equal(ctx.addPaperUserTag(paper, '  thesis   ch. 2 '), true);
  assert.equal(ctx.addPaperUserTag(paper, 'THESIS CH. 2'), false, 'tags are unique regardless of case');
  assert.equal(ctx.addPaperUserTag(paper, ''), false);
  for (let i = 0; i < 40; i++) ctx.addPaperUserTag(paper, 'tag ' + i);
  assert.equal(paper.userTags.length, 24, 'at most 24 tags');
  assert.equal(ctx.removePaperUserTag(paper, 'Thesis ch. 2'), true);
  assert.equal(paper.userTags.includes('thesis ch. 2'), false);
  assert.equal(ctx.normalizedReadingStatus('reading'), 'reading');
  assert.equal(ctx.normalizedReadingStatus('finished'), '');
  assert.equal(ctx.normalizedRelevance('not-relevant'), 'not-relevant');
  assert.equal(ctx.normalizedRelevance(true), '');
  console.log('PASS: personal tags, reading status and relevance accept only valid values.');
}

{
  const ctx = context();
  assert.equal(ctx.inspectorTab(), 'overview', 'defaults to Overview');
  ctx.setInspectorTab('notes');
  assert.equal(ctx.stored['pulse-inspector-tab'], 'notes');
  ctx.setInspectorTab('nonsense');
  assert.equal(ctx.inspectorTab(), 'notes', 'unknown tabs are ignored');
  const reloaded = context();
  reloaded.localStorage.setItem('pulse-inspector-tab', 'connections');
  assert.equal(reloaded.inspectorTab(), 'connections', 'the chosen tab is remembered');
  console.log('PASS: the selected inspector tab is validated and remembered.');
}

{
  const papers = [elmi, croinin, tiku].map(paper => ({ ...paper }));
  const ctx = context(papers);
  assert.deepEqual(ctx.libraryDisplayPapers().map(paper => paper.id), ['tiku', 'elmi', 'croinin'], 'default: newest first, ties keep library order');
  ctx.state.librarySortKey = 'citations';
  assert.deepEqual(ctx.libraryDisplayPapers().map(paper => paper.id), ['elmi', 'croinin', 'tiku']);
  ctx.state.librarySortAsc = true;
  assert.deepEqual(ctx.libraryDisplayPapers().map(paper => paper.id), ['tiku', 'croinin', 'elmi']);
  papers[2].userTags = ['OMV methods'];
  ctx.state.filterTags = ['OMV methods'];
  assert.deepEqual(ctx.libraryDisplayPapers().map(paper => paper.id), ['tiku'], 'previous/next follow the filtered library');
  console.log('PASS: previous/next follow the library list order, sort and filters.');
}

{
  const ctx = context();
  Object.assign(ctx, {
    uid: () => 'generated', paperAuthors: paper => paper.authors || [], normalizeDoi: value => value, findPrimaryDoi: () => '',
    safeHref: value => value, cleanAbstract: value => value, dedupeList: values => [...new Set(values)], normalizeOpenAlexId: value => value
  });
  vm.runInContext('function normalizeImportedPaper(paper, source) {' + normalizeSource, ctx);
  const restored = ctx.normalizeImportedPaper({ title: 'Saved paper', readingStatus: 'read', relevance: 'relevant', notes: 'Check figure 3.', userTags: ['methods', ' review '] }, 'test');
  assert.equal(restored.readingStatus, 'read');
  assert.equal(restored.relevance, 'relevant');
  assert.equal(restored.notes, 'Check figure 3.');
  assert.deepEqual([...restored.userTags], ['methods', 'review']);
  const cleaned = ctx.normalizeImportedPaper({ title: 'Imported', readingStatus: 'maybe', relevance: 'yes', notes: 'x'.repeat(25000), userTags: 'a; b' }, 'test');
  assert.equal(cleaned.readingStatus, '');
  assert.equal(cleaned.relevance, '');
  assert.equal(cleaned.notes.length, 25000, 'Long notes from merged records are preserved');
  const merged = ctx.normalizeImportedPaper({title:'Merged',notes:'a'.repeat(25000)+'\n\n'+'b'.repeat(25000),userTags:Array.from({length:40},(_,i)=>'tag-'+i)},'test');
  assert.equal(merged.notes.length,50002);
  assert.equal(merged.userTags.length,40,'Merged tags are preserved beyond the normal editing limit');
  assert.deepEqual([...cleaned.userTags], ['a', 'b']);
  // Library sync links copies of a paper by syncId; reloading the library must keep it.
  const synced = ctx.normalizeImportedPaper({ title: 'Synced', syncId: 'ab'.repeat(16) }, 'test');
  assert.equal(synced.syncId, 'ab'.repeat(16));
  assert.equal(ctx.normalizeImportedPaper({ title: 'Bad id', syncId: '../x' }, 'test').syncId, '');
  console.log('PASS: reading status, relevance, notes and tags survive saving and restoring, and invalid values are cleaned.');
}
