// screens/vocab.js — searchable vocabulary list (hanzi / pinyin / definition) with has-audio
// flag, SRS status chip, delete (✕ button or long-press), filter chips and bulk deletes.
// PLAN §5.7.

import { h, clear, pinyinEl, glossList, debounce, plural } from '../util.js';
import { stripTones } from '../pinyin.js';

const PAGE = 200;
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'noaudio', label: 'No audio' },
  { id: 'suspended', label: 'Suspended' },
];

export function render(root, app) {
  const { state } = app;
  let filter = 'all';
  let query = '';
  let limit = PAGE;

  const search = h('input', {
    type: 'search', class: 'search', placeholder: 'Search hanzi, pinyin or meaning', 'aria-label': 'Search vocabulary',
    'data-testid': 'vocab-search', oninput: debounce(() => { query = search.value.trim(); limit = PAGE; draw(); }, 150),
  });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' });
  const summary = h('p', { class: 'muted small', 'data-testid': 'vocab-summary' });
  const list = h('ul', { class: 'vocab-list', 'data-testid': 'vocab-list' });
  const more = h('div');

  const bulk = h('section', { class: 'card danger' },
    h('h2', {}, 'Bulk delete'),
    h('p', { class: 'muted small' }, 'Removes words from your vocab. Review history is kept, so re-importing restores progress.'),
    h('div', { class: 'row gap wrap' },
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Delete all imported words', onclick: () => bulkDelete('import', 'imported') }, 'Delete all imported'),
      h('button', { class: 'btn', type: 'button', 'aria-label': 'Delete HSK quick-add words', onclick: () => bulkDelete('hsk', 'HSK quick-add') }, 'Delete HSK quick-add')));

  root.append(h('div', { class: 'screen vocab' },
    h('h1', {}, 'Vocabulary'),
    search, chips, summary, list, more, bulk));

  async function bulkDelete(source, label) {
    const n = [...state.vocab.values()].filter((v) => v.source === source).length;
    if (!n) { app.toast(`No ${label} words`); return; }
    if (!confirm(`Delete ${plural(n, 'word')} (${label})?`)) return;
    await state.removeVocabBySource(source);
    app.toast(`Deleted ${plural(n, 'word')}`);
    draw();
  }

  async function remove(v) {
    if (!confirm(`Delete ${v.s} from your vocab?`)) return;
    await state.removeVocab([v.s]);
    draw();
  }

  function matches(v, w) {
    if (!query) return true;
    const q = query.toLowerCase();
    if (v.s.includes(query) || (v.t && v.t.includes(query))) return true;
    const qp = stripTones(query);
    if (qp && /^[a-z]+$/.test(qp) && stripTones(v.p || (w && w.p) || '').startsWith(qp)) return true;
    return glossList(v.d).concat(w ? glossList(w.d) : []).some((d) => d.toLowerCase().includes(q));
  }

  function draw() {
    clear(chips);
    for (const f of FILTERS) {
      chips.append(h('button', {
        type: 'button', class: `chip${filter === f.id ? ' on' : ''}`, 'aria-pressed': String(filter === f.id), 'aria-label': `Show ${f.label}`,
        onclick: () => { filter = f.id; limit = PAGE; draw(); },
      }, f.label));
    }
    const rows = [];
    for (const v of state.vocab.values()) {
      const w = state.wordFor(v.s);
      const status = state.wordStatus(v.s);
      if (filter === 'noaudio' && w) continue;
      if (filter === 'suspended' && status !== 'suspended') continue;
      if (!matches(v, w)) continue;
      rows.push({ v, w, status });
    }
    summary.textContent = `${plural(rows.length, 'word')}${filter === 'all' && !query ? '' : ` of ${state.vocab.size}`}`;
    clear(list);
    for (const { v, w, status } of rows.slice(0, limit)) list.append(row(v, w, status));
    clear(more);
    if (rows.length > limit) {
      more.append(h('button', { class: 'btn block', type: 'button', 'aria-label': 'Show more words', onclick: () => { limit += PAGE; draw(); } },
        `Show more (${rows.length - limit})`));
    }
    if (!state.vocab.size) list.append(h('li', { class: 'muted' }, 'No words yet. ', h('a', { href: '#/import' }, 'Import some'), '.'));
  }

  function row(v, w, status) {
    const li = h('li', { class: 'vocab-row', 'data-testid': 'vocab-row' },
      h('span', { class: 'hz', lang: 'zh-Hans' }, v.s),
      h('span', { class: 'grow' },
        pinyinEl(v.p || (w && w.p) || '', { toneColors: state.settings.toneColors }),
        h('span', { class: 'muted small def' }, glossList(w ? w.d : v.d)[0] || glossList(v.d)[0] || '')),
      h('span', { class: `audio-flag${w ? ' has' : ''}`, title: w ? 'Has audio' : 'No audio', 'aria-label': w ? 'Has audio' : 'No audio' }, '♪'),
      h('span', { class: `chip status ${status}` }, status === 'none' ? '—' : status),
      h('button', { class: 'icon-btn small', type: 'button', 'aria-label': `Delete ${v.s}`, onclick: () => remove(v) }, '✕'));
    // Long-press (600 ms) also deletes, for thumb use.
    let timer = null;
    li.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; timer = setTimeout(() => remove(v), 600); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) li.addEventListener(ev, () => clearTimeout(timer));
    return li;
  }

  draw();
}
