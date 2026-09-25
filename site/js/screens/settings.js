// screens/settings.js — study settings, theme, backup/restore, danger zone and About
// (audio sources with licences and links, app version, data build date). PLAN §5.8.

import { h, downloadJSON, ymd, readFileText, plural } from '../util.js';
import { RATES } from '../audio.js';
import { lastSync, describeSync } from '../sync.js';

function toggle(app, key, label, hint) {
  const input = h('input', {
    type: 'checkbox', id: `set-${key}`, 'data-testid': `set-${key}`, checked: !!app.state.settings[key], role: 'switch', 'aria-label': label,
    onchange: () => app.state.setSetting(key, input.checked),
  });
  return h('label', { class: 'setting', for: `set-${key}` }, h('span', {}, label, hint ? h('small', { class: 'muted' }, hint) : null), input);
}

function select(app, key, label, options, { hint, parse = Number, onChange } = {}) {
  const current = String(app.state.settings[key]);
  const sel = h('select', {
    id: `set-${key}`, 'data-testid': `set-${key}`, 'aria-label': label,
    onchange: async () => { await app.state.setSetting(key, parse(sel.value)); if (onChange) onChange(parse(sel.value)); },
  }, options.map(([value, text]) => h('option', { value: String(value), selected: String(value) === current }, text)));
  return h('label', { class: 'setting', for: `set-${key}` }, h('span', {}, label, hint ? h('small', { class: 'muted' }, hint) : null), sel);
}

function number(app, key, label, min, max) {
  const input = h('input', {
    type: 'number', inputmode: 'numeric', id: `set-${key}`, 'data-testid': `set-${key}`, min: String(min), max: String(max),
    value: String(app.state.settings[key]), 'aria-label': label,
    onchange: () => {
      const v = Math.max(min, Math.min(max, Math.round(Number(input.value) || 0)));
      input.value = String(v);
      app.state.setSetting(key, v);
    },
  });
  return h('label', { class: 'setting', for: `set-${key}` }, h('span', {}, label), input);
}

