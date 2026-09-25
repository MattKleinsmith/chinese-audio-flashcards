// screens/home.js — home screen: empty state with import / HSK quick-start, or the three mode
// tiles (Words / Sentences / Mixed) with due · new counts and small vocab stats. PLAN §5.2.

import { h } from '../util.js';
import { lastSync, describeSync } from '../sync.js';

export const MODES = [
  { id: 'words', label: 'Words', zh: '词', hint: 'Single words, one speaker' },
  { id: 'sentences', label: 'Sentences', zh: '句', hint: 'Short sentences, many voices' },
  { id: 'mixed', label: 'Mixed', zh: '混', hint: 'Words and sentences' },
];

function lastMode() {
  try { return localStorage.getItem('clf-last-mode') || ''; } catch { return ''; }
}

export function render(root, app) {
  const { state } = app;
  const screen = h('div', { class: 'screen home' });
  root.append(screen);

  if (state.vocab.size === 0) {
    screen.append(h('section', { class: 'empty', 'data-testid': 'empty-state' },
      h('div', { class: 'empty-glyph', 'aria-hidden': 'true', lang: 'zh-Hans' }, '听'),
      h('h1', {}, 'Train your ear on words you already know'),
      h('p', { class: 'muted' }, 'Hear a native speaker, then check the characters and pinyin. Even one card is a win.'),
      h('a', { class: 'btn primary block', href: '#/import', 'data-testid': 'cta-import', 'aria-label': 'Import from Hack Chinese' }, 'Import from Hack Chinese'),
      h('a', { class: 'btn block', href: '#/import', 'data-testid': 'cta-hsk', 'aria-label': 'Quick start with HSK levels',
        onclick: (e) => { e.preventDefault(); app.importFocus = 'hsk'; app.navigate('#/import'); } }, 'Quick start with HSK levels')));
    return;
  }

  const stats = state.stats();
  const last = lastMode();
  const tiles = h('section', { class: 'tiles', 'aria-label': 'Study modes' });
  // Sentences are the main thing; Words and Mixed are hidden unless enabled in Settings.
  const visibleModes = state.settings.showWordModes ? MODES : MODES.filter((m) => m.id === 'sentences');
  for (const m of visibleModes) {
    const c = stats[m.id];
    const empty = c.due + c.new === 0;
    tiles.append(h('div', { class: `tile${m.id === last ? ' last' : ''}`, 'data-testid': `tile-${m.id}` },
      h('div', { class: 'tile-head' },
        h('span', { class: 'tile-zh', lang: 'zh-Hans', 'aria-hidden': 'true' }, m.zh),
        h('div', {},
          h('h2', {}, m.label),
          h('p', { class: 'muted small' }, m.hint))),
      h('p', { class: 'counts' },
        h('span', { class: 'due', 'data-testid': `due-${m.id}` }, String(c.due)), ' due · ',
        h('span', { class: 'new', 'data-testid': `new-${m.id}` }, String(c.new)), ' new'),
      h('button', {
        class: `btn ${empty ? '' : 'primary'} block`, type: 'button', 'data-testid': `start-${m.id}`,
        'aria-label': `Start ${m.label}`,
        // The tap is a user gesture: unlock audio synchronously so autoplay works on mobile.
        onclick: () => {
          app.player.unlock();
          try { localStorage.setItem('clf-last-mode', m.id); } catch { /* ignore */ }
          app.navigate(`#/study/${m.id}`);
        },
      }, empty ? 'Study extra' : 'Start')));
  }
  screen.append(tiles);

  screen.append(h('section', { class: 'stats', 'aria-label': 'Stats' },
    stat(state.vocab.size, 'vocab words', 'stat-vocab'),
    stat(stats.wordsWithAudio, 'with audio', 'stat-audio'),
    stat(stats.sentencesUnlocked, 'sentences unlocked', 'stat-sentences')));

  const syncLine = h('p', { class: 'muted small', 'data-testid': 'home-sync' }, '');
  lastSync(app).then((rec) => { const t = describeSync(rec); if (t) syncLine.textContent = t; else syncLine.remove(); });
  screen.append(syncLine);

  screen.append(h('div', { class: 'row gap' },
    h('a', { class: 'btn', href: '#/import', 'aria-label': 'Import more words' }, '+ Import words'),
    h('a', { class: 'btn', href: '#/vocab', 'aria-label': 'View vocabulary' }, 'Vocabulary')));

  if (stats.sentencesUnlocked === 0 && app.data.sentences.length) {
    screen.append(h('p', { class: 'muted small' },
      'No sentences unlocked yet: add more words, or allow 1–2 unknown words per sentence in ',
      h('a', { href: '#/settings' }, 'Settings'), '.'));
  }
}

function stat(n, label, testid) {
  return h('div', { class: 'stat' }, h('strong', { 'data-testid': testid }, String(n)), h('span', { class: 'muted small' }, label));
}
