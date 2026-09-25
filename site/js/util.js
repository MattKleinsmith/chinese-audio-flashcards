// util.js — small DOM and formatting helpers shared by the screens (no app state here).

import { pinyinSegments } from './pinyin.js';

/**
 * Create an element. attrs: `class`, `text`, `html` (trusted strings only), `on<event>`
 * handlers, `dataset` object, boolean/prop keys (checked, disabled, value, selected, hidden),
 * everything else via setAttribute. Children may be nodes, strings, arrays, null/false.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['checked', 'disabled', 'value', 'selected', 'hidden', 'multiple'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let toastTimer = null;
let toastShownAt = 0;
/**
 * Show a transient message at the bottom. opts.action = { label, onClick } adds a button.
 */
export function toast(message, opts = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  clear(el);
  el.append(h('span', { class: 'toast-msg', 'data-testid': 'toast', text: message }));
  if (opts.action) {
    el.append(h('button', {
      class: 'toast-action', type: 'button', 'aria-label': opts.action.label,
      onclick: () => { el.hidden = true; opts.action.onClick(); },
    }, opts.action.label));
  }
  el.hidden = false;
  toastShownAt = Date.now();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, opts.ms || 5000);
}

/** Hide the toast unless it appeared within the last `graceMs` (called on route change). */
export function dismissToast(graceMs = 800) {
  const el = document.getElementById('toast');
  if (el && !el.hidden && Date.now() - toastShownAt > graceMs) el.hidden = true;
}

/** Persistent warning banner (e.g. IndexedDB unavailable). */
export function banner(message) {
  const el = document.getElementById('banner');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
}

/** Render a pinyin string as tone-coloured spans (classes t1..t5). */
export function pinyinEl(p, { toneColors = true, className = 'pinyin' } = {}) {
  const wrap = h('span', { class: className + (toneColors ? ' tones' : ''), lang: 'zh-Latn-pinyin' });
  for (const seg of pinyinSegments(p)) {
    if (!seg.tone) wrap.append(seg.text);
    else wrap.append(h('span', { class: `t${seg.tone}`, text: seg.text }));
  }
  return wrap;
}

/** Read a File as UTF-8 text. */
export function readFileText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** Trigger a download of a JSON object. */
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

/** YYYYMMDD in local time. */
export function ymd(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

/** "3 min", "45 s" — session time for the summary screen. */
export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${s % 60} s`;
}

/** Plural helper: plural(3, 'word') → "3 words". */
export function plural(n, word, pluralWord = word + 's') {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Debounce a function. */
export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Definitions may be an array (words.json) or a string (imported). */
export function glossList(d) {
  if (!d) return [];
  return (Array.isArray(d) ? d : [d]).filter(Boolean);
}
