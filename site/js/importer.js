// importer.js — format-agnostic vocabulary import (pure; no DOM, no storage).
// Parses Hack Chinese exports, plain word lists, CSV/TSV/semicolon files and Anki plain-text
// exports into vocab entries { s, t?, p?, d? }. Spec: docs/PLAN.md §5.3.
// Unit-tested in tests/unit/importer.test.mjs.
//
// Main entry point: parseVocabText(text, opts) → { entries, report, rows, header, mapping, delimiter }
//   opts.mapping  { s, t, p, d } column indexes (null = unused) to override auto-detection
//   opts.lookup   (word) → words.json entry | undefined; used to canonicalise traditional input
//                 to simplified and to list words without audio in report.noAudio

const HAN = /\p{Script=Han}/u;
const HAN_G = /\p{Script=Han}/gu;
const NON_HAN_G = /[^\p{Script=Han}]/gu;
const HEADER_WORD = /^(simplified|traditional|hanzi|word|characters?|chinese|pinyin|definition|meaning|english|status|notes?|hsk)/i;
const PINYIN_CHARS = /^[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ\s'’0-5:]+$/;
const DELIMS = ['\t', ',', ';'];

// ---------------------------------------------------------------------------------------------
// Low-level text handling
// ---------------------------------------------------------------------------------------------

/** Strip BOM and normalise CRLF / CR line endings to LF. */
export function normaliseText(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Remove Anki file headers (#separator:tab, #html:true, …) that precede the data. */
function stripAnkiHeaders(text) {
  return text.replace(/^(#[a-z ]+:[^\n]*\n)+/i, '');
}

/**
 * Pick the delimiter whose per-line count is most consistent over the first 20 non-empty lines.
 * Quoted segments are ignored while counting. Returns null if no delimiter occurs (one field
 * per line).
 */
export function detectDelimiter(text) {
  const lines = text.split('\n').filter((l) => l.trim()).slice(0, 20)
    .map((l) => l.replace(/"(?:[^"]|"")*"/g, '""'));
  if (!lines.length) return null;
  let best = null;
  for (const d of DELIMS) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let mode = 0; let modeFreq = 0;
    for (const [c, f] of freq) if (f > modeFreq || (f === modeFreq && c > mode)) { mode = c; modeFreq = f; }
    if (mode < 1) continue;
    const consistency = modeFreq / lines.length;
    if (!best || consistency > best.consistency) best = { d, consistency };
  }
  return best ? best.d : null;
}

/**
 * RFC 4180-style parser: quoted fields, "" escapes, delimiters and newlines inside quotes.
 * With delim === null each line is a single field. Empty rows are dropped.
 */
export function parseDelimited(text, delim) {
  const rows = [];
  let row = []; let field = ''; let inQuotes = false; let fieldStart = true;
  const endField = () => { row.push(field); field = ''; fieldStart = true; };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && fieldStart && delim !== null) { inQuotes = true; fieldStart = false; continue; }
    if (delim !== null && ch === delim) { endField(); continue; }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    if (ch !== ' ') fieldStart = false;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Strip HTML tags/entities and Anki [sound:…] tags from a cell, then trim. */
export function cleanCell(cell) {
  return String(cell ?? '')
    .replace(/\[sound:[^\]]*\]/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(1), 10) || 32) : m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove trailing annotations such as "(n.)", "（量词）", "[colloquial]". */
function stripAnnotations(s) {
  let out = s;
  let prev;
  do { prev = out; out = out.replace(/\s*[(（[【][^()（）[\]【】]*[)）\]】]\s*$/u, ''); } while (out !== prev);
  return out.trim();
}

// ---------------------------------------------------------------------------------------------
// Cell classification (used for column inference)
// ---------------------------------------------------------------------------------------------

/** ≥ 1 Han char and nothing but Han and list separators (·、/ , whitespace). */
export function isHanCell(cell) {
  const c = stripAnnotations(cell);
  return HAN.test(c) && /^[\p{Script=Han}·、\/,，;；\s]+$/u.test(c);
}

// A generous set of pinyin syllables (initial × final). Some invalid combinations are accepted;
// the point is only to tell "péng you" apart from "friend" or "to study".
const INITIALS = ['', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'zh', 'ch', 'sh', 'r', 'z', 'c', 's', 'y', 'w'];
const FINALS = ['a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'ong', 'er', 'i', 'ia', 'ie', 'iao',
  'iu', 'ian', 'in', 'iang', 'ing', 'iong', 'u', 'ua', 'uo', 'uai', 'ui', 'uan', 'un', 'uang', 'ueng', 'v', 've',
  'van', 'vn', 'ue', 'io', 'ueng'];
const SYLLABLES = new Set(['m', 'n', 'ng', 'hm', 'hng', 'r']);
for (const i of INITIALS) for (const f of FINALS) SYLLABLES.add(i + f);

/** True if the letters-only string can be segmented into pinyin syllables. */
function segmentsAsPinyin(word) {
  const n = word.length;
  const ok = new Array(n + 1).fill(false);
  ok[0] = true;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 6); j < i && !ok[i]; j++) {
      if (ok[j] && SYLLABLES.has(word.slice(j, i))) ok[i] = true;
    }
  }
  return ok[n];
}

