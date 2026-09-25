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
  constructor(manifest, words, sentences, dataDir = DATA_DIR) {
    this.manifest = manifest;
    this.dataDir = dataDir;
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

  /** words.json entry for a word (simplified, with traditional fallback). */
  lookup(s, t) { return lookupWord(this.words, s, t); }

  /** Absolute-or-relative URL of a clip file. */
  clipUrl(file) { return this.clipBase + String(file).replace(/^\.?\//, ''); }

  /** Words of one HSK level. */
  wordsAtLevel(level) { return this.words.filter((w) => w.hsk === level); }
}

/** Load the bundle from dataDir. words/sentences failures degrade to empty lists. */
export async function loadData(dataDir = DATA_DIR) {
  const manifest = await fetchJSON(dataDir + 'manifest.json');
  const files = manifest.files || {};
  const [words, sentences] = await Promise.all([
    fetchJSON(dataDir + (files.words || 'words.json')).catch((e) => { console.warn(e); return []; }),
    fetchJSON(dataDir + (files.sentences || 'sentences.json')).catch((e) => { console.warn(e); return []; }),
  ]);
  return new DataBundle(manifest, words, sentences, dataDir);
}
