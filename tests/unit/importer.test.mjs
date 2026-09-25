// importer.test.mjs — format-agnostic vocab parsing (site/js/importer.js, PLAN §5.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVocabText, parseDelimited, detectDelimiter, detectHeader, isPinyinCell, splitWords, cleanCell,
} from '../../site/js/importer.js';

const words = (r) => r.entries.map((e) => e.s);

test('header CSV: simplified,pinyin,definition', () => {
  const r = parseVocabText('simplified,pinyin,definition\n学习,xué xí,to study\n朋友,péng you,friend\n');
  assert.deepEqual(words(r), ['学习', '朋友']);
  assert.deepEqual(r.entries[0], { s: '学习', p: 'xué xí', d: 'to study' });
  assert.deepEqual(r.mapping, { s: 0, t: null, p: 1, d: 2 });
  assert.equal(r.report.columnsUsed.s, 'simplified');
  assert.equal(r.report.total, 2);
  assert.equal(r.report.added, 2);
});

test('headerless TSV with columns inferred by content (the e2e paste)', () => {
  const r = parseVocabText('学习\t xué xí\t to study\n朋友\tpéng you\tfriend\n图书馆');
  assert.equal(r.delimiter, '\t');
  assert.equal(r.header, null);
  assert.deepEqual(words(r), ['学习', '朋友', '图书馆']);
  assert.deepEqual(r.mapping, { s: 0, t: null, p: 1, d: 2 });
  assert.equal(r.entries[1].p, 'péng you');
  assert.equal(r.entries[1].d, 'friend');
  assert.equal(r.entries[2].p, undefined);
});

test('headerless TSV with columns in a different order', () => {
  const r = parseVocabText('to study\txue2 xi2\t学习\nfriend\tpeng2 you5\t朋友\nlibrary\ttu2 shu1 guan3\t图书馆\n');
  assert.deepEqual(r.mapping, { s: 2, t: null, p: 1, d: 0 });
  assert.equal(r.entries[2].p, 'tu2 shu1 guan3');
});

test('one word per line', () => {
  const r = parseVocabText('学习\n朋友\n\n图书馆\n');
  assert.equal(r.delimiter, null);
  assert.deepEqual(words(r), ['学习', '朋友', '图书馆']);
});

test('quoted fields with commas, escaped quotes and embedded newlines', () => {
  const text = 'simplified,pinyin,definition\n朋友,péng you,"friend, pal"\n学习,xué xí,"to ""study""\nto learn"\n';
  const r = parseVocabText(text);
  assert.equal(r.delimiter, ',');
  assert.deepEqual(words(r), ['朋友', '学习']);
  assert.equal(r.entries[0].d, 'friend, pal');
  assert.equal(r.entries[1].d, 'to "study" to learn');
  assert.deepEqual(parseDelimited('a,"b,c",d\n', ','), [['a', 'b,c', 'd']]);
});

test('BOM and CRLF', () => {
  const r = parseVocabText('﻿simplified,pinyin\r\n学习,xue2 xi2\r\n朋友,peng2 you5\r\n');
  assert.deepEqual(words(r), ['学习', '朋友']);
  assert.equal(r.entries[1].p, 'peng2 you5');
  assert.equal(r.header[0], 'simplified');
});

test('multi-word cells are split: 朋友/朋友们, 、, commas, spaces', () => {
  assert.deepEqual(splitWords('朋友/朋友们'), ['朋友', '朋友们']);
  assert.deepEqual(splitWords('你、我 他'), ['你', '我', '他']);
  assert.deepEqual(splitWords('学习 (v.)'), ['学习']);
  const r = parseVocabText('朋友/朋友们\n学习（动词）\n');
  assert.deepEqual(words(r), ['朋友', '朋友们', '学习']);
});

