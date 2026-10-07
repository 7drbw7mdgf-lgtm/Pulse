const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, Map, Set, TextDecoder, Uint8Array, URLSearchParams,
  crypto: require('node:crypto').webcrypto,
  document: {createElement() {return {set innerHTML(text){this.value=text.replace(/&amp;/g,'&')},value:''}}},
  window: {}, state: {papers:[]}, els: {}, stopwords: new Set(), uid: ()=>require('node:crypto').randomUUID(),
  fetch: async()=>{throw new Error('Unexpected live request in unit test')}
});
for (const part of ['05','06','07','08','13']) vm.runInContext(fs.readFileSync(`pulse-frontend/js/part_${part}.js`,'utf8'),context);
const run = code=>vm.runInContext(code,context);
for (const input of ['https://doi.org/10.1037%2Fh0054346?x=1','DOI: 10.\n1037 / h0054346.','%31%30%2E%31%30%33%37%2Fh0054346','１０．１０３７／h0054346','10&#46;1037&#47;h0054346']) {
  assert.equal(run(`normalizeDoi(${JSON.stringify(input)})`),'10.1037/h0054346');
}
const bib='@article{key, title={A {nested} title, with punctuation}, author={Maslow, Abraham H. and Smith, Jane}, year={1943}, journal={Psychological Review}, doi={https://doi.org/10.1037%2Fh0054346}, abstract={A nested {brace} and an @email address.}, volume={50}, pages={370--396}}';
const parsed=run(`parseBibtexRecords(${JSON.stringify(bib)},'test.bib')`);
assert.equal(parsed.length,1); assert.equal(parsed[0].title,'A nested title, with punctuation');
assert.equal(parsed[0].authors.length,2); assert.equal(parsed[0].authors[0],'Maslow, Abraham H.');
assert.equal(parsed[0].doi,'10.1037/h0054346'); assert.equal(parsed[0].volume,'50');
const ris='TY  - JOUR\nTI  - A theory of human motivation\nAU  - Maslow, Abraham H.\nAU  - Smith, Jane\nUR  - https://doi.org/10.1037/h0054346\nAB  - An abstract with\n      wrapped lines\nVL  - 50\nSP  - 370\nEP  - 396\nPY  - 1943\nER  -';
const records=run(`parseRisRecords(${JSON.stringify(ris)},'test.ris')`);
assert.equal(records[0].authors.length,2);assert.equal(records[0].authors[1],'Smith, Jane');
assert.equal(records[0].abstract,'An abstract with wrapped lines');assert.equal(records[0].pages,'370-396');
assert.equal(records[0].doi,'10.1037/h0054346');
assert.equal(run(`findPrimaryDoi('Original article title\\nReferences\\nDOI: 10.1037/h0054346')`),'');
console.log('PASS: DOI encodings, inline/nested BibTeX, multiple RIS authors, wrapped abstract, metadata fields, and reference exclusion.');