/** Pinyin-like cell: the §5.3 character regex, a vowel, and every chunk segments into syllables. */
export function isPinyinCell(cell) {
  const c = cell.trim();
  if (!c || !PINYIN_CHARS.test(c) || !/[aeiouüvāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i.test(c)) return false;
  const plain = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/u:/g, 'v').replace(/ü/g, 'v').replace(/[0-5]/g, ' ');
  return plain.split(/[\s'’:]+/).filter(Boolean).every(segmentsAsPinyin);
}

/** Contains Latin letters and no Han (definitions, notes …). */
function isLatinCell(cell) {
  return /[A-Za-z]/.test(cell) && !HAN.test(cell);
}

// ---------------------------------------------------------------------------------------------
// Header detection and column inference
// ---------------------------------------------------------------------------------------------

/** First row is a header iff no cell has Han and at least one cell names a known column. */
export function detectHeader(row) {
  if (!row || !row.length) return false;
  const cells = row.map(cleanCell);
  return !cells.some((c) => HAN.test(c)) && cells.some((c) => HEADER_WORD.test(c));
}

/** Map header names to roles; unmatched roles stay null. */
function mapHeader(header) {
  const m = { s: null, t: null, p: null, d: null };
  header.map(cleanCell).forEach((name, i) => {
    const n = name.toLowerCase();
    if (m.t === null && /^traditional/.test(n)) m.t = i;
    else if (m.s === null && /^(simplified|hanzi|word|chinese|characters?)/.test(n)) m.s = i;
    else if (m.p === null && /^pinyin/.test(n)) m.p = i;
    else if (m.d === null && /^(definition|meaning|english|translation)/.test(n)) m.d = i;
  });
  return m;
}

/**
 * Fill unmapped roles by content: Han-only column → s (second one → t), pinyin-like → p,
 * other Latin text → d. Fractions are over all sampled rows so sparse columns lose.
 */
export function inferColumns(rows, header = null) {
  const mapping = header ? mapHeader(header) : { s: null, t: null, p: null, d: null };
  const sample = rows.slice(0, 200);
  const ncols = Math.max(0, ...sample.map((r) => r.length), header ? header.length : 0);
  if (!sample.length || !ncols) return mapping;
  const used = () => new Set(Object.values(mapping).filter((v) => v !== null));
  const frac = (col, test) => sample.reduce((n, r) => n + (test(cleanCell(r[col] ?? '')) ? 1 : 0), 0) / sample.length;
  const stats = [];
  for (let c = 0; c < ncols; c++) {
    stats.push({ c, han: frac(c, isHanCell), pin: frac(c, isPinyinCell), lat: frac(c, isLatinCell) });
  }
  const pick = (key, min) => {
    const taken = used();
    let best = null;
    for (const st of stats) if (!taken.has(st.c) && st[key] >= min && (!best || st[key] > best[key])) best = st;
    return best ? best.c : null;
  };
  if (mapping.s === null && mapping.t === null) mapping.s = pick('han', 0.5);
  if (mapping.t === null && mapping.s !== null) mapping.t = pick('han', 0.5);
  if (mapping.s === null && mapping.t === null && ncols === 1) mapping.s = 0;
  if (mapping.p === null) mapping.p = pick('pin', 0.5);
  if (mapping.d === null) mapping.d = pick('lat', 0.3);
  return mapping;
}

// ---------------------------------------------------------------------------------------------
// Entry extraction
// ---------------------------------------------------------------------------------------------

/** Split a word cell ("朋友/朋友们", "你、我", "学习 (v.)") into Han-only words. */
export function splitWords(cell) {
  return stripAnnotations(cleanCell(cell))
    .split(/[\/、,，;；\s]+/u)
    .map((w) => stripAnnotations(w).replace(NON_HAN_G, ''))
    .filter(Boolean);
}

/**
 * Turn rows into entries using a mapping. Never throws on malformed rows; they are counted.
 * @returns {{ entries, duplicates, rejected }}
 */
export function extractEntries(rows, mapping, opts = {}) {
  const wordCol = mapping.s ?? mapping.t;
  const entries = []; const seen = new Set();
  let duplicates = 0; let rejected = 0;
  if (wordCol === null || wordCol === undefined) return { entries, duplicates, rejected: rows.length };
  for (const row of rows) {
    try {
      const words = splitWords(row[wordCol] ?? '');
      if (!words.length) { rejected++; continue; }
      const single = words.length === 1;
      const tradCell = mapping.t !== null && mapping.t !== undefined && mapping.t !== wordCol ? splitWords(row[mapping.t] ?? '') : [];
      for (let i = 0; i < words.length; i++) {
        let s = words[i];
        let t = tradCell[i] || (mapping.s === null || mapping.s === undefined ? s : undefined);
        const hit = opts.lookup ? opts.lookup(s) : undefined;
        if (hit && hit.s && hit.s !== s) { t = t || s; s = hit.s; } // traditional → simplified
        if (seen.has(s)) { duplicates++; continue; }
        seen.add(s);
        const e = { s };
        if (t && (t !== s || mapping.s === null || mapping.s === undefined)) e.t = t;
        if (single && mapping.p !== null && mapping.p !== undefined) {
          const p = cleanCell(row[mapping.p] ?? ''); if (p) e.p = p;
        }
        if (mapping.d !== null && mapping.d !== undefined) {
          const d = cleanCell(row[mapping.d] ?? ''); if (d && single) e.d = d;
        }
        entries.push(e);
      }
    } catch {
      rejected++;
    }
  }
  return { entries, duplicates, rejected };
}

/**
 * Parse any supported vocabulary text. See the module header for opts.
 * report = { total, added, duplicates, rejected, noAudio: [words], columnsUsed: { s, t, p, d } }
 * (added = distinct words found in this file; the caller decides what is new to the DB).
 */
export function parseVocabText(text, opts = {}) {
  const clean = stripAnkiHeaders(normaliseText(text));
  const delimiter = opts.delimiter !== undefined ? opts.delimiter : detectDelimiter(clean);
  let rows = parseDelimited(clean, delimiter);
  let header = null;
  if (rows.length && detectHeader(rows[0])) { header = rows[0].map(cleanCell); rows = rows.slice(1); }
  const mapping = opts.mapping ? { s: null, t: null, p: null, d: null, ...opts.mapping } : inferColumns(rows, header);
  const { entries, duplicates, rejected } = extractEntries(rows, mapping, opts);
  const noAudio = opts.lookup ? entries.filter((e) => !opts.lookup(e.s)).map((e) => e.s) : [];
  const columnName = (i) => (i === null || i === undefined ? null : header?.[i] || `column ${i + 1}`);
  const report = {
    total: rows.length,
    added: entries.length,
    duplicates,
    rejected,
    noAudio,
    columnsUsed: { s: columnName(mapping.s), t: columnName(mapping.t), p: columnName(mapping.p), d: columnName(mapping.d) },
  };
  return { entries, report, rows, header, mapping, delimiter };
}

/** Count Han characters (exported for UI summaries). */
export function hanCount(s) {
  return (String(s).match(HAN_G) || []).length;
}
