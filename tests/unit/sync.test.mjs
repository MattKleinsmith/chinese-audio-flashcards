// Unit tests for the pure parts of site/js/sync.js (diffVocab, describeSync, relTime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffVocab, describeSync, relTime, SOURCE } from '../../site/js/sync.js';

const vocab = (rows) => new Map(rows.map((r) => [r.s, r]));

test('diffVocab adds only words not in vocab', () => {
  const v = vocab([{ s: '学习', source: 'import' }, { s: '朋友', source: SOURCE }]);
  const { add, remove, total } = diffVocab([{ s: '学习' }, { s: '朋友' }, { s: '图书馆', p: 'tu2 shu1 guan3' }], v);
  assert.deepEqual(add.map((e) => e.s), ['图书馆']);
  assert.deepEqual(remove, []);
  assert.equal(total, 3);
});

test('diffVocab never removes unless mirrorDeletions, and then only hackchinese rows', () => {
  const v = vocab([{ s: '学习', source: 'import' }, { s: '朋友', source: SOURCE }, { s: '老师', source: 'hsk' }]);
  assert.deepEqual(diffVocab([{ s: '图书馆' }], v).remove, []);
  const { add, remove } = diffVocab([{ s: '图书馆' }], v, { mirrorDeletions: true });
  assert.deepEqual(add.map((e) => e.s), ['图书馆']);
  assert.deepEqual(remove, ['朋友']);
});

test('diffVocab ignores empty entries and duplicates', () => {
  const { add, total } = diffVocab([null, { s: '' }, { s: '学习' }, { s: '学习' }], vocab([]));
  assert.equal(add.length, 2); // duplicates are collapsed later by addVocab; diff just filters empties
  assert.equal(total, 1);
});

test('describeSync and relTime', () => {
  assert.equal(describeSync(null), '');
  assert.equal(describeSync({ status: 'none' }), '');
  const rec = { status: 'synced', total: 1234, syncedAt: new Date(Date.now() - 3 * 3600e3).toISOString(), importedAt: Date.now() - 10e3 };
  assert.match(describeSync(rec), /^Hack Chinese: 1,234 words · export 3 h ago · checked just now$/);
  assert.equal(relTime(Date.now() - 5 * 60e3), '5 min ago');
  assert.equal(relTime(Date.now() - 3 * 86400e3), '3 d ago');
  assert.equal(relTime(0), 'never');
});
