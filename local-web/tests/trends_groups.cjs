// Trends topic groups: every paper in one concept group, with distinct labels in the library's own spelling.
const assert = require('assert');
global.PulseGraph = require('../pulse-frontend/graph-engine.js');
const data = require('../pulse-frontend/js/trends-groups.js');

const themes = [
  { words: 'reactive oxygen species nadph oxidase superoxide signalling', keyword: 'NADPH oxidase' },
  { words: 'campylobacter jejuni flagella motility chemotaxis colonisation', keyword: 'Campylobacter jejuni' },
  { words: 'gut microbiota epithelial barrier mucus tight junctions', keyword: 'Epithelial barrier' }];
const papers = [];
themes.forEach((theme, t) => {
  for (let i = 0; i < 24; i++) papers.push({ id: `p${t}-${i}`, title: `${theme.words.split(' ').slice(0, 3).join(' ')} study ${i}`,
    abstract: `${theme.words} ${theme.words} variation ${i}`, keywords: [theme.keyword], year: String(2010 + (i % 16)) });
});
const analysis = data.analyse(papers);
const clusters = data.partition(analysis, 3, paper => paper.keywords);
const assigned = clusters.flatMap(cluster => cluster.papers.map(paper => paper.id));
assert.equal(assigned.length, papers.length, 'Every paper belongs to exactly one cluster');
assert.equal(new Set(assigned).size, papers.length);
assert.equal(clusters.length, 3, 'Three distinct themes form three clusters');
for (const cluster of clusters) assert.equal(new Set(cluster.papers.map(paper => paper.id.split('-')[0])).size, 1, `${cluster.label} holds one theme`);
assert.deepEqual(clusters.map(cluster => cluster.label.split(' · ')[0]).sort(), ['Campylobacter jejuni', 'Epithelial barrier', 'NADPH oxidase'], 'Labels use the library spelling of distinctive keywords');
assert.equal(data.partition(analysis, 6, paper => paper.keywords).reduce((sum, cluster) => sum + cluster.papers.length, 0), papers.length, 'Finer detail still keeps every paper');

const library = [...papers, { id: 'empty', title: '', abstract: '' }];
const placed = data.groupLibrary(library, data.analyse(library), 3, paper => paper.keywords || []);
assert.equal(placed.groups.reduce((sum, group) => sum + group.papers.length, 0), library.length, 'Papers without text still appear');
assert.equal(placed.groups.at(-1).label, 'Not enough text to group');
assert.equal(placed.groupOf.get('empty'), 'group-ungrouped');
console.log('PASS: Trends topic groups put every paper in exactly one group, label groups distinctly and keep papers without text in their own group.');