function themeSelect() {
  let current = 'auto';
  try { current = localStorage.getItem('clf-theme') || 'auto'; } catch { /* ignore */ }
  const sel = h('select', {
    id: 'set-theme', 'aria-label': 'Theme',
    onchange: () => {
      const v = sel.value;
      try { if (v === 'auto') localStorage.removeItem('clf-theme'); else localStorage.setItem('clf-theme', v); } catch { /* ignore */ }
      if (v === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
    },
  }, [['auto', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([v, t]) => h('option', { value: v, selected: v === current }, t)));
  return h('label', { class: 'setting', for: 'set-theme' }, h('span', {}, 'Theme'), sel);
}

export function render(root, app) {
  const { state, data } = app;
  const m = data.manifest || {};
  const hours = Array.from({ length: 13 }, (_, i) => [i, i === 0 ? 'Midnight' : i === 12 ? 'Noon' : `${i} am`]);

  const restoreInput = h('input', {
    type: 'file', accept: '.json,application/json', id: 'restore-file', 'data-testid': 'restore-file', hidden: true, 'aria-label': 'Choose backup file',
    onchange: async () => {
      const file = restoreInput.files[0];
      restoreInput.value = '';
      if (!file) return;
      let dump;
      try { dump = JSON.parse(await readFileText(file)); } catch { app.toast('That file is not valid JSON'); return; }
      const n = Array.isArray(dump?.vocab) ? dump.vocab.length : 0;
      if (!confirm(`Replace ALL current data with this backup (${plural(n, 'word')}, ${plural((dump.reviews || []).length, 'review')})?`)) return;
      try {
        await state.restoreAll(dump);
        app.player.setRate(state.settings.rate);
        app.toast(`Restored ${plural(state.vocab.size, 'word')}`);
        app.navigate('#/');
      } catch (err) { app.toast(`Restore failed: ${err.message}`); }
    },
  });

  const sources = (m.sources || []).map((s) => h('li', {},
    h('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name || s.id),
    ` — ${s.license || 'licence unknown'}`,
    s.kind ? h('span', { class: 'muted small' }, ` · ${s.kind} audio`) : null,
    s.synthetic ? h('span', { class: 'badge' }, 'TTS') : null));
  const hasCedict = (m.sources || []).some((s) => /cedict/i.test(`${s.id} ${s.name}`));

  const syncStatus = h('p', { class: 'small', 'data-testid': 'sync-status' }, 'Checking…');
  lastSync(app).then((rec) => {
    syncStatus.textContent = !rec || rec.status === 'none' ? 'No export in the site yet.'
      : rec.status === 'error' ? `Last check failed: ${rec.message}` : describeSync(rec) || 'Not synced yet.';
  });

  root.append(h('div', { class: 'screen settings' },
    h('h1', {}, 'Settings'),

    h('section', { class: 'card' },
      h('h2', {}, 'Study'),
      toggle(app, 'autoplay', 'Autoplay audio', 'Play each clip when the card appears'),
      toggle(app, 'showWordModes', 'Show Words and Mixed modes', 'Off = only Sentences on the home screen'),
      select(app, 'rate', 'Playback speed', RATES.map((r) => [r, r === 1 ? '1× (natural speed)' : `${r}× — pitch preserved`]), {
        parse: Number, onChange: (v) => app.player.setRate(v),
      }),
      toggle(app, 'showPinyin', 'Show pinyin', 'Also switchable on each card; tone colours follow it'),
      toggle(app, 'toneColors', 'Tone colours'),
      toggle(app, 'showTraditional', 'Show traditional characters'),
      toggle(app, 'showDefinition', 'Show definition on word cards'),
      toggle(app, 'showTranslation', 'Show machine translation of sentences', 'Also switchable on each card; word meanings are from CC-CEDICT'),
      select(app, 'threshold', 'Unknown words allowed per sentence', [[0, '0 (only known words)'], [1, '1'], [2, '2']]),
      number(app, 'newWords', 'New words per day', 0, 500),
      number(app, 'newSentences', 'New sentences per day', 0, 500),
      number(app, 'sessionSize', 'Cards per session', 1, 500),
      select(app, 'dayStart', 'Day starts at', hours),
      themeSelect()),

    h('section', { class: 'card', 'data-testid': 'hc-sync' },
      h('h2', {}, 'Hack Chinese sync'),
      h('p', { class: 'muted small' },
        'A daily GitHub Action downloads your “all studied words” export into this site; the app adds any new words automatically on open. ',
        'Set the HACKCHINESE_EMAIL and HACKCHINESE_PASSWORD repository secrets to enable it (see the README).'),
      syncStatus,
      h('div', { class: 'row gap wrap' },
        h('button', {
          class: 'btn', type: 'button', 'data-testid': 'sync-now', 'aria-label': 'Sync from Hack Chinese now',
          onclick: async () => {
            syncStatus.textContent = 'Checking…';
            const r = await app.sync(true);
            if (r.status === 'none') syncStatus.textContent = 'No export in the site yet. The GitHub Action has not run successfully.';
            else if (r.status === 'error') syncStatus.textContent = `Sync failed: ${r.message}`;
            else syncStatus.textContent = `${describeSync(r)}${r.status === 'synced' ? ` · +${r.added || 0}${r.removed ? ` −${r.removed}` : ''}` : ''}`;
          },
        }, 'Sync now')),
      toggle(app, 'mirrorHcDeletions', 'Mirror deletions', 'Also remove words that disappear from the Hack Chinese export')),

    h('section', { class: 'card' },
      h('h2', {}, 'Backup'),
      h('p', { class: 'muted small' }, 'Everything lives in this browser only. Export a backup now and then, especially before clearing site data.'),
      h('div', { class: 'row gap wrap' },
        h('button', {
          class: 'btn primary', type: 'button', 'data-testid': 'export-backup', 'aria-label': 'Export everything',
          onclick: async () => downloadJSON(await state.exportAll(), `clf-backup-${ymd()}.json`),
        }, 'Export everything'),
        h('label', { class: 'btn', for: 'restore-file', 'data-testid': 'restore-btn', 'aria-label': 'Restore from backup' }, 'Restore…', restoreInput))),

    h('section', { class: 'card' },
      h('h2', {}, 'Local data & activity'),
      h('p', { class: 'muted small' }, 'See what is stored in this browser, how big it is, and your recent reviews. Useful to confirm your progress is still here.'),
      h('a', { class: 'btn block', href: '#/activity', 'data-testid': 'open-activity', 'aria-label': 'Open local data and activity' }, 'Local data & activity')),

    h('section', { class: 'card danger' },
      h('h2', {}, 'Danger zone'),
      h('div', { class: 'row gap wrap' },
        h('button', {
          class: 'btn warn', type: 'button', 'data-testid': 'reset-srs', 'aria-label': 'Reset SRS progress',
          onclick: async () => {
            if (!confirm('Reset all review progress? Your vocab is kept.')) return;
            await state.resetSRS();
            app.toast('Progress reset');
          },
        }, 'Reset SRS progress'),
        h('button', {
          class: 'btn warn', type: 'button', 'data-testid': 'delete-all', 'aria-label': 'Delete all data',
          onclick: async () => {
            if (!confirm('Delete ALL data (vocab, progress, settings)? This cannot be undone.')) return;
            await state.deleteAll();
            try { localStorage.removeItem('clf-theme'); localStorage.removeItem('clf-last-mode'); } catch { /* ignore */ }
            delete document.documentElement.dataset.theme;
            app.toast('All data deleted');
            app.navigate('#/');
          },
        }, 'Delete all data'))),

    h('section', { class: 'card about', 'data-testid': 'about' },
      h('h2', {}, 'About'),
      h('p', {}, 'Listening Cards (听力卡): listening reps on the Chinese words you already know. Real human recordings, no TTS.'),
      h('h3', {}, 'Audio and data sources'),
      h('ul', { class: 'sources', 'data-testid': 'about-sources' }, sources,
        hasCedict ? null : h('li', {}, h('a', { href: 'https://www.mdbg.net/chinese/dictionary?page=cc-cedict', target: '_blank', rel: 'noopener' }, 'CC-CEDICT'), ' — CC BY-SA 4.0 · definitions')),
      h('p', { class: 'muted small' }, 'CC BY-SA recordings are used with attribution; see each source for its licence terms.'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'App version'), h('dd', { 'data-testid': 'app-version' }, app.buildSha),
        h('dt', {}, 'Audio bundle built'), h('dd', {}, m.builtAt ? new Date(m.builtAt).toLocaleString() : 'unknown'),
        h('dt', {}, 'Bundle'), h('dd', {}, `${plural(data.words.length, 'word')} · ${plural(data.sentences.length, 'sentence')}`),
        h('dt', {}, 'Storage'), h('dd', {}, state.db.mode === 'idb' ? 'IndexedDB (this browser)' : 'Memory only — not saved')),
      h('p', { class: 'small' }, h('a', { href: 'https://github.com/mattkleinsmith/chinese-audio-flashcards', target: '_blank', rel: 'noopener' }, 'Source code on GitHub')))));
}
