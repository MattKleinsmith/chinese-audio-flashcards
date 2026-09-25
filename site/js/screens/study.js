// screens/study.js — the card UI (PLAN §5.4).
// Front: big Play/Pause button, a transport row (restart, rewind 5 s / 1 s / 0.5 s / 0.1 s),
// a playback-speed row, the "Word" / "Sentence · <gender>" label and Show answer.
// Back: word card (hanzi, tone-coloured pinyin, definitions, HSK badge) or sentence card
// (tappable tokens with per-character pinyin in a two-row CSS grid, definition popover,
// + Add to vocab), the same transport controls (smaller), and the Again / Hard / Good / Easy
// grade bar.
//
// HARD REQUIREMENT: no elapsed time, no progress bar, no duration and no waveform for the
// audio, anywhere on this screen. The only audio UI is the Replay button (with a pulsing ring
// while playing). The session counter "done/total" counts CARDS, not audio time.

import { h, clear, pinyinEl, glossList, formatDuration, plural, dismissToast } from '../util.js';
import { gradeCard, previewIntervals } from '../scheduler.js';
import { preload, RATES, REWIND_STEPS } from '../audio.js';
import { sentenceTokens, isKnownToken, clipKey } from '../queue.js';
import { numericToMarks, toneOf } from '../pinyin.js';
import { MODES } from './home.js';

const GRADES = [
  { id: 'again', label: 'Again', key: '1' },
  { id: 'hard', label: 'Hard', key: '2' },
  { id: 'good', label: 'Good', key: '3' },
  { id: 'easy', label: 'Easy', key: '4' },
];

