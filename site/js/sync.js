// sync.js — automatic vocab sync from a file in the site bundle (Hack Chinese → phone).
//
// A GitHub Action signs in to Hack Chinese every day, downloads the "all studied words" CSV and
// commits it as data/user/hackchinese.csv plus data/user/sync.json. On every open (and when the
// app comes back to the foreground, throttled), this module fetches sync.json, and if it has
// changed since the last import, fetches the CSV, parses it with the same format-agnostic
// importer as manual imports, and adds any words that are not in the vocab yet. Words are only
// ever added, unless the "mirror deletions" setting is on, in which case words that came from
// Hack Chinese and are no longer in the export are removed.
//
// Pure helpers (diffVocab) are unit-tested in tests/unit/sync.test.mjs.

import { parseVocabText } from './importer.js';
import { getMeta, setMeta } from './db.js';

export const SOURCE = 'hackchinese';
export const LIST_NAME = 'Hack Chinese';
const THROTTLE_MS = 10 * 60 * 1000;

/**
 * Given parsed entries from the export and the current vocab map, return what to add and (if
 * mirroring deletions) what to remove. Only rows whose source is `hackchinese` are ever removed.
 */
export function diffVocab(entries, vocab, { mirrorDeletions = false } = {}) {
  const inExport = new Set();
  const add = [];
  for (const e of entries) {
    if (!e || !e.s) continue;
    inExport.add(e.s);
    if (!vocab.has(e.s)) add.push(e);
  }
  const remove = [];
  if (mirrorDeletions) {
    for (const row of vocab.values()) if (row.source === SOURCE && !inExport.has(row.s)) remove.push(row.s);
  }
  return { add, remove, total: inExport.size };
}

async function fetchNoStore(url) {
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Run one sync. Resolves to { status: 'none' | 'unchanged' | 'synced' | 'error', added, removed,
 * total, syncedAt, message }. Never throws.
 */
export async function syncFromBundle(app, { force = false, dataDir = './data/' } = {}) {
  const { state, db } = app;
  const last = (await getMeta(db, 'hcSync')) || null;
  const now = Date.now();
  if (!force && last && last.checkedAt && now - last.checkedAt < THROTTLE_MS) return { status: 'throttled', ...last };
  try {
    const metaRes = await fetchNoStore(`${dataDir}user/sync.json`);
    if (!metaRes) { await setMeta(db, 'hcSync', { ...(last || {}), checkedAt: now, status: 'none' }); return { status: 'none' }; }
    const meta = await metaRes.json();
    if (!force && last && last.sha256 && last.sha256 === meta.sha256) {
      const rec = { ...last, checkedAt: now, status: 'unchanged' };
      await setMeta(db, 'hcSync', rec);
      return rec;
    }
    const csvRes = await fetchNoStore(`${dataDir}user/hackchinese.csv`);
    if (!csvRes) return { status: 'none' };
    const text = await csvRes.text();
    const parsed = parseVocabText(text);
    if (!parsed.entries.length) throw new Error('the export contained no words');
    const { add, remove, total } = diffVocab(parsed.entries, state.vocab, { mirrorDeletions: !!state.settings.mirrorHcDeletions });
    if (add.length) await state.addVocab(add, SOURCE, LIST_NAME);
    if (remove.length) await state.removeVocab(remove);
    const rec = {
      status: 'synced', checkedAt: now, importedAt: now, syncedAt: meta.syncedAt || null, sha256: meta.sha256 || null,
      total, added: add.length, removed: remove.length,
    };
    await setMeta(db, 'hcSync', rec);
    return rec;
  } catch (err) {
    console.warn('Hack Chinese sync failed', err);
    const rec = { ...(last || {}), checkedAt: now, status: 'error', message: String(err.message || err) };
    await setMeta(db, 'hcSync', rec);
    return rec;
  }
}

/** Last sync record for status displays (or null). */
export function lastSync(app) { return getMeta(app.db, 'hcSync'); }

/** Human label like "synced 3 h ago · 1,234 words" for the home and settings screens. */
export function describeSync(rec) {
  if (!rec || rec.status === 'none' || !rec.syncedAt) return '';
  const when = rec.importedAt || rec.checkedAt;
  return `Hack Chinese: ${Number(rec.total || 0).toLocaleString()} words · export ${relTime(Date.parse(rec.syncedAt))}${when ? ` · checked ${relTime(when)}` : ''}`;
}

export function relTime(ts) {
  if (!ts || Number.isNaN(ts)) return 'never';
  const d = Date.now() - ts;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hh = Math.round(m / 60);
  if (hh < 48) return `${hh} h ago`;
  return `${Math.round(hh / 24)} d ago`;
}
