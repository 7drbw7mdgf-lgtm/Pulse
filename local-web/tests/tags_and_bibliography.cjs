// Tags show real keywords (not automatic similarity terms), filters match whole words, and the
// Bibliography table abbreviates author lists.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const read = name => fs.readFileSync(`pulse-frontend/js/${name}`, 'utf8');
const slice = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

const state = { keywords: new Map(), papers: [] };
const context = { state, cleanField: value => String(value || '').trim(), paperUserTags: paper => paper.userTags || [] };
vm.createContext(context);
vm.runInContext(slice(read('paper-import.js'), '    function mergedKeywords(paper) {', '    function extractCitationText'), context);
vm.runInContext(slice(read('tags-and-keywords.js'), '    function tagMatchesFilter(tag, filter) {', '    function paperMatchesFilters'), context);
vm.runInContext(slice(read('library-list.js'), '    function shortAuthorList(', '    function renderPapers()'), context);

// Curated keywords win; automatic terms are never shown alongside them.
const curated = { id: 'a', paperKeywords: ['outer membrane vesicles', 'Campylobacter jejuni'], gemmaKeywords: ['virulence factors', 'Outer membrane vesicles'] };
state.keywords.set('a', ['deliver', 'deliver toxins', 'role', 'host']);
assert.deepEqual(context.displayKeywords(curated), ['outer membrane vesicles', 'Campylobacter jejuni', 'virulence factors']);
assert.ok(context.mergedKeywords(curated).includes('deliver'), 'similarity still uses every term');

// Without curated keywords, automatic terms appear without generic words.
const bare = { id: 'b' };
state.keywords.set('b', ['role', 'requires', 'open', 'invasion requires', 'gastrointestinal', 'bacterial evs', 'gut', 'tract']);
assert.deepEqual(context.displayKeywords(bare), ['gastrointestinal', 'bacterial evs']);

// Whole-word filter matching.
assert.equal(context.tagMatchesFilter('role', 'control'), false);
assert.equal(context.tagMatchesFilter('control', 'role'), false);
assert.equal(context.tagMatchesFilter('immunity', 'imm'), false);
assert.equal(context.tagMatchesFilter('innate immune response', 'immune response'), true);
assert.equal(context.tagMatchesFilter('vesicles', 'vesicles'), true);
assert.equal(context.tagMatchesFilter('c++ methods', 'c++'), true, 'filters with regex characters are escaped');

// Author lists in the Bibliography table.
assert.equal(context.shortAuthorList(['Cheng-mei Tian', 'Mei-feng Yang', 'Hao-ming Xu', 'Min-zheng Zhu']), 'Tian CM, Yang MF, Xu HM, et al.');
assert.equal(context.shortAuthorList(['A. Author', 'B. Second']), 'Author A, Second B');
assert.equal(context.shortAuthorList(['Smith, J.']), 'Smith, J.');
assert.equal(context.shortAuthorList([]), '');
console.log('PASS: display keywords exclude automatic terms when real ones exist, generic words are dropped, filters match whole words, author lists are abbreviated.');