const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export function render(root, app, [mode]) {
  const { state, data, player } = app;
  const modeInfo = MODES.find((m) => m.id === mode) || MODES[0];
  const settings = state.settings;
  player.setRate(settings.rate);
  dismissToast(0); // the card needs the whole screen

  const session = {
    mode, queue: state.buildQueue(mode), pos: 0, done: 0, again: 0, startedAt: Date.now(), extra: false,
  };
  app.session = { mode, done: 0, total: session.queue.length };

  // Per-card view state.
  let item = null; let card = null; let content = null; let clip = null;
  let revealed = false; let shownAt = 0; let busy = false;

  // ---- Static chrome --------------------------------------------------------------------------
  const counter = h('span', { class: 'session-count', 'data-testid': 'session-count', 'aria-label': 'Cards done this session' });
  const menu = h('div', { class: 'menu', role: 'menu', hidden: true },
    h('button', { type: 'button', role: 'menuitem', 'data-testid': 'menu-skip', 'aria-label': 'Skip card', onclick: () => { closeMenu(); skip(); } }, 'Skip'),
    h('button', { type: 'button', role: 'menuitem', 'data-testid': 'menu-suspend', 'aria-label': 'Suspend card', onclick: () => { closeMenu(); suspendCard(); } }, 'Suspend card'),
    h('button', { type: 'button', role: 'menuitem', 'data-testid': 'menu-bad-audio', 'aria-label': 'Report bad audio', onclick: () => { closeMenu(); reportBadAudio(); } }, 'Report bad audio'),
    h('button', {
      type: 'button', role: 'menuitemcheckbox', 'data-testid': 'menu-pinyin', 'aria-checked': String(settings.showPinyin !== false),
      'aria-label': 'Show pinyin',
      onclick: async (e) => {
        const btn = e.currentTarget; // null after the await, so capture it first
        closeMenu();
        await state.setSetting('showPinyin', settings.showPinyin === false);
        btn.setAttribute('aria-checked', String(settings.showPinyin !== false));
        btn.textContent = settings.showPinyin === false ? 'Show pinyin' : 'Hide pinyin';
        if (item && revealed) renderCard();
      },
    }, settings.showPinyin === false ? 'Show pinyin' : 'Hide pinyin'));
  const menuBtn = h('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Card menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-testid': 'menu',
    onclick: (e) => { e.stopPropagation(); menu.hidden ? openMenu() : closeMenu(); },
  }, '≡');
  function openMenu() { menu.hidden = false; menuBtn.setAttribute('aria-expanded', 'true'); }
  function closeMenu() { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }

  const bar = h('div', { class: 'study-bar' },
    h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to home' }, '←'),
    h('span', { class: 'mode-name' }, modeInfo.label),
    counter,
    h('span', { class: 'menu-wrap' }, menuBtn, menu));

  const cardArea = h('div', { class: 'card-area', 'data-testid': 'card-area' });
  const actions = h('div', { class: 'actions' });
  const screen = h('div', { class: 'screen study', 'data-testid': 'study' }, bar, cardArea, actions);
  root.append(screen);

  const onDocClick = (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) closeMenu();
  };
  document.addEventListener('click', onDocClick);

  // ---- Transport: play/pause, restart, rewind steps, speed --------------------------------------
  // The only audio UI. Relative rewinds and a speed choice are fine; elapsed time, duration,
  // a seek bar or a waveform are not (see HARD REQUIREMENT above).
  const replayHint = h('span', { class: 'replay-hint', 'aria-hidden': 'true' });
  const replayIcon = h('span', { class: 'replay-icon', 'aria-hidden': 'true' }, '▶︎');
  const replayBtn = h('button', {
    class: 'replay', type: 'button', 'data-testid': 'replay', 'aria-label': 'Play audio',
    onclick: (e) => { e.stopPropagation(); togglePlay(); },
  }, replayIcon, replayHint);

  const fmtStep = (sec) => (sec >= 1 ? `−${sec}s` : `−${String(sec).replace(/^0/, '')}s`);
  const transport = h('div', { class: 'transport', role: 'group', 'aria-label': 'Playback controls', 'data-testid': 'transport',
    onclick: (e) => e.stopPropagation() },
    h('button', { class: 'tbtn', type: 'button', 'data-testid': 'restart', 'aria-label': 'Restart from the beginning', title: 'Restart',
      onclick: () => { if (clip) player.restart(); } }, '↺'),
    ...REWIND_STEPS.map((sec) => h('button', {
      class: 'tbtn', type: 'button', 'data-testid': `rewind-${sec}`, 'aria-label': `Go back ${sec} second${sec === 1 ? '' : 's'}`,
      onclick: () => { if (clip) player.seekBy(-sec); },
    }, fmtStep(sec))));

  const speedBtns = new Map();
  const speeds = h('div', { class: 'speeds', role: 'radiogroup', 'aria-label': 'Playback speed', 'data-testid': 'speeds',
    onclick: (e) => e.stopPropagation() },
    ...RATES.map((r) => {
      const b = h('button', {
        class: 'speed', type: 'button', role: 'radio', 'data-testid': `speed-${r}`, 'aria-label': `Speed ${r}×`,
        onclick: () => setRate(r),
      }, `${r}×`);
      speedBtns.set(r, b);
      return b;
    }));
  function paintSpeeds() {
    for (const [r, b] of speedBtns) {
      const on = Math.abs(r - player.rate) < 1e-6;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  async function setRate(r) {
    player.setRate(r);
    paintSpeeds();
    await state.setSetting('rate', r);
  }
  paintSpeeds();

  const setAudioState = (st) => {
    const playing = st === 'playing' || st === 'loading';
    replayBtn.classList.toggle('playing', playing);
    replayBtn.classList.toggle('paused', st === 'paused');
    replayBtn.classList.toggle('blocked', st === 'blocked' || st === 'error');
    replayIcon.textContent = playing ? '❚❚' : '▶︎';
    replayBtn.setAttribute('aria-label', playing ? 'Pause audio' : st === 'paused' ? 'Resume audio' : 'Play audio');
    replayHint.textContent = st === 'error' ? 'Audio failed · tap to retry' : st === 'paused' ? 'Paused' : '';
  };
  const unsubscribe = player.onChange(setAudioState);

  async function playCurrent() {
    if (!clip) return;
    const res = await player.play(data.clipUrl(clip.file));
    if (res === 'blocked') setAudioState('blocked');
  }
  async function togglePlay() {
    if (!clip) return;
    const res = await player.toggle();
    if (res === 'blocked') setAudioState('blocked');
  }

  // ---- Flow -----------------------------------------------------------------------------------
  function updateCounter() {
    counter.textContent = `${session.done}/${session.queue.length}`;
    app.session = { mode, done: session.done, total: session.queue.length, pos: session.pos, revealed, cardId: item?.cardId || null };
  }

  function chooseClip(kind, c, st) {
    if (kind === 'sentence') return c.clip;
    const usable = (c.clips || []).filter((x) => !state.suspendedClips.has(clipKey(x)));
    if (!usable.length) return null;
    return usable[(st?.reps || 0) % usable.length];
  }

  function clipFor(it) {
    if (it.kind === 'word') { const w = data.wordsById.get(it.ref); return w ? chooseClip('word', w, state.cards.get(it.cardId)?.state) : null; }
    const s = data.sentencesById.get(it.ref); return s ? s.clip : null;
  }

  function warm(n) {
    for (const it of session.queue.slice(session.pos + 1, session.pos + 1 + n)) {
      const c = clipFor(it);
      if (c) preload(data.clipUrl(c.file));
    }
  }

  async function showCard() {
    closeMenu();
    if (session.pos >= session.queue.length) { showSummary(); return; }
    item = session.queue[session.pos];
    content = item.kind === 'word' ? data.wordsById.get(item.ref) : data.sentencesById.get(item.ref);
    if (!content) { session.queue.splice(session.pos, 1); return showCard(); } // data changed; skip silently
    card = await state.ensureCard(item);
    clip = chooseClip(item.kind, content, card.state);
    if (!clip) { session.queue.splice(session.pos, 1); return showCard(); }
    revealed = false;
    shownAt = Date.now();
    renderCard();
    updateCounter();
    player.load(data.clipUrl(clip.file));
    setAudioState('idle');
    if (settings.autoplay) playCurrent();
    else setAudioState('blocked');
    preload(data.clipUrl(clip.file));
    warm(3);
  }

  function renderCard() {
    clear(cardArea); clear(actions);
    cardArea.classList.toggle('revealed', revealed);
    const label = item.kind === 'word' ? 'Word' : `Sentence${clip.gender ? ` · ${clip.gender}` : ''}`;
    cardArea.append(h('p', { class: 'card-label', 'data-testid': 'card-label' }, label));
    replayBtn.classList.toggle('small', revealed);
    transport.classList.toggle('small', revealed);
    speeds.classList.toggle('small', revealed);
    cardArea.append(replayBtn, transport, speeds);

    if (!revealed) {
      // Tapping anywhere on the lower half of the card reveals the answer.
      cardArea.append(h('div', { class: 'reveal-zone', 'data-testid': 'reveal-zone', 'aria-hidden': 'true', onclick: reveal }));
      actions.append(h('button', { class: 'btn primary block big', type: 'button', 'data-testid': 'reveal', 'aria-label': 'Show answer', onclick: reveal }, 'Show answer'));
      return;
    }

    cardArea.append(item.kind === 'word' ? wordBack(content) : sentenceBack(content));
    const labels = previewIntervals(card.state, Date.now());
    actions.append(h('div', { class: 'grades', role: 'group', 'aria-label': 'Grade your answer' },
      GRADES.map((g) => h('button', {
        class: `btn grade grade-${g.id}`, type: 'button', 'data-testid': `grade-${g.id}`,
        'aria-label': `${g.label}, next in ${labels[g.id]}`, onclick: () => grade(g.id),
      }, h('span', { class: 'grade-label' }, g.label), h('span', { class: 'grade-ivl' }, labels[g.id])))));
  }

  function reveal() {
    if (revealed || !item) return;
    revealed = true;
    renderCard();
    updateCounter();
  }

  async function grade(g) {
    if (busy || !revealed) return;
    busy = true;
    try {
      const now = Date.now();
      const wasNew = !card.state || card.state.status === 'new';
      const next = { ...card, state: gradeCard(card.state, g, now) };
      if (wasNew && !next.introducedAt) next.introducedAt = now;
      await state.saveCard(next);
      await state.logReview({ cardId: item.cardId, ts: now, grade: g, elapsedMs: now - shownAt });
      session.done++;
      if (g === 'again') {
        session.again++;
        // Learning step inside the session: show it again 3–6 positions later.
        const at = Math.min(session.queue.length, session.pos + randInt(3, 6));
        session.queue.splice(at, 0, { ...item });
      }
      session.pos++;
      await showCard();
    } finally { busy = false; }
  }

  function removeLater(cardId) {
    session.queue = session.queue.filter((it, i) => i <= session.pos || it.cardId !== cardId);
  }

  async function skip() { session.pos++; await showCard(); }

  async function suspendCard() {
    await state.saveCard({ ...card, suspended: true });
    removeLater(item.cardId);
    app.toast('Card suspended');
    session.pos++;
    await showCard();
  }

  async function reportBadAudio() {
    const key = clipKey(clip);
    await state.logReview({ cardId: item.cardId, ts: Date.now(), grade: 'bad-audio', elapsedMs: Date.now() - shownAt, clipId: key });
    await state.suspendClip(key);
    if (item.kind === 'sentence' || !(content.clips || []).some((c) => !state.suspendedClips.has(clipKey(c)))) removeLater(item.cardId);
    app.toast('Thanks — that clip won’t be shown again');
    session.pos++;
    await showCard();
  }

  // ---- Answers --------------------------------------------------------------------------------
  /** Pinyin on/off chip shown on the card back; changes the persistent setting and re-renders. */
  function pinyinToggle() {
    const on = settings.showPinyin !== false;
    return h('button', {
      class: `chip toggle${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on),
      'data-testid': 'card-pinyin', 'aria-label': 'Show pinyin',
      onclick: async (e) => {
        e.stopPropagation();
        await state.setSetting('showPinyin', !on);
        const mi = menu.querySelector('[data-testid=menu-pinyin]');
        if (mi) { mi.setAttribute('aria-checked', String(!on)); mi.textContent = on ? 'Show pinyin' : 'Hide pinyin'; }
        renderCard();
      },
    }, on ? 'Pinyin on' : 'Pinyin off');
  }

  /** Hanzi split into per-character spans coloured by the tone of the matching pinyin syllable. */
  function colouredHanzi(hanzi, pinyin, toneColors) {
    const chars = [...hanzi];
    const syl = String(pinyin || '').trim().split(/\s+/).filter(Boolean);
    if (!toneColors || syl.length !== chars.length) return [hanzi];
    return chars.map((c, i) => h('span', { class: `hz t${toneOf(syl[i])}` }, c));
  }

  function wordBack(w) {
    const showPy = settings.showPinyin !== false;
    const tc = settings.toneColors && showPy;
    return h('div', { class: 'answer word-answer', 'data-testid': 'answer' },
      h('div', { class: 'hanzi', lang: 'zh-Hans', 'data-testid': 'answer-hanzi' }, ...colouredHanzi(w.s, w.p, tc)),
      settings.showTraditional && w.t && w.t !== w.s ? h('div', { class: 'trad muted', lang: 'zh-Hant' }, w.t) : null,
      showPy ? pinyinEl(w.p, { toneColors: tc, className: 'pinyin big' }) : null,
      settings.showDefinition && glossList(w.d).length
        ? h('ul', { class: 'defs' }, glossList(w.d).slice(0, 3).map((d) => h('li', {}, d))) : null,
      w.hsk ? h('span', { class: 'badge' }, `HSK ${w.hsk}`) : null,
      h('div', { class: 'card-tools' }, pinyinToggle()));
  }

  let popover = null;
  function closePopover() { if (popover) { popover.remove(); popover = null; } }

  function sentenceBack(s) {
    const showPy = settings.showPinyin !== false;
    const tc = settings.toneColors && showPy;
    const toks = sentenceTokens(s);
    const vocabSet = new Set(state.vocab.keys());
    const wrap = h('div', { class: `sentence${showPy ? '' : ' no-pinyin'}`, lang: 'zh-Hans', 'data-testid': 'sentence' });
    s.tokens.forEach(([a, b], i) => {
      const text = toks[i];
      const known = isKnownToken(text, vocabSet);
      const tok = h('span', {
        class: 'tok', role: 'button', tabindex: '0', 'data-known': String(known), 'data-word': text,
        'data-testid': 'tok', 'aria-label': `${text}: show meaning`,
        onclick: (e) => { e.stopPropagation(); openPopover(tok, text, s.cp.slice(a, b)); },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); openPopover(tok, text, s.cp.slice(a, b)); } },
      });
      // Two-row grid: hanzi on top, its pinyin (from `cp`) underneath, one column per char.
      for (let k = a; k < b; k++) {
        const py = s.cp[k] || '';
        tok.append(h('span', { class: `hz${tc ? ` t${toneOf(py)}` : ''}` }, s.chars[k]));
        if (showPy) tok.append(h('span', { class: `py${tc ? ` t${toneOf(py)}` : ''}`, lang: 'zh-Latn-pinyin' }, numericToMarks(py)));
      }
      wrap.append(tok);
    });
    const box = h('div', { class: 'answer sentence-answer', 'data-testid': 'answer' }, wrap,
      s.en && settings.showTranslation !== false
        ? h('p', { class: 'translation center', 'data-testid': 'translation', lang: 'en' }, s.en,
          h('span', { class: 'muted small mt-label' }, ' · machine translation'))
        : null,
      h('div', { class: 'card-tools' }, h('span', { class: 'muted small' }, 'Tap a word for its meaning'), pinyinToggle()));
    box.addEventListener('click', (e) => { if (!e.target.closest('.popover')) closePopover(); });
    return box;
  }

  function openPopover(tokEl, text, cps) {
    closePopover();
    const w = data.lookup(text);
    const inVocab = state.vocab.has(text) || (w && state.vocab.has(w.s));
    const pinyin = w ? w.p : cps.join(' ');
    const defs = w ? glossList(w.d) : [];
    const addBtn = inVocab
      ? h('span', { class: 'muted small' }, 'In your vocab ✓')
      : h('button', {
        class: 'btn small', type: 'button', 'data-testid': 'popover-add', 'aria-label': `Add ${text} to vocab`,
        onclick: async (e) => {
          e.stopPropagation();
          await state.addVocab([{ s: w ? w.s : text, t: w && w.t !== w.s ? w.t : undefined, p: pinyin }], 'import', 'From sentences');
          app.toast(`Added ${text}`);
          tokEl.dataset.known = 'true';
          closePopover();
        },
      }, '+ Add to vocab');
    popover = h('div', { class: 'popover', role: 'dialog', 'aria-label': `Meaning of ${text}`, 'data-testid': 'popover' },
      h('div', { class: 'pop-head' },
        h('span', { class: 'pop-hz', lang: 'zh-Hans' }, text),
        pinyinEl(pinyin, { toneColors: settings.toneColors }),
        h('button', { class: 'icon-btn small', type: 'button', 'aria-label': 'Close', onclick: (e) => { e.stopPropagation(); closePopover(); } }, '✕')),
      defs.length ? h('ul', { class: 'defs' }, defs.slice(0, 3).map((d) => h('li', {}, d))) : h('p', { class: 'muted' }, 'no definition'),
      h('div', { class: 'pop-foot' }, w && w.hsk ? h('span', { class: 'badge' }, `HSK ${w.hsk}`) : h('span'), addBtn));
    cardArea.append(popover);
    // Anchor below the token, clamped inside the card area.
    const area = cardArea.getBoundingClientRect();
    const r = tokEl.getBoundingClientRect();
    const width = Math.min(320, area.width - 16);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(8, Math.min(area.width - width - 8, r.left - area.left + r.width / 2 - width / 2))}px`;
    popover.style.top = `${r.bottom - area.top + cardArea.scrollTop + 8}px`;
  }

  // ---- Summary / empty ------------------------------------------------------------------------
  function showSummary() {
    closePopover();
    player.stop();
    item = null; clip = null;
    clear(cardArea); clear(actions);
    cardArea.classList.remove('revealed');
    updateCounter();
    const graded = session.done;
    const accuracy = graded ? Math.round(((graded - session.again) / graded) * 100) : 0;
    if (!graded) {
      cardArea.append(h('div', { class: 'summary', 'data-testid': 'summary' },
        h('h2', {}, session.queue.length ? 'Session ended' : 'Nothing due right now'),
        h('p', { class: 'muted' }, session.queue.length ? '' : 'You are all caught up for today. Study extra new cards, or import more words.')));
    } else {
      cardArea.append(h('div', { class: 'summary', 'data-testid': 'summary' },
        h('h2', {}, 'Nice work'),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('strong', { 'data-testid': 'summary-done' }, String(graded)), h('span', { class: 'muted small' }, 'cards')),
          h('div', { class: 'stat' }, h('strong', {}, `${accuracy}%`), h('span', { class: 'muted small' }, 'not “Again”')),
          h('div', { class: 'stat' }, h('strong', {}, formatDuration(Date.now() - session.startedAt)), h('span', { class: 'muted small' }, 'time')))));
    }
    actions.append(h('div', { class: 'row gap' },
      h('button', {
        class: 'btn primary grow', type: 'button', 'data-testid': 'study-more', 'aria-label': 'Study more',
        onclick: () => {
          const q = state.buildQueue(mode, { extra: true });
          if (!q.length) { app.toast(`No more ${modeInfo.label.toLowerCase()} to study — import more words`); return; }
          app.toast(`${plural(q.length, 'more card')}`);
          session.queue = q; session.pos = 0; session.done = 0; session.again = 0; session.startedAt = Date.now();
          showCard();
        },
      }, 'Study more'),
      h('a', { class: 'btn grow', href: '#/', 'data-testid': 'study-home', 'aria-label': 'Home' }, 'Home')));
  }

  // ---- Keyboard: space = play/pause, Enter = reveal, ← = back 1 s (shift: 5 s, alt: 0.1 s),
  //      r = restart, [ ] = slower / faster, 1–4 = grade --------------------------------------
  const onKey = (e) => {
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || !item) return;
    if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'Enter' && !revealed && e.target === document.body) { e.preventDefault(); reveal(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); player.seekBy(e.shiftKey ? -5 : e.altKey ? -0.1 : -1); }
    else if (e.key === 'r' || e.key === 'R') playCurrent();
    else if (e.key === '[' || e.key === ']') {
      const i = RATES.findIndex((r) => Math.abs(r - player.rate) < 1e-6);
      const j = Math.min(RATES.length - 1, Math.max(0, (i < 0 ? RATES.indexOf(1) : i) + (e.key === ']' ? 1 : -1)));
      setRate(RATES[j]);
    }
    else if (revealed) { const g = GRADES.find((x) => x.key === e.key); if (g) { e.preventDefault(); grade(g.id); } }
  };
  document.addEventListener('keydown', onKey);

  // Copying a selection that lies inside a sentence yields just the characters, in order, with
  // no pinyin interleaved, so the text can be pasted straight into a translator or dictionary.
  const onCopy = (e) => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const sentence = cardArea.querySelector('[data-testid=sentence]');
    if (!sentence || !sentence.contains(range.commonAncestorContainer) && range.commonAncestorContainer !== sentence
      && !(range.intersectsNode(sentence) && cardArea.contains(range.commonAncestorContainer))) return;
    const text = [...sentence.querySelectorAll('.hz')].filter((el) => range.intersectsNode(el)).map((el) => el.textContent).join('');
    if (!text) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);

  // Warm the cache for the first 10 cards (offline "waiting in line" use), then show card 1.
  for (const it of session.queue.slice(0, 10)) { const c = clipFor(it); if (c) preload(data.clipUrl(c.file)); }
  showCard();

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('click', onDocClick);
    unsubscribe();
    player.stop();
    app.session = null;
  };
}
