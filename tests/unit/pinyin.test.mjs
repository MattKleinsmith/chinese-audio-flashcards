// pinyin.test.mjs — numeric-tone → tone-mark conversion and helpers (site/js/pinyin.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numericToMarks, syllableToMarks, toneOf, pinyinSegments, stripTones } from '../../site/js/pinyin.js';

test('converts the §8.1 cases', () => {
  const cases = {
    'xue2 xi2': 'xué xí',
    lv4: 'lǜ',
    nv3: 'nǚ',
    de5: 'de',
    er2: 'ér',
    xiong2: 'xióng',
    liu2: 'liú', // iu → mark on u
    gui4: 'guì', // ui → mark on i
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(numericToMarks(input), want, input);
});

test('placement rules: a/e first, then ou, then last vowel', () => {
  assert.equal(numericToMarks('hao3'), 'hǎo');
  assert.equal(numericToMarks('mei2'), 'méi');
  assert.equal(numericToMarks('zhou1'), 'zhōu');
  assert.equal(numericToMarks('guo2'), 'guó');
  assert.equal(numericToMarks('jiu3'), 'jiǔ');
  assert.equal(numericToMarks('tu2 shu1 guan3'), 'tú shū guǎn');
});

test('ü spellings, capitals, concatenated syllables, neutral tone 0', () => {
  assert.equal(numericToMarks('lu:4'), 'lǜ');
  assert.equal(numericToMarks('nu:e4'), 'nüè');
  assert.equal(numericToMarks('lve4'), 'lüè');
  assert.equal(numericToMarks('Zhong1 guo2'), 'Zhōng guó');
  assert.equal(numericToMarks('xue2xi2'), 'xuéxí');
  assert.equal(numericToMarks('ma0'), 'ma');
  assert.equal(syllableToMarks('n', 2), 'ń');
});

test('already tone-marked or plain text passes through', () => {
  assert.equal(numericToMarks('xué xí'), 'xué xí');
  assert.equal(numericToMarks('péng you'), 'péng you');
  assert.equal(numericToMarks(''), '');
  assert.equal(numericToMarks(undefined), '');
});

test('toneOf works for numeric and marked syllables', () => {
  assert.equal(toneOf('ma1'), 1);
  assert.equal(toneOf('xue2'), 2);
  assert.equal(toneOf('de5'), 5);
  assert.equal(toneOf('ma0'), 5);
  assert.equal(toneOf('hǎo'), 3);
  assert.equal(toneOf('shì'), 4);
  assert.equal(toneOf('ǚ'), 3);
  assert.equal(toneOf('de'), 5);
});

test('pinyinSegments splits syllables with tones', () => {
  assert.deepEqual(pinyinSegments('xue2 xi2'), [
    { text: 'xué', tone: 2 }, { text: ' ', tone: 0 }, { text: 'xí', tone: 2 },
  ]);
  assert.deepEqual(pinyinSegments('xue2xi2'), [{ text: 'xué', tone: 2 }, { text: 'xí', tone: 2 }]);
  assert.deepEqual(pinyinSegments(''), []);
});

test('stripTones normalises for search', () => {
  assert.equal(stripTones('xué xí'), 'xuexi');
  assert.equal(stripTones('xue2 xi2'), 'xuexi');
  assert.equal(stripTones('lǜ'), 'lu');
  assert.equal(stripTones('Péng you'), 'pengyou');
});
