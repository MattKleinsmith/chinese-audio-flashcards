// screens/import.js — vocabulary import: file picker (multiple), paste box, HSK quick-add,
// preview of the first 20 parsed entries with an editable column mapping, then confirm.
// Parsing itself lives in importer.js (pure, unit-tested). PLAN §5.3.

import { h, clear, readFileText, debounce, plural } from '../util.js';
import { parseVocabText } from '../importer.js';

const ROLES = [
  { key: 's', label: 'Simplified' },
  { key: 't', label: 'Traditional' },
  { key: 'p', label: 'Pinyin' },
  { key: 'd', label: 'Definition' },
];

export function render(root, app) {
  const { state, data } = app;
  /** Each source: { name, text, mapping (override or null), result } */
  let sources = [];
  let current = 0;
  const lookup = (w) => data.lookup(w);

  const parse = (src) => { src.result = parseVocabText(src.text, { lookup, mapping: src.mapping || undefined }); return src; };

  // ---- Inputs ---------------------------------------------------------------------------------
  const fileInput = h('input', {
    type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values', multiple: true,
    id: 'import-file', 'data-testid': 'import-file', 'aria-label': 'Choose export files',
    onchange: async () => {
      const files = [...fileInput.files];
      const loaded = [];
      for (const f of files) {
        try { loaded.push(parse({ name: f.name.replace(/\.[^.]+$/, ''), text: await readFileText(f), mapping: null })); } catch (err) { console.warn(err); }
      }
      sources = [...sources.filter((s) => s.name === 'Pasted'), ...loaded];
      current = sources.length - loaded.length;
      renderPreview();
    },
  });

  const textarea = h('textarea', {
    id: 'import-text', 'data-testid': 'import-text', rows: 6, spellcheck: 'false', autocapitalize: 'off',
    placeholder: '学习\txué xí\tto study\n朋友\tpéng you\tfriend\n图书馆', 'aria-label': 'Paste words',
  });
  const previewPaste = () => {
    const text = textarea.value;
    sources = sources.filter((s) => s.name !== 'Pasted');
    if (text.trim()) { sources.unshift(parse({ name: 'Pasted', text, mapping: null })); current = 0; }
    renderPreview();
  };
  textarea.addEventListener('input', debounce(previewPaste, 250));

  const preview = h('section', { class: 'card preview', id: 'import-preview', 'data-testid': 'import-preview', hidden: true });

  // ---- Preview --------------------------------------------------------------------------------
  function renderPreview() {
    clear(preview);
    if (!sources.length) { preview.hidden = true; return; }
    preview.hidden = false;
    current = Math.min(current, sources.length - 1);
    const src = sources[current];
    const { result } = src;
    const ncols = Math.max(1, ...result.rows.slice(0, 200).map((r) => r.length));

    preview.append(h('h2', {}, 'Preview'));
    if (sources.length > 1) {
      preview.append(h('label', { class: 'field' }, 'Previewing ',
        h('select', {
          'aria-label': 'Choose which file to preview',
          onchange: (e) => { current = Number(e.target.value); renderPreview(); },
        }, sources.map((s, i) => h('option', { value: String(i), selected: i === current }, `${s.name} (${s.result.entries.length})`)))));
    }

    // Column mapping: one <select> per role.
    const colLabel = (i) => {
      const head = result.header?.[i];
      const sample = result.rows.find((r) => r[i] && r[i].trim())?.[i] ?? '';
      return `Column ${i + 1}${head ? ` “${head}”` : sample ? ` (e.g. ${sample.slice(0, 16)})` : ''}`;
    };
    const mapping = h('div', { class: 'mapping', 'data-testid': 'column-mapping' });
    for (const role of ROLES) {
      const sel = h('select', {
        id: `map-${role.key}`, 'data-testid': `map-${role.key}`, 'aria-label': `Column for ${role.label}`,
        onchange: (e) => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          src.mapping = { ...result.mapping, [role.key]: v };
          parse(src);
          renderPreview();
        },
      }, h('option', { value: '', selected: result.mapping[role.key] === null }, '— none —'),
      Array.from({ length: ncols }, (_, i) => h('option', { value: String(i), selected: result.mapping[role.key] === i }, colLabel(i))));
      mapping.append(h('label', { class: 'field' }, h('span', {}, role.label), sel));
    }
    preview.append(mapping);

    // First 20 entries.
    const showT = result.mapping.t !== null;
    const table = h('table', { class: 'preview-table', 'data-testid': 'preview-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Hanzi'), showT && h('th', {}, 'Trad.'), h('th', {}, 'Pinyin'), h('th', {}, 'Definition'), h('th', { 'aria-label': 'Has audio' }, '♪'))),
      h('tbody', {}, result.entries.slice(0, 20).map((e) => h('tr', { 'data-testid': 'preview-row' },
        h('td', { lang: 'zh-Hans', class: 'hz' }, e.s),
        showT && h('td', { lang: 'zh-Hant' }, e.t || ''),
        h('td', {}, e.p || ''),
        h('td', { class: 'def' }, e.d || ''),
        h('td', { class: data.lookup(e.s) ? 'ok' : 'muted' }, data.lookup(e.s) ? '♪' : '–')))));
    preview.append(h('div', { class: 'table-wrap' }, table));

    const r = result.report;
    const totalEntries = distinctEntries().length;
    const already = distinctEntries().filter((e) => state.vocab.has(e.s)).length;
    preview.append(h('p', { class: 'muted small', 'data-testid': 'import-report' },
      `${plural(r.added, 'word')} in this ${src.name === 'Pasted' ? 'paste' : 'file'}`,
      r.duplicates ? ` · ${r.duplicates} duplicate${r.duplicates === 1 ? '' : 's'}` : '',
      r.rejected ? ` · ${r.rejected} row${r.rejected === 1 ? '' : 's'} skipped` : '',
      ` · ${r.noAudio.length} without audio`,
      already ? ` · ${already} already in your vocab` : ''));

    preview.append(h('button', {
      class: 'btn primary block', type: 'button', 'data-testid': 'import-confirm', disabled: totalEntries === 0,
      'aria-label': `Import ${totalEntries} words`, onclick: doImport,
    }, `Import ${plural(totalEntries, 'word')}`));
  }

  function distinctEntries() {
    const seen = new Map();
    for (const src of sources) for (const e of src.result.entries) if (!seen.has(e.s)) seen.set(e.s, { e, listName: src.name });
    return [...seen.values()].map((x) => ({ ...x.e, listName: x.listName }));
  }

  async function doImport() {
    const all = distinctEntries();
    let added = 0; let withAudio = 0; let unlocked = 0;
    const byList = new Map();
    for (const e of all) { if (!byList.has(e.listName)) byList.set(e.listName, []); byList.get(e.listName).push(e); }
    for (const [listName, entries] of byList) {
      const res = await state.addVocab(entries, 'import', listName);
      added += res.added; withAudio += res.withAudio; unlocked += res.unlocked;
    }
    sources = [];
    textarea.value = '';
    fileInput.value = '';
    renderPreview();
    doneToast(app, added, withAudio, unlocked);
  }

  // ---- HSK quick-add --------------------------------------------------------------------------
  const levels = [1, 2, 3, 4, 5, 6];
  const checks = levels.map((n) => h('input', {
    type: 'checkbox', id: `hsk-${n}`, 'data-testid': `hsk-${n}`, value: String(n),
    disabled: !data.hskCounts[n], 'aria-label': `HSK ${n}`,
  }));
  const hskSection = h('section', { class: 'card', id: 'hsk' },
    h('h2', {}, 'Quick start with HSK levels'),
    h('p', { class: 'muted small' }, 'Adds every word of the chosen HSK 2.0 levels that has audio. Good for trying the app without an export file.'),
    h('div', { class: 'hsk-grid' }, levels.map((n, i) => h('label', { class: 'check', for: `hsk-${n}` }, checks[i],
      h('span', {}, `HSK ${n}`), h('span', { class: 'muted small' }, `${data.hskCounts[n] || 0}`)))),
    h('button', {
      class: 'btn primary block', type: 'button', 'data-testid': 'hsk-add', 'aria-label': 'Add selected HSK levels',
      onclick: async () => {
        const chosen = checks.filter((c) => c.checked).map((c) => Number(c.value));
        if (!chosen.length) { app.toast('Choose at least one HSK level'); return; }
        let added = 0; let withAudio = 0; let unlocked = 0;
        for (const n of chosen) {
          const entries = data.wordsAtLevel(n).map((w) => ({ s: w.s, t: w.t !== w.s ? w.t : undefined, p: w.p }));
          const res = await state.addVocab(entries, 'hsk', `HSK ${n}`);
          added += res.added; withAudio += res.withAudio; unlocked += res.unlocked;
        }
        for (const c of checks) c.checked = false;
        doneToast(app, added, withAudio, unlocked);
      },
    }, 'Add selected levels'));

  const screen = h('div', { class: 'screen import' },
    h('h1', {}, 'Import words'),
    h('section', { class: 'card' },
      h('h2', {}, 'From Hack Chinese'),
      h('p', { class: 'muted small' }, 'In Hack Chinese open a list → List Options (⋮) → Export. Repeat for each list; imports add up and re-importing is harmless. Any CSV/TSV/TXT with one word per line or a column of characters also works.'),
      h('label', { class: 'btn block file-btn', for: 'import-file' }, 'Choose files…', fileInput),
      h('label', { class: 'field stacked', for: 'import-text' }, h('span', {}, 'Or paste words'), textarea),
      h('button', { class: 'btn block', type: 'button', 'data-testid': 'import-preview-btn', 'aria-label': 'Preview pasted words', onclick: previewPaste }, 'Preview')),
    preview,
    hskSection);
  root.append(screen);

  if (app.importFocus === 'hsk') {
    app.importFocus = null;
    requestAnimationFrame(() => hskSection.scrollIntoView({ block: 'start' }));
  }
}

function doneToast(app, added, withAudio, unlocked) {
  app.toast(`Added ${plural(added, 'word')} · ${withAudio} have audio · ${plural(unlocked, 'sentence')} unlocked`, {
    ms: 7000,
    action: { label: 'Study', onClick: () => { app.player.unlock(); app.navigate('#/'); } },
  });
}
