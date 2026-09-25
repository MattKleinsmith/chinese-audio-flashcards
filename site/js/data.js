// data.js — loads the audio bundle (manifest.json, words.json, sentences.json; PLAN §4) and
// builds in-memory indexes. Clip URLs are (manifest.baseUrl || <data dir>) + clip.file, where
// clip.file is relative to the data dir (e.g. "clips/words/c_acmn_5b66_4e60.mp3").

import { lookupWord } from './queue.js';

export const DATA_DIR = './data/';

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

const validWord = (w) => w && typeof w.id === 'string' && typeof w.s === 'string' && Array.isArray(w.clips);
const validSentence = (s) => s && typeof s.id === 'string' && Array.isArray(s.chars) && Array.isArray(s.tokens) && s.clip && s.clip.file;

/** The loaded bundle plus lookup helpers. */
export class DataBundle {
  constructor(manifest, words, sentences, dataDir = DATA_DIR, dict = null) {
    this.manifest = manifest;
    this.dataDir = dataDir;
    // dict.json: CC-CEDICT readings for words WITHOUT audio (sentence tokens, characters, HSK
    // words lacking a clip, synced Hack Chinese words). { simplified: { t?, p, d? } }.
    this.dict = dict && typeof dict === 'object' ? dict : {};
    this.skipped = 0;
    this.words = [];
    for (const w of words || []) { if (validWord(w)) this.words.push(w); else this.skipped++; }
    this.sentences = [];
    for (const s of sentences || []) { if (validSentence(s)) this.sentences.push(s); else this.skipped++; }
    this.wordsById = new Map(this.words.map((w) => [w.id, w]));
    this.sentencesById = new Map(this.sentences.map((s) => [s.id, s]));
    this.hskCounts = {};
    for (const w of this.words) if (w.hsk) this.hskCounts[w.hsk] = (this.hskCounts[w.hsk] || 0) + 1;
    const base = manifest && manifest.baseUrl ? manifest.baseUrl : dataDir;
    this.clipBase = base.endsWith('/') ? base : base + '/';
  }

  /**
   * Best available entry for a word: words.json (has audio) → dict.json (no audio) → composed
   * from single characters (pinyin joined, per-character glosses). Returns undefined only when
   * not even the characters are known. Shape: { s, t, p, d, hsk, clips, source: 'words'|'dict'|'chars', charGlosses? }.
   */
  lookup(s, t) {
    const w = lookupWord(this.words, s, t);
    if (w) return w;
    const e = this.dict[s] || (t && this.dict[t]);
    if (e) return { s, t: e.t || s, p: e.p || '', d: e.d || [], hsk: 0, clips: [], source: 'dict' };
    const chars = [...(s || '')];
    if (chars.length < 2) return undefined;
    const parts = chars.map((c) => lookupWord(this.words, c) || this.dict[c]);
    if (parts.some((x) => !x)) return undefined;
    return {
      s, t: chars.map((c, i) => (parts[i].t && parts[i].t !== c ? parts[i].t : c)).join(''),
      p: parts.map((x) => x.p || '').join(' ').trim(), d: [], hsk: 0, clips: [], source: 'chars',
      charGlosses: chars.map((c, i) => ({ c, p: parts[i].p || '', d: (parts[i].d || []).slice(0, 2) })),
    };
  }

  /** True when the word has at least one audio clip. */
  hasAudio(s, t) { const w = lookupWord(this.words, s, t); return !!(w && w.clips && w.clips.length); }

  /** Absolute-or-relative URL of a clip file. */
  clipUrl(file) { return this.clipBase + String(file).replace(/^\.?\//, ''); }

  /** Words of one HSK level. */
  wordsAtLevel(level) { return this.words.filter((w) => w.hsk === level); }
}

/** Load the bundle from dataDir. words/sentences failures degrade to empty lists. */
export async function loadData(dataDir = DATA_DIR) {
  const manifest = await fetchJSON(dataDir + 'manifest.json');
  const files = manifest.files || {};
  const [words, sentences, dict] = await Promise.all([
    fetchJSON(dataDir + (files.words || 'words.json')).catch((e) => { console.warn(e); return []; }),
    fetchJSON(dataDir + (files.sentences || 'sentences.json')).catch((e) => { console.warn(e); return []; }),
    files.dict ? fetchJSON(dataDir + files.dict).catch((e) => { console.warn(e); return null; }) : Promise.resolve(null),
  ]);
  return new DataBundle(manifest, words, sentences, dataDir, dict);
}