test('traditional-only column', () => {
  const r = parseVocabText('traditional,pinyin\n學習,xue2 xi2\n朋友,peng2 you5\n');
  assert.deepEqual(words(r), ['學習', '朋友']);
  assert.equal(r.entries[0].t, '學習');
  assert.equal(r.mapping.t, 0);
  // With a lookup the traditional form is canonicalised to simplified.
  const lookup = (w) => ({ 學習: { s: '学习' }, 学习: { s: '学习' }, 朋友: { s: '朋友' } })[w];
  const r2 = parseVocabText('traditional\n學習\n朋友\n', { lookup });
  assert.deepEqual(r2.entries, [{ s: '学习', t: '學習' }, { s: '朋友', t: '朋友' }]);
});

test('simplified + traditional columns (two Han columns, no header)', () => {
  const r = parseVocabText('学习\t學習\txue2 xi2\n图书馆\t圖書館\ttu2 shu1 guan3\n');
  assert.deepEqual(r.mapping, { s: 0, t: 1, p: 2, d: null });
  assert.deepEqual(r.entries[1], { s: '图书馆', t: '圖書館', p: 'tu2 shu1 guan3' });
});

test('Anki plain-text export: tab separated, HTML stripped, headers skipped', () => {
  const text = '#separator:tab\n#html:true\n<b>学习</b>\txué xí\tto&nbsp;study<br>to learn [sound:xuexi.mp3]\n<div>朋友</div>\tpéng you\t<i>friend</i>\n';
  const r = parseVocabText(text);
  assert.deepEqual(words(r), ['学习', '朋友']);
  assert.equal(r.entries[0].d, 'to study to learn');
  assert.equal(r.entries[1].d, 'friend');
  assert.equal(cleanCell('a &amp; b'), 'a & b');
});

test('duplicates, rows without Han and malformed rows are counted, never thrown', () => {
  const r = parseVocabText('word\n学习\nhello\n学习\n朋友\n');
  assert.deepEqual(words(r), ['学习', '朋友']);
  assert.equal(r.report.duplicates, 1);
  assert.equal(r.report.rejected, 1);
  assert.doesNotThrow(() => parseVocabText('"unterminated,quote\n学习'));
  assert.deepEqual(parseVocabText('').entries, []);
});

test('Hack Chinese-like export with status column and semicolons', () => {
  const text = 'Simplified;Traditional;Pinyin;English;Status\n学习;學習;xué xí;to study;known\n老师;老師;lǎo shī;teacher;learning\n';
  const r = parseVocabText(text);
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.mapping, { s: 0, t: 1, p: 2, d: 3 });
  assert.deepEqual(r.entries[1], { s: '老师', t: '老師', p: 'lǎo shī', d: 'teacher' });
});

test('mapping override from the preview UI', () => {
  const r = parseVocabText('学习\txué xí\tto study\n', { mapping: { s: 0, p: null, d: 1 } });
  assert.deepEqual(r.entries[0], { s: '学习', d: 'xué xí' });
});

test('report.noAudio uses the lookup', () => {
  const lookup = (w) => (w === '学习' ? { s: '学习' } : undefined);
  const r = parseVocabText('学习\n你好\n', { lookup });
  assert.deepEqual(r.report.noAudio, ['你好']);
});

test('helpers: delimiter, header, pinyin classification', () => {
  assert.equal(detectDelimiter('a\tb\tc\nd\te\tf'), '\t');
  assert.equal(detectDelimiter('学习\n朋友'), null);
  assert.equal(detectDelimiter('"a,b";c\n"d,e";f'), ';');
  assert.equal(detectHeader(['Simplified', 'Pinyin']), true);
  assert.equal(detectHeader(['学习', 'xue2']), false);
  assert.equal(detectHeader(['foo', 'bar']), false);
  for (const p of ['xué xí', 'péng you', 'xue2 xi2', 'tu2shu1guan3', "xi'an", 'lü4']) assert.equal(isPinyinCell(p), true, p);
  for (const p of ['friend', 'to study', 'library', 'good', '']) assert.equal(isPinyinCell(p), false, p);
});
