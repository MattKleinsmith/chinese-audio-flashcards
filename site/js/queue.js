// queue.js — builds a study session queue from vocab + data + SRS state (pure; no DOM).
// Spec: docs/PLAN.md §5.6 (and the "known token" rule of §4.3).
// Unit-tested in tests/unit/queue.test.mjs.
//
// buildQueue(input) → [{ cardId, kind, ref }]
// queueStats(input) → { words: {due,new}, sentences: {due,new}, mixed: {due,new},
//                       wordsWithAudio, sentencesUnlocked }
//
// input = {
//   mode: 'words' | 'sentences' | 'mixed',
//   vocab: Map<s, entry> | Array<entry> | Set<string>   (iteration order = insertion order)
//   words: Array<word>          words.json
//   sentences: Array<sentence>  sentences.json
//   cards: Map<cardId, { cardId, kind, ref, state, suspended?, introducedAt? }>
//   settings: { newWords, newSentences, threshold, sessionSize, dayStart }
//   suspendedClips: Set<clipKey>   (clip.id, or clip.file for sentence clips)
//   nowMs, extra (ignore daily new caps, for "Study more"), exclude: Set<cardId>
// }

import { endOfToday, startOfDay, DAY } from './scheduler.js';

/**
 * Tokens that always count as "known" when deciding whether a sentence is comprehensible:
 * high-frequency function words / pronouns. Keep ≤ 40 items. The pipeline duplicates this list
 * (pipeline/select_sentences.py) — keep this a single-line array literal of quoted strings so
 * a test can read both files and compare them.
 */
