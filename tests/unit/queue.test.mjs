// queue.test.mjs — session queue building (site/js/queue.js, PLAN §5.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildQueue, queueStats, ALWAYS_KNOWN, isKnownToken, isSentenceUnlocked, interleave, lookupWord,
} from '../../site/js/queue.js';
import { newCardState, MINUTE, DAY } from '../../site/js/scheduler.js';

const NOW = new Date(2026, 8, 25, 12, 0).getTime();

const wid = (s) => 'w_' + [...s].map((c) => c.codePointAt(0).toString(16)).join('_');
const word = (s, hsk, t = s) => ({ id: wid(s), s, t, p: '', d: [], hsk, clips: [{ id: `c_${wid(s)}`, src: 'audio-cmn', file: `clips/words/c_${wid(s)}.mp3`, ms: 1000 }] });
const sent = (id, toks) => {
  const text = toks.join('');
  const tokens = []; let i = 0;
  for (const t of toks) { tokens.push([i, i + t.length]); i += t.length; }
  return { id, text, chars: [...text], cp: [...text].map(() => 'a1'), tokens, clip: { src: 'aishell3', file: `clips/sentences/${id}.mp3`, ms: 2000 } };
};

const WORDS = [word('学习', 1, '學習'), word('朋友', 1), word('图书馆', 3, '圖書館'), word('老师', 1, '老師'), word('喜欢', 1, '喜歡'), word('我', 1)];
const SENTS = [
  sent('s1', ['我', '是', '学生']), // 学生 unknown (not in vocab)
  sent('s2', ['我', '喜欢', '图书馆']),
  sent('s3', ['我', '的', '朋友']),
  sent('s4', ['我', '是', '我']), // stoplist only
];
const vocabOf = (...ss) => new Map(ss.map((s, i) => [s, { s, addedAt: i, source: 'import' }]));
const base = (over = {}) => ({
  mode: 'words', words: WORDS, sentences: SENTS, cards: new Map(), nowMs: NOW,
  settings: { newWords: 15, newSentences: 10, threshold: 0, sessionSize: 20, dayStart: 4 },
  ...over,
});
const reviewCard = (cardId, kind, ref, due, extra = {}) => [cardId, {
  cardId, kind, ref, state: { ...newCardState(NOW), status: 'review', interval: 3, due, lastReview: NOW - 3 * DAY }, ...extra,
}];

test('ALWAYS_KNOWN has ≤ 40 unique items, includes the spec list, and is a one-line literal', () => {
  assert.ok(ALWAYS_KNOWN.length <= 40);
  assert.equal(new Set(ALWAYS_KNOWN).size, ALWAYS_KNOWN.length);
  for (const c of '的了是在我你他她它们不吗呢吧啊和有这那也就都很会要说') assert.ok(ALWAYS_KNOWN.includes(c), c);
  const src = readFileSync(new URL('../../site/js/queue.js', import.meta.url), 'utf8');
  assert.match(src, /^export const ALWAYS_KNOWN = \[[^\n]+\];$/m);
});

test('known tokens: vocab, ALWAYS_KNOWN, single digit/Latin', () => {
  const v = new Set(['学习']);
  assert.equal(isKnownToken('学习', v), true);
  assert.equal(isKnownToken('的', v), true);
  assert.equal(isKnownToken('5', v), true);
  assert.equal(isKnownToken('A', v), true);
  assert.equal(isKnownToken('朋友', v), false);
});

test('word candidates: only vocab words present in words.json with a clip', () => {
  const q = buildQueue(base({ vocab: vocabOf('学习', '你好', '朋友') }));
  assert.deepEqual(q.map((c) => c.cardId), [`word:${wid('学习')}`, `word:${wid('朋友')}`]);
  assert.deepEqual(q[0], { cardId: `word:${wid('学习')}`, kind: 'word', ref: wid('学习') });
});

test('traditional vocab entries resolve via the traditional fallback', () => {
  assert.equal(lookupWord(WORDS, '學習').s, '学习');
  const q = buildQueue(base({ vocab: vocabOf('學習') }));
  assert.deepEqual(q.map((c) => c.ref), [wid('学习')]);
});

test('suspended clips and suspended cards are excluded', () => {
  const vocab = vocabOf('学习', '朋友');
  const q = buildQueue(base({ vocab, suspendedClips: new Set([`c_${wid('学习')}`]) }));
  assert.deepEqual(q.map((c) => c.ref), [wid('朋友')]);
  const cards = new Map([[`word:${wid('朋友')}`, { cardId: `word:${wid('朋友')}`, kind: 'word', ref: wid('朋友'), state: newCardState(NOW), suspended: true }]]);
  assert.deepEqual(buildQueue(base({ vocab, cards })).map((c) => c.ref), [wid('学习')]);
});

test('new words in HSK order, then insertion order', () => {
  const q = buildQueue(base({ vocab: vocabOf('图书馆', '朋友', '学习') }));
  assert.deepEqual(q.map((c) => c.ref), [wid('朋友'), wid('学习'), wid('图书馆')]);
});

