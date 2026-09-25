// DataBundle.lookup falls back from words.json to dict.json to composed characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataBundle } from '../../site/js/data.js';

const manifest = { schemaVersion: 1, builtAt: '2026-01-01T00:00:00Z', baseUrl: '', counts: {}, sources: [], files: {} };
const words = [{ id: 'w_1', s: '学习', t: '學習', p: 'xue2 xi2', d: ['to study'], hsk: 1, clips: [{ id: 'c1', file: 'clips/words/c1.mp3', ms: 1000 }] }];
const dict = { '刷卡': { p: 'shua1 ka3', d: ['to swipe a card'] }, '火': { p: 'huo3', d: ['fire'] }, '车': { t: '車', p: 'che1', d: ['car', 'vehicle'] }, '坐': { p: 'zuo4', d: ['to sit'] } };
const data = new DataBundle(manifest, words, [], './data/', dict);

test('words.json wins and reports audio', () => {
  const w = data.lookup('学习');
  assert.equal(w.p, 'xue2 xi2'); assert.equal(w.clips.length, 1); assert.equal(data.hasAudio('学习'), true);
});

test('dict.json entry for a word without audio', () => {
  const w = data.lookup('刷卡');
  assert.deepEqual({ s: w.s, p: w.p, d: w.d, source: w.source, clips: w.clips.length }, { s: '刷卡', p: 'shua1 ka3', d: ['to swipe a card'], source: 'dict', clips: 0 });
  assert.equal(data.hasAudio('刷卡'), false);
});

test('composed from characters when the word itself is unknown', () => {
  const w = data.lookup('坐火车');
  assert.equal(w.source, 'chars'); assert.equal(w.p, 'zuo4 huo3 che1'); assert.equal(w.t, '坐火車');
  assert.equal(w.charGlosses.length, 3); assert.deepEqual(w.charGlosses[1], { c: '火', p: 'huo3', d: ['fire'] });
});

test('undefined when even a character is unknown; single unknown chars are not composed', () => {
  assert.equal(data.lookup('坐飞机'), undefined);
  assert.equal(data.lookup('飞'), undefined);
});
