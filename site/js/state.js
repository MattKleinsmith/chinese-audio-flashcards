// state.js — the app's in-memory model, mirrored write-through to IndexedDB (db.js).
// Holds vocab, card rows, settings and suspended clips; screens read from here and call the
// async mutators, which update memory first and then persist (errors are logged, never
// thrown, so a flaky IndexedDB cannot break a study session).

import { loadSettings, getMeta, setMeta, DEFAULT_SETTINGS, STORES } from './db.js';
import { buildQueue, queueStats } from './queue.js';
import { newCardState } from './scheduler.js';

export const BACKUP_FORMAT = 'clf-backup';

async function safe(promise, what) {
  try { return await promise; } catch (err) { console.warn(`${what} failed`, err); return undefined; }
}

export class AppState {
  constructor(db, data) {
    this.db = db;
    this.data = data;
    this.vocab = new Map();
    this.cards = new Map();
    this.settings = { ...DEFAULT_SETTINGS };
    this.suspendedClips = new Set();
  }

  /** Load everything from the DB into memory. */
  async load() {
    const vocab = (await safe(this.db.getAll('vocab'), 'load vocab')) || [];
    vocab.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    this.vocab = new Map(vocab.map((v) => [v.s, v]));
    const cards = (await safe(this.db.getAll('cards'), 'load cards')) || [];
    this.cards = new Map(cards.map((c) => [c.cardId, c]));
    this.settings = await loadSettings(this.db);
    this.suspendedClips = new Set((await getMeta(this.db, 'suspendedClips')) || []);
    return this;
  }

  // ---- derived -------------------------------------------------------------------------------

  queueInput(mode, extra = {}) {
    return {
      mode,
      vocab: this.vocab,
      words: this.data.words,
      sentences: this.data.sentences,
      cards: this.cards,
      settings: this.settings,
      suspendedClips: this.suspendedClips,
      nowMs: Date.now(),
      ...extra,
    };
  }

  buildQueue(mode, extra) { return buildQueue(this.queueInput(mode, extra)); }
  stats() { return queueStats(this.queueInput('mixed')); }

  /** words.json entry for a vocab word, if any. */
  wordFor(s) { const v = this.vocab.get(s); return this.data.lookup(s, v && v.t); }

  /** SRS status label for a vocab word: none | new | learning | review | suspended. */
  wordStatus(s) {
    const w = this.wordFor(s);
    if (!w || !(w.clips || []).length) return 'none'; // dictionary-only words have no cards
    const card = this.cards.get(`word:${w.id}`);
    if (card && card.suspended) return 'suspended';
    if (!(w.clips || []).some((c) => !this.suspendedClips.has(c.id || c.file))) return 'suspended';
    return card ? card.state.status : 'new';
  }

  // ---- vocab ---------------------------------------------------------------------------------

  /**
   * Add entries (union, idempotent: existing words are left untouched).
   * @returns {{ added, withAudio, unlocked }} unlocked = newly unlocked sentences
   */
  async addVocab(entries, source, listName) {
    const before = this.stats().sentencesUnlocked;
    const now = Date.now();
    const rows = [];
    let i = 0;
    for (const e of entries) {
      if (!e || !e.s || this.vocab.has(e.s)) continue;
      const row = { s: e.s, addedAt: now + i++, source };
      if (e.t) row.t = e.t;
      if (e.p) row.p = e.p;
      if (e.d) row.d = e.d;
      if (listName) row.listName = listName;
      rows.push(row);
      this.vocab.set(row.s, row);
    }
    if (rows.length) await safe(this.db.putMany('vocab', rows), 'save vocab');
    const withAudio = rows.filter((r) => this.data.hasAudio(r.s, r.t)).length;
    const unlocked = Math.max(0, this.stats().sentencesUnlocked - before);
    return { added: rows.length, withAudio, unlocked };
  }

  async removeVocab(keys) {
    const list = [...keys];
    for (const k of list) this.vocab.delete(k);
    await safe(this.db.deleteMany('vocab', list), 'delete vocab');
    return list.length;
  }

  async removeVocabBySource(source) {
    return this.removeVocab([...this.vocab.values()].filter((v) => v.source === source).map((v) => v.s));
  }

  // ---- cards & reviews -----------------------------------------------------------------------

  /** Card rows are created lazily, the first time a card is shown. */
  async ensureCard(item) {
    let card = this.cards.get(item.cardId);
    if (!card) {
      card = { cardId: item.cardId, kind: item.kind, ref: item.ref, state: newCardState(Date.now()), createdAt: Date.now() };
      this.cards.set(card.cardId, card);
      await safe(this.db.put('cards', card), 'create card');
    }
    return card;
  }

  async saveCard(card) {
    this.cards.set(card.cardId, card);
    await safe(this.db.put('cards', card), 'save card');
  }

  async logReview(entry) { await safe(this.db.add('reviews', { ...entry }), 'log review'); }

  async suspendClip(key) {
    this.suspendedClips.add(key);
    await setMeta(this.db, 'suspendedClips', [...this.suspendedClips]);
  }

  // ---- settings ------------------------------------------------------------------------------

  async setSetting(key, value) {
    this.settings[key] = value;
    await safe(this.db.put('settings', { key, value }), 'save setting');
  }

  // ---- backup / reset ------------------------------------------------------------------------

  async exportAll() {
    const dump = { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString() };
    for (const store of Object.keys(STORES)) dump[store] = (await safe(this.db.getAll(store), `export ${store}`)) || [];
    return dump;
  }

  /** Replace all state with a backup (validated first). Throws on an invalid file. */
  async restoreAll(dump) {
    if (!dump || typeof dump !== 'object' || !Array.isArray(dump.vocab)) throw new Error('Not a Listening Cards backup (no vocab array).');
    const clean = {};
    for (const store of Object.keys(STORES)) {
      const { keyPath } = STORES[store];
      clean[store] = (Array.isArray(dump[store]) ? dump[store] : [])
        .filter((r) => r && typeof r === 'object' && (store === 'reviews' || r[keyPath] !== undefined));
    }
    await this.db.replaceAll(clean);
    await this.load();
  }

  async resetSRS() {
    await safe(this.db.clear('cards'), 'clear cards');
    await safe(this.db.clear('reviews'), 'clear reviews');
    this.cards.clear();
  }

  async deleteAll() {
    for (const store of Object.keys(STORES)) await safe(this.db.clear(store), `clear ${store}`);
    await this.load();
  }

  /** Counts for tests / debugging (window.__clf.debug()). */
  async debug() {
    const count = async (s) => (await safe(this.db.count(s), `count ${s}`)) ?? -1;
    return {
      dbMode: this.db.mode,
      vocab: await count('vocab'),
      cards: await count('cards'),
      reviews: await count('reviews'),
      memory: { vocab: this.vocab.size, cards: this.cards.size },
      words: this.data.words.length,
      sentences: this.data.sentences.length,
      stats: this.stats(),
      settings: { ...this.settings },
    };
  }
}

export async function createAppState(db, data) {
  return new AppState(db, data).load();
}