test('threshold 0 vs 1', () => {
  const vocab = vocabOf('喜欢', '朋友');
  const t0 = buildQueue(base({ mode: 'sentences', vocab }));
  assert.deepEqual(t0.map((c) => c.ref), ['s3']); // s2 has 图书馆 unknown, s1 学生 unknown
  const t1 = buildQueue(base({ mode: 'sentences', vocab, settings: { ...base().settings, threshold: 1 } }));
  assert.deepEqual(new Set(t1.map((c) => c.ref)), new Set(['s2', 's3']));
  assert.equal(isSentenceUnlocked(SENTS[0], new Set(['我']), 1), false); // only stoplist-known
});

test('ALWAYS_KNOWN tokens count as known but do not unlock alone (imported-word requirement)', () => {
  // s4 = 我是我: all tokens known, but none is a real vocab word → locked even with 我 in vocab.
  const q = buildQueue(base({ mode: 'sentences', vocab: vocabOf('我') }));
  assert.deepEqual(q, []);
  const stats = queueStats(base({ vocab: vocabOf('我', '朋友') }));
  assert.equal(stats.sentencesUnlocked, 1); // s3 我的朋友
});

test('due cards come first, sorted by due, then new cards', () => {
  const vocab = vocabOf('学习', '朋友', '老师', '我');
  const cards = new Map([
    reviewCard(`word:${wid('老师')}`, 'word', wid('老师'), NOW + 5 * MINUTE),
    reviewCard(`word:${wid('我')}`, 'word', wid('我'), NOW - DAY),
    reviewCard(`word:${wid('学习')}`, 'word', wid('学习'), NOW + 3 * DAY), // not due today
  ]);
  const q = buildQueue(base({ vocab, cards }));
  assert.deepEqual(q.map((c) => c.ref), [wid('我'), wid('老师'), wid('朋友')]);
  const stats = queueStats(base({ vocab, cards }));
  assert.deepEqual(stats.words, { due: 2, new: 1 });
});

test('per-day new caps count cards introduced today; extra ignores the cap', () => {
  const vocab = vocabOf('学习', '朋友', '老师', '我');
  const settings = { ...base().settings, newWords: 2 };
  assert.equal(buildQueue(base({ vocab, settings })).length, 2);
  const introduced = new Map([[`word:${wid('我')}`, {
    cardId: `word:${wid('我')}`, kind: 'word', ref: wid('我'), introducedAt: NOW - MINUTE,
    state: { ...newCardState(NOW), status: 'learning', due: NOW + 3 * DAY },
  }]]);
  const q = buildQueue(base({ vocab, settings, cards: introduced }));
  assert.equal(q.length, 1);
  assert.equal(queueStats(base({ vocab, settings, cards: introduced })).words.new, 1);
  assert.equal(buildQueue(base({ vocab, settings, cards: introduced, extra: true })).length, 3);
  assert.equal(buildQueue(base({ vocab, newToday: { word: 2 }, settings })).length, 0);
});

test('session size caps the queue; exclude drops cards', () => {
  const vocab = vocabOf('学习', '朋友', '老师', '我');
  assert.equal(buildQueue(base({ vocab, settings: { ...base().settings, sessionSize: 2 } })).length, 2);
  const q = buildQueue(base({ vocab, exclude: new Set([`word:${wid('学习')}`]) }));
  assert.ok(!q.some((c) => c.ref === wid('学习')));
});

test('mixed interleaves words and sentences 1:1 while keeping due before new', () => {
  const vocab = vocabOf('学习', '朋友', '喜欢', '图书馆', '老师');
  const cards = new Map([reviewCard('sentence:s3', 'sentence', 's3', NOW - MINUTE)]);
  const q = buildQueue(base({ mode: 'mixed', vocab, cards }));
  assert.deepEqual(q[0], { cardId: 'sentence:s3', kind: 'sentence', ref: 's3' }); // the only due card
  const kinds = q.slice(1).map((c) => c.kind);
  assert.deepEqual(kinds.slice(0, 2), ['word', 'sentence']);
  assert.deepEqual(interleave([1, 2, 3], ['a']), [1, 'a', 2, 3]);
});

test('new sentences prefer least recently reviewed vocab words', () => {
  const vocab = vocabOf('喜欢', '图书馆', '朋友');
  const cards = new Map([
    // 喜欢/图书馆 reviewed just now; 朋友 never reviewed → s3 (我的朋友) first.
    reviewCard(`word:${wid('喜欢')}`, 'word', wid('喜欢'), NOW + 3 * DAY, {}),
    reviewCard(`word:${wid('图书馆')}`, 'word', wid('图书馆'), NOW + 3 * DAY, {}),
  ]);
  for (const c of cards.values()) c.state.lastReview = NOW;
  const q = buildQueue(base({ mode: 'sentences', vocab, cards }));
  assert.deepEqual(q.map((c) => c.ref), ['s3', 's2']);
});
