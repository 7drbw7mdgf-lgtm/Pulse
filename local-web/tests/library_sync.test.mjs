// node --test local-web/tests/library_sync.test.mjs — two simulated Macs syncing through the real relay code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import worker from '../../services/relay/worker.mjs';
import { fakeD1 } from '../../services/relay/test/fake-d1.mjs';

const require = createRequire(import.meta.url);
globalThis.paperIdentityKey = paper => paper.doi ? `doi:${paper.doi.toLowerCase()}` : `title:${String(paper.title || '').toLowerCase()}`;
require('../pulse-frontend/js/library-sync.js');
const S = globalThis;

function relayFor(env) {
  return async (op, body) => {
    const response = await worker.fetch(new Request(`https://relay.example/sync/v1/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error); error.status = response.status; throw error; }
    return data;
  };
}

function mac(env, code, papers) {
  let stored = { code, device: '', lastSeq: 0, base: {} };
  const self = {
    papers, maps: [{ id: 'map-1', name: 'Map 1' }], removed: [],
    io: {
      relay: relayFor(env),
      loadState: async () => JSON.parse(JSON.stringify(stored)),
      saveState: async patch => { stored = { ...stored, ...JSON.parse(JSON.stringify(patch)) }; },
      removePapers: async ids => { self.removed.push(...ids); self.papers = self.papers.filter(p => !ids.includes(p.id)); },
      newPaper: view => { const paper = { ...JSON.parse(JSON.stringify(view)), id: 'local-' + Math.random().toString(36).slice(2), x: 0, y: 0 }; self.papers.push(paper); return paper; },
      workspace: () => ({ maps: self.maps }),
      setWorkspace: value => { self.maps = value.maps; }
    },
    sync: () => S.runLibrarySync(self.io, () => self.papers),
    find: doi => self.papers.find(p => p.doi.toLowerCase() === doi.toLowerCase()),
    views: () => self.papers.map(S.paperSyncView).sort((a, b) => a.doi.toLowerCase().localeCompare(b.doi.toLowerCase()))
  };
  return self;
}

const paper = (doi, fields = {}) => ({ id: 'id-' + doi, doi, title: 'Paper ' + doi, notes: '', userTags: [], readingStatus: '', mapIds: ['map-1'], x: 10, y: 20, text: 'full text of ' + doi, ...fields });

test('sync code encoding round-trips and is tolerant of formatting', () => {
  const code = S.newSyncCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{52}$/);
  assert.equal(S.encodeSyncCode(S.decodeSyncCode(S.formatSyncCode(code).toLowerCase())), code);
  assert.throws(() => S.decodeSyncCode('short'), /not valid/);
});

test('records are encrypted, and another code cannot read them', async () => {
  const keys = await S.deriveSyncKeys(S.newSyncCode()), other = await S.deriveSyncKeys(S.newSyncCode());
  const blob = await S.sealRecord(keys, { secret: 'Private note' });
  assert.deepEqual(await S.openRecord(keys, blob), { secret: 'Private note' });
  await assert.rejects(S.openRecord(other, blob));
  assert.notEqual(keys.vault, other.vault);
});

test('two Macs converge: join, merge, field-level edits, deletions', async () => {
  const env = { DB: fakeD1() };
  const code = S.newSyncCode();
  const a = mac(env, code, [paper('10.1/one', { notes: 'Note from the office iMac' }), paper('10.1/two')]);
  const b = mac(env, code, [paper('10.1/ONE', { id: 'b1', notes: 'Note from the MacBook', userTags: ['laptop'] }), paper('10.1/three')]);

  const first = await a.sync();
  assert.equal(first.pushed, 3, 'two papers and the workspace');
  await b.sync();
  assert.equal(b.papers.length, 3, 'the same paper on both Macs is matched, not duplicated');
  const one = b.find('10.1/ONE');
  assert.match(one.notes, /office iMac/); assert.match(one.notes, /MacBook/);
  assert.deepEqual(one.userTags, ['laptop']);
  assert.equal(b.find('10.1/two').x, 0, 'positions are not synced');
  assert.equal(b.find('10.1/two').text, undefined, 'extracted full text stays on its Mac');
  await a.sync();
  assert.deepEqual(a.views(), b.views(), 'both Macs hold the same library');

  // Different fields of the same paper edited on each Mac both survive.
  a.find('10.1/two').userTags = ['methods'];
  b.find('10.1/two').readingStatus = 'read';
  await a.sync(); await b.sync(); await a.sync();
  for (const m of [a, b]) {
    assert.deepEqual(m.find('10.1/two').userTags, ['methods']);
    assert.equal(m.find('10.1/two').readingStatus, 'read');
  }

  // A removal on one Mac reaches the other (through Pulse's recoverable removal).
  a.papers = a.papers.filter(p => p.doi !== '10.1/three');
  await a.sync(); await b.sync();
  assert.equal(b.find('10.1/three'), undefined);
  assert.equal(b.removed.length, 1);

  // An edit wins over a removal made on the other Mac before it saw the edit.
  a.find('10.1/two').notes = 'Edited on the iMac';
  await a.sync();
  b.papers = b.papers.filter(p => p.doi !== '10.1/two');
  await b.sync();
  assert.equal(b.find('10.1/two').notes, 'Edited on the iMac');

  // Nothing readable reaches the relay.
  const stored = JSON.stringify(env.DB.raw.prepare('SELECT * FROM records').all());
  for (const text of ['office iMac', 'MacBook', 'Paper 10.1', '10.1/two', 'methods', 'Edited on the iMac']) assert.ok(!stored.includes(text), text);
});

test('restarting a Mac (reloading its library) does not duplicate papers', async () => {
  const env = { DB: fakeD1() };
  const code = S.newSyncCode();
  const a = mac(env, code, [paper('10.1/one'), paper('10.1/two')]);
  const b = mac(env, code, []);
  await a.sync(); await b.sync();
  // Simulate a restart: the library is written to disk and loaded again (sync IDs must survive).
  a.papers = JSON.parse(JSON.stringify(a.papers));
  await a.sync(); await b.sync();
  assert.equal(b.papers.length, 2);
  assert.ok(a.papers.every(p => /^[0-9a-f]{32}$/.test(p.syncId)));
});

test('papers that lost or share a sync ID are repaired before upload', async () => {
  const env = { DB: fakeD1() };
  const a = mac(env, S.newSyncCode(), [paper('10.1/one', { syncId: 'ab'.repeat(16) }), paper('10.1/two', { syncId: 'ab'.repeat(16) }), paper('10.1/three', { syncId: null })]);
  const result = await a.sync();
  assert.equal(result.pushed, 4);
  assert.equal(new Set(a.papers.map(p => p.syncId)).size, 3);
});

test('a Mac with a different code sees nothing', async () => {
  const env = { DB: fakeD1() };
  const a = mac(env, S.newSyncCode(), [paper('10.1/one')]);
  await a.sync();
  const stranger = mac(env, S.newSyncCode(), []);
  await stranger.sync();
  assert.equal(stranger.papers.length, 0);
});

test('merge rules', () => {
  assert.deepEqual(S.mergeLists(['a', 'b'], ['a', 'b', 'c'], ['b', 'd']), ['b', 'c', 'd'], 'local add kept, remote add and remove applied');
  assert.equal(S.mergeNotes('abc', 'abc def'), 'abc def');
  assert.match(S.mergeNotes('mine', 'theirs'), /mine[\s\S]*other Mac[\s\S]*theirs/);
  const { merged, conflicts } = S.mergeSyncViews({ journal: 'J', year: '2020' }, { journal: 'J2', year: '2020' }, { journal: 'J3', year: '2021' });
  assert.deepEqual(merged, { journal: 'J2', year: '2021' }); assert.equal(conflicts, 1);
});
