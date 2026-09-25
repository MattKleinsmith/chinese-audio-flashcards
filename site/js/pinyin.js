// pinyin.js — pure pinyin helpers (no DOM).
// - numericToMarks("xue2 xi2") → "xué xí"   (tone-number → tone-mark conversion)
// - toneOf(syllable)            → 1..5       (works on numeric or tone-marked syllables)
// - pinyinSegments(p)           → [{ text, tone }] for tone-coloured rendering
// - stripTones(p)               → "xuexi"    (search normalisation)
// Unit-tested in tests/unit/pinyin.test.mjs.

// Combining diacritics for tones 1–4 (macron, acute, caron, grave). We insert the combining
// mark after the target letter and NFC-normalise, which yields the precomposed characters
// (ā, ǘ, …) and still works for rare syllables like m2 / n3 that have no precomposed vowel.
const COMBINING = ['\u0304', '\u0301', '\u030C', '\u0300'];
const VOWELS = 'aeiouü';

/** Normalise the ASCII spellings of ü ("v", "u:") to "ü", preserving case. */
function normaliseU(s) {
  return s.replace(/u:/g, 'ü').replace(/U:/g, 'Ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
}

/**
 * Convert one syllable (letters only, no tone digit) plus a tone number into tone-marked form.
 * Tone 0 or 5 (neutral) returns the syllable without a mark.
 * Placement rules: a/e take the mark; in "ou" the o takes it; otherwise the last vowel.
 * Syllables with no vowel (m, n, ng, r) put the mark on the first letter.
 */
export function syllableToMarks(syl, tone) {
  const base = normaliseU(String(syl));
  const t = Number(tone) || 0;
  if (t < 1 || t > 4) return base;
  const lower = base.toLowerCase();
  let idx = lower.search(/[ae]/);
  if (idx === -1) idx = lower.indexOf('ou');
  if (idx === -1) {
    for (let i = lower.length - 1; i >= 0; i--) {
      if (VOWELS.includes(lower[i])) { idx = i; break; }
    }
  }
  if (idx === -1) idx = 0; // m2, n3, ng4, r5 …
  return (base.slice(0, idx + 1) + COMBINING[t - 1] + base.slice(idx + 1)).normalize('NFC');
}

/**
 * Convert a numeric-tone pinyin string to tone marks. Handles space-separated syllables
 * ("xue2 xi2"), concatenated ones ("xue2xi2"), "v"/"u:" for ü and tone 5/0 as neutral.
 * Text that is already tone-marked passes through unchanged.
 */
export function numericToMarks(p) {
  return String(p ?? '').replace(/([A-Za-zÜü]+(?::[A-Za-z]*)?)([0-5])?/g, (m, syl, tone) => {
    // Without a tone digit only the unambiguous "u:" spelling is rewritten; a bare "v" could be
    // an English letter, so it is left alone.
    if (tone === undefined) return /u:/i.test(syl) ? normaliseU(syl) : syl;
    return syllableToMarks(syl, Number(tone));
  });
}

/** Tone number (1–5) of a single syllable, numeric or tone-marked. Unknown → 5. */
export function toneOf(syl) {
  const s = String(syl ?? '');
  const digit = s.match(/([0-5])\s*$/);
  if (digit) return digit[1] === '0' ? 5 : Number(digit[1]);
  const nfd = s.normalize('NFD');
  for (let i = 0; i < COMBINING.length; i++) {
    if (nfd.includes(COMBINING[i])) return i + 1;
  }
  return 5;
}

/**
 * Split a pinyin string into display segments with tones, for tone colouring.
 * Numeric input is converted to marks. Separators (spaces) are kept as tone-less segments
 * (tone 0) so the caller can rebuild the text exactly.
 */
export function pinyinSegments(p) {
  const src = String(p ?? '').trim();
  if (!src) return [];
  const out = [];
  for (const part of src.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { out.push({ text: ' ', tone: 0 }); continue; }
    // Concatenated numeric syllables: "xue2xi2" → two segments.
    const numeric = part.match(/[A-Za-zÜü:]+[0-5]/g);
    if (numeric && numeric.join('') === part && numeric.length > 1) {
      for (const syl of numeric) out.push({ text: numericToMarks(syl), tone: toneOf(syl) });
    } else {
      out.push({ text: numericToMarks(part), tone: toneOf(part) });
    }
  }
  return out;
}

/** Search normalisation: remove tone marks/digits, spaces, apostrophes; ü→u; lowercase. */
export function stripTones(p) {
  return String(p ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/u:/gi, 'u')
    .replace(/[üv]/gi, 'u')
    .replace(/[0-5\s'’·-]/g, '')
    .toLowerCase();
}
