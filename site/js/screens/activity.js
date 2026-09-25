// activity.js — "Local data" screen: what is stored in this browser, whether it is intact, and
// what happened recently. Reached from Settings. Read-only; meant for peace of mind and
// debugging ("is my progress still here after reinstalling / switching browsers?").
//
// Sections:
//   1. Storage      — where the app runs (home-screen app or browser tab), IndexedDB mode,
//                     persisted-storage grant, bytes used / quota, cached audio clips
//   2. What's inside — vocab by source, cards by status, review log size, first/last review,
//                     Hack Chinese sync record, app build, data bundle date
//   3. Activity      — reviews per day for the last 14 days, and the last 40 reviews in full

import { h, clear, plural } from '../util.js';
import { getMeta } from '../db.js';
import { CLIP_CACHE } from '../audio.js';

const fmtBytes = (n) => (n == null ? '?' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
const dayKey = (ts, dayStart) => { const d = new Date(ts - dayStart * 3600e3); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Pure: summarise the review log. Unit-tested. */
export function summariseReviews(reviews, { dayStart = 4, days = 14, now = Date.now() } = {}) {
  const graded = reviews.filter((r) => r && r.ts && ['again', 'hard', 'good', 'easy'].includes(r.grade));
  const byDay = new Map();
  for (let i = 0; i < days; i++) byDay.set(dayKey(now - i * 86400e3, dayStart), { reviews: 0, again: 0, cards: new Set() });
  for (const r of graded) {
    const k = dayKey(r.ts, dayStart);
    const d = byDay.get(k);
    if (!d) continue;
    d.reviews++; if (r.grade === 'again') d.again++; d.cards.add(r.cardId);
  }
  const daysOut = [...byDay.entries()].map(([day, d]) => ({ day, reviews: d.reviews, again: d.again, cards: d.cards.size }));
  const ts = graded.map((r) => r.ts);
  return {
    total: graded.length,
    first: ts.length ? Math.min(...ts) : null,
    last: ts.length ? Math.max(...ts) : null,
    today: daysOut[0],
    days: daysOut,
    recent: [...graded].sort((a, b) => b.ts - a.ts).slice(0, 40),
  };
}

function row(label, value, testid) {
  return h('div', { class: 'kv', 'data-testid': testid }, h('span', { class: 'muted' }, label), h('strong', {}, value));
}

export function render(root, app) {
  const { state, data, db } = app;
  const screen = h('div', { class: 'screen activity', 'data-testid': 'activity' }, h('h1', {}, 'Local data'));
  root.append(screen);
  const storage = h('section', { class: 'card' }, h('h2', {}, 'Storage'), h('p', { class: 'muted small' }, 'Loading…'));
  const inside = h('section', { class: 'card' }, h('h2', {}, 'What is stored here'));
  const activity = h('section', { class: 'card' }, h('h2', {}, 'Activity'));
  screen.append(storage, inside, activity);

  // ---- 1. Storage --------------------------------------------------------------------------
  (async () => {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let estimate = null; let persisted = null; let clipCount = null; let clipBytes = null;
    try { estimate = await navigator.storage?.estimate?.(); } catch { /* ignore */ }
    try { persisted = await navigator.storage?.persisted?.(); } catch { /* ignore */ }
    try {
      if (typeof caches !== 'undefined') {
        const cache = await caches.open(CLIP_CACHE);
        const keys = await cache.keys();
        clipCount = keys.length;
        // Size a sample to keep this cheap; extrapolate for the rest.
        let sampled = 0; let bytes = 0;
        for (const k of keys.slice(0, 25)) { const r = await cache.match(k); if (r) { bytes += (await r.arrayBuffer()).byteLength; sampled++; } }
        clipBytes = sampled ? Math.round((bytes / sampled) * keys.length) : 0;
      }
    } catch { /* ignore */ }
    clear(storage);
    storage.append(h('h2', {}, 'Storage'),
      row('Running as', standalone ? 'Home-screen app' : 'Browser tab', 'ls-mode'),
      row('Database', db.mode === 'memory' ? 'In-memory only (nothing is saved!)' : 'IndexedDB (saved on this device)', 'ls-db'),
      row('Persistent storage', persisted === null ? 'unknown' : persisted ? 'granted' : 'not granted (browser may evict under pressure)', 'ls-persist'),
      row('Site data used', estimate ? `${fmtBytes(estimate.usage)} of ${fmtBytes(estimate.quota)}` : 'unknown', 'ls-usage'),
      row('Cached audio clips', clipCount === null ? 'unknown' : `${clipCount} (≈ ${fmtBytes(clipBytes)})`, 'ls-clips'),
      row('Browser', navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 80), 'ls-ua'),
      h('p', { class: 'muted small' }, 'On a fresh phone this page shows 0 words and no reviews. If your counts are here after reinstalling or reopening, your progress survived.'));
  })();

  // ---- 2. What's inside -------------------------------------------------------------------
  (async () => {
    const vocab = [...state.vocab.values()];
    const bySource = {};
    for (const v of vocab) bySource[v.source || 'unknown'] = (bySource[v.source || 'unknown'] || 0) + 1;
    const cards = [...state.cards.values()];
    const byStatus = { new: 0, learning: 0, review: 0 };
    for (const c of cards) byStatus[c.state?.status || 'new'] = (byStatus[c.state?.status || 'new'] || 0) + 1;
    const reviews = (await db.getAll('reviews').catch(() => [])) || [];
    const sum = summariseReviews(reviews, { dayStart: state.settings.dayStart });
    const hc = await getMeta(db, 'hcSync').catch(() => null);
    const dbCounts = { vocab: await db.count('vocab').catch(() => -1), cards: await db.count('cards').catch(() => -1), reviews: await db.count('reviews').catch(() => -1) };
    const srcLabel = { import: 'imported files', hackchinese: 'Hack Chinese sync', hsk: 'HSK quick start' };
    inside.append(
      row('Vocab words', `${vocab.length}` + (Object.keys(bySource).length ? ` (${Object.entries(bySource).map(([k, n]) => `${n} ${srcLabel[k] || k}`).join(', ')})` : ''), 'ls-vocab'),
      row('Cards seen', `${cards.length} (${byStatus.new} new · ${byStatus.learning} learning · ${byStatus.review} review)`, 'ls-cards'),
      row('Reviews logged', `${sum.total}`, 'ls-reviews'),
      row('First review', fmtTime(sum.first), 'ls-first'),
      row('Last review', fmtTime(sum.last), 'ls-last'),
      row('Rows in database', `vocab ${dbCounts.vocab} · cards ${dbCounts.cards} · reviews ${dbCounts.reviews}`, 'ls-rows'),
      row('Hack Chinese sync', hc && hc.syncedAt ? `${hc.total || 0} words · export ${fmtTime(Date.parse(hc.syncedAt))} · checked ${fmtTime(hc.checkedAt)}` : 'none yet', 'ls-hc'),
      row('Audio bundle', `${data.words.length} words · ${data.sentences.length} sentences · built ${data.manifest.builtAt || '?'}`, 'ls-bundle'),
      row('App build', app.buildSha || 'dev', 'ls-build'),
      row('Site version', (() => { const v = app.siteVersion?.(); return v ? (v.modified ? new Date(v.modified).toLocaleString() : v.etag) : 'unknown'; })(), 'ls-site'));

    // ---- 3. Activity ----------------------------------------------------------------------
    activity.append(row('Today', `${sum.today.reviews} reviews · ${sum.today.cards} cards · ${sum.today.again} again`, 'ls-today'));
    const table = h('table', { class: 'plain', 'data-testid': 'ls-days' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Day'), h('th', {}, 'Reviews'), h('th', {}, 'Cards'), h('th', {}, 'Again'))),
      h('tbody', {}, sum.days.map((d) => h('tr', { class: d.reviews ? '' : 'muted' }, h('td', {}, d.day), h('td', {}, String(d.reviews)), h('td', {}, String(d.cards)), h('td', {}, String(d.again))))));
    activity.append(h('h3', {}, 'Last 14 days'), table);
    const label = (cardId) => {
      const [kind, id] = cardId.split(/:(.*)/);
      if (kind === 'word') return data.wordsById.get(id)?.s || id;
      if (kind === 'sentence') return data.sentencesById.get(id)?.text || id;
      return cardId;
    };
    activity.append(h('h3', {}, `Recent reviews (${Math.min(40, sum.recent.length)})`),
      sum.recent.length
        ? h('ul', { class: 'log', 'data-testid': 'ls-log' }, sum.recent.map((r) => h('li', {},
          h('span', { class: 'muted small' }, fmtTime(r.ts)), ' ',
          h('span', { class: `grade-${r.grade}` }, r.grade), ' ',
          h('span', { lang: 'zh-Hans' }, label(r.cardId)),
          r.elapsedMs ? h('span', { class: 'muted small' }, ` · ${(r.elapsedMs / 1000).toFixed(0)}s`) : null)))
        : h('p', { class: 'muted' }, 'No reviews yet.'));
  })();
}