export const ALWAYS_KNOWN = ['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '不', '吗', '呢', '吧', '啊', '和', '有', '这', '那', '也', '就', '都', '很', '会', '要', '说', '个', '一', '着', '过', '地', '得', '我们', '你们', '他们', '她们', '这个', '那个'];

const ALWAYS_KNOWN_SET = new Set(ALWAYS_KNOWN);
const UNKNOWN_HISTORY_DAYS = 3650; // a vocab word never reviewed scores like "10 years ago"

export const DEFAULT_QUEUE_SETTINGS = {
  newWords: 15, newSentences: 10, threshold: 0, sessionSize: 20, dayStart: 4,
};

/** Key used to suspend a clip ("Report bad audio"). */
export function clipKey(clip) {
  return clip ? clip.id || clip.file : '';
}

// Per-array index cache so repeated calls on the same data do not rebuild maps.
const wordIndexCache = new WeakMap();
function wordIndex(words) {
  let idx = wordIndexCache.get(words);
  if (!idx) {
    const byS = new Map(); const byT = new Map();
    for (const w of words) {
      if (!w || !w.s) continue;
      if (!byS.has(w.s)) byS.set(w.s, w);
      if (w.t && !byT.has(w.t)) byT.set(w.t, w);
    }
    idx = { byS, byT };
    wordIndexCache.set(words, idx);
  }
  return idx;
}

/** Find the words.json entry for a vocab word (simplified first, traditional fallback). */
export function lookupWord(words, s, t) {
  const { byS, byT } = wordIndex(words);
  return byS.get(s) || (t && byS.get(t)) || byT.get(s) || (t && byT.get(t)) || undefined;
}

/** Normalise the vocab input into an ordered array of entries and a Set of strings. */
function normaliseVocab(vocab) {
  let list;
  if (vocab instanceof Map) list = [...vocab.values()];
  else if (vocab instanceof Set) list = [...vocab].map((s) => ({ s }));
  else list = (vocab || []).map((v) => (typeof v === 'string' ? { s: v } : v));
  const set = new Set(list.map((v) => v.s));
  return { list, set };
}

/** A token is known iff in vocab, in ALWAYS_KNOWN, or a single digit / Latin char. */
export function isKnownToken(tok, vocabSet) {
  return vocabSet.has(tok) || ALWAYS_KNOWN_SET.has(tok) || /^[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]$/.test(tok);
}

/** Token strings of a sentence, from its [start,end) spans. */
export function sentenceTokens(sentence) {
  const chars = sentence.chars || [...(sentence.text || '')];
  return (sentence.tokens || []).map(([a, b]) => chars.slice(a, b).join(''));
}

/** Number of unknown tokens and whether ≥ 1 token is a real vocab word (not a stoplist word). */
export function sentenceKnowledge(sentence, vocabSet) {
  let unknown = 0; let hasVocab = false;
  for (const tok of sentenceTokens(sentence)) {
    if (!isKnownToken(tok, vocabSet)) unknown++;
    else if (vocabSet.has(tok) && !ALWAYS_KNOWN_SET.has(tok)) hasVocab = true;
  }
  return { unknown, hasVocab };
}

/** Sentence is unlocked at the given unknown-token threshold. */
export function isSentenceUnlocked(sentence, vocabSet, threshold = 0) {
  const { unknown, hasVocab } = sentenceKnowledge(sentence, vocabSet);
  return hasVocab && unknown <= threshold;
}

/** Interleave two lists roughly 1:1 (a first), appending the remainder of the longer one. */
export function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/** Shared analysis used by buildQueue and queueStats. */
function analyse(input) {
  const settings = { ...DEFAULT_QUEUE_SETTINGS, ...(input.settings || {}) };
  const now = input.nowMs ?? Date.now();
  const words = input.words || [];
  const sentences = input.sentences || [];
  const cards = input.cards || new Map();
  const suspendedClips = input.suspendedClips || new Set();
  const exclude = input.exclude || new Set();
  const { list: vocabList, set: vocabSet } = normaliseVocab(input.vocab);
  const eod = endOfToday(now, settings.dayStart);
  const sod = startOfDay(now, settings.dayStart);

  const usable = (card) => !card || !card.suspended;
  const isNew = (card) => !card || !card.state || card.state.status === 'new';
  const dueOf = (card) => card.state.due;

  // 1. Candidate word cards: vocab words present in words.json with ≥ 1 non-suspended clip.
  const wordCands = [];
  const seenWords = new Set();
  vocabList.forEach((v, order) => {
    const w = lookupWord(words, v.s, v.t);
    if (!w || seenWords.has(w.id)) return;
    if (!(w.clips || []).some((c) => !suspendedClips.has(clipKey(c)))) return;
    seenWords.add(w.id);
    wordCands.push({ cardId: `word:${w.id}`, kind: 'word', ref: w.id, word: w, order, addedAt: v.addedAt || 0 });
  });

  // 2. Candidate sentence cards: unknown tokens ≤ threshold and ≥ 1 real vocab token.
  const sentCands = [];
  for (const s of sentences) {
    if (!s || !s.id || !s.clip || suspendedClips.has(clipKey(s.clip))) continue;
    if (!isSentenceUnlocked(s, vocabSet, settings.threshold)) continue;
    sentCands.push({ cardId: `sentence:${s.id}`, kind: 'sentence', ref: s.id, sentence: s });
  }

  // Introduced-today counts (per-day caps on new cards).
  const newToday = { word: 0, sentence: 0, ...(input.newToday || {}) };
  if (!input.newToday) {
    for (const c of cards.values()) if (c.introducedAt && c.introducedAt >= sod) newToday[c.kind] = (newToday[c.kind] || 0) + 1;
  }

  const split = (cands) => {
    const due = []; const fresh = [];
    for (const c of cands) {
      if (exclude.has(c.cardId)) continue;
      const card = cards.get(c.cardId);
      if (!usable(card)) continue;
      if (isNew(card)) fresh.push(c);
      else if (dueOf(card) <= eod) due.push({ ...c, due: dueOf(card) });
    }
    due.sort((a, b) => a.due - b.due);
    return { due, fresh };
  };

  const W = split(wordCands);
  const S = split(sentCands);

  // 3a. New word cards: HSK order (0 = not in HSK → last), then insertion order.
  W.fresh.sort((a, b) => ((a.word.hsk || 99) - (b.word.hsk || 99)) || (a.addedAt - b.addedAt) || (a.order - b.order));

  // 3b. New sentence cards: cover the least-recently-reviewed vocab words first.
  const lastReviewOf = (tok) => {
    const w = lookupWord(words, tok);
    const card = w && cards.get(`word:${w.id}`);
    return card && card.state && card.state.lastReview;
  };
  for (const c of S.fresh) {
    let score = 0;
    for (const tok of sentenceTokens(c.sentence)) {
      if (!vocabSet.has(tok) || ALWAYS_KNOWN_SET.has(tok)) continue;
      const last = lastReviewOf(tok);
      score += last ? Math.max(0, (now - last) / DAY) : UNKNOWN_HISTORY_DAYS;
    }
    c.score = score;
  }
  S.fresh.sort((a, b) => (b.score - a.score) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));

  const size = Math.max(1, settings.sessionSize | 0);
  const capW = input.extra ? size : Math.max(0, settings.newWords - newToday.word);
  const capS = input.extra ? size : Math.max(0, settings.newSentences - newToday.sentence);

  return { settings, W, S, capW, capS, size, wordCands, sentCands };
}

const strip = (c) => ({ cardId: c.cardId, kind: c.kind, ref: c.ref });

/** Build the ordered queue for one session (see module header for input). */
export function buildQueue(input) {
  const { W, S, capW, capS, size } = analyse(input);
  const newW = W.fresh.slice(0, capW);
  const newS = S.fresh.slice(0, capS);
  let q;
  switch (input.mode) {
    case 'sentences': q = [...S.due, ...newS]; break;
    case 'mixed': q = [...interleave(W.due, S.due), ...interleave(newW, newS)]; break;
    case 'words':
    default: q = [...W.due, ...newW]; break;
  }
  return q.slice(0, size).map(strip);
}

/** Counts for the home screen tiles and stats. */
export function queueStats(input) {
  const { W, S, capW, capS, wordCands, sentCands } = analyse(input);
  const words = { due: W.due.length, new: Math.min(capW, W.fresh.length) };
  const sentences = { due: S.due.length, new: Math.min(capS, S.fresh.length) };
  return {
    words,
    sentences,
    mixed: { due: words.due + sentences.due, new: words.new + sentences.new },
    wordsWithAudio: wordCands.length,
    sentencesUnlocked: sentCands.length,
  };
}
