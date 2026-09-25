// make-fixture.mjs — regenerates the tiny test data bundle in tests/fixtures/data/.
// It follows the §4 data contract of docs/PLAN.md exactly (manifest.json, words.json,
// sentences.json, clips/…) so the app and e2e tests can run before the real pipeline output
// (site/data/) exists. Clips are short sine tones encoded as real mono MP3s.
//
// Usage: node tests/fixtures/make-fixture.mjs [--ffmpeg /path/to/ffmpeg]
// ffmpeg is found via --ffmpeg, $FFMPEG, or python3 -c "import imageio_ffmpeg; …".
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'data');

function findFfmpeg() {
  const i = process.argv.indexOf('--ffmpeg');
  if (i > 0) return process.argv[i + 1];
  if (process.env.FFMPEG) return process.env.FFMPEG;
  return execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())']).toString().trim();
}
const FFMPEG = findFfmpeg();

const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join('_');

// [simplified, traditional, numeric pinyin, glosses, hsk]
const WORDS = [
  ['我', '我', 'wo3', ['I; me; my'], 1],
  ['你', '你', 'ni3', ['you (informal)'], 1],
  ['好', '好', 'hao3', ['good; well', 'proper; good to'], 1],
  ['是', '是', 'shi4', ['is; are; am; yes; to be'], 1],
  ['的', '的', 'de5', ['of; ~\'s (possessive particle)'], 1],
  ['老师', '老師', 'lao3 shi1', ['teacher'], 1],
  ['学生', '學生', 'xue2 sheng1', ['student; schoolchild'], 1],
  ['中国', '中國', 'Zhong1 guo2', ['China'], 1],
  ['人', '人', 'ren2', ['person; people'], 1],
  ['学习', '學習', 'xue2 xi2', ['to learn; to study'], 1],
  ['朋友', '朋友', 'peng2 you5', ['friend'], 1],
  ['图书馆', '圖書館', 'tu2 shu1 guan3', ['library'], 2],
];

// Each sentence is a list of [token, [pinyin per char]]; 喜欢 is deliberately absent from
// words.json so the "no definition" popover path is exercised.
const SENTENCES = [
  ['SSB00010001', [['我', ['wo3']], ['是', ['shi4']], ['学生', ['xue2', 'sheng1']]], 'female', 'B', 'north'],
  ['SSB00020002', [['你', ['ni3']], ['是', ['shi4']], ['老师', ['lao3', 'shi1']]], 'male', 'C', 'south'],
  ['SSB00010003', [['我', ['wo3']], ['的', ['de5']], ['朋友', ['peng2', 'you5']], ['是', ['shi4']], ['中国', ['zhong1', 'guo2']], ['人', ['ren2']]], 'female', 'B', 'north'],
  ['SSB00030004', [['学生', ['xue2', 'sheng1']], ['在', ['zai4']], ['图书馆', ['tu2', 'shu1', 'guan3']], ['学习', ['xue2', 'xi2']]], 'female', 'D', 'north'],
  ['SSB00020005', [['老师', ['lao3', 'shi1']], ['喜欢', ['xi3', 'huan5']], ['图书馆', ['tu2', 'shu1', 'guan3']]], 'male', 'C', 'south'],
];

/** Encode a sine tone to MP3 and return its duration in ms. */
function tone(file, seconds, freq, rate, kbps) {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=${rate}`,
    '-af', 'volume=0.2', '-ac', '1', '-ar', String(rate), '-codec:a', 'libmp3lame', '-b:a', `${kbps}k`, file]);
  return Math.round(seconds * 1000);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const words = WORDS.map(([s, t, p, d, hsk], i) => {
  const cid = `c_acmn_${hex(s)}`;
  const file = `clips/words/${cid}.mp3`;
  const ms = tone(join(OUT, file), 0.4 + 0.15 * s.length, 330 + i * 40, 22050, 40);
  return { id: `w_${hex(s)}`, s, t, p, d, hsk, clips: [{ id: cid, src: 'audio-cmn', file, ms, speaker: 'yue-tan' }] };
});

const sentences = SENTENCES.map(([utt, toks, gender, age, accent], i) => {
  const chars = []; const cp = []; const tokens = [];
  for (const [tok, pys] of toks) {
    const start = chars.length;
    chars.push(...tok); cp.push(...pys);
    tokens.push([start, chars.length]);
  }
  const id = `s_a3_${utt}`;
  const file = `clips/sentences/${id}.mp3`;
  const ms = tone(join(OUT, file), 0.3 * chars.length, 220 + i * 30, 24000, 48);
  return { id, text: chars.join(''), chars, cp, tokens, clip: { src: 'aishell3', file, ms, speaker: utt.slice(0, 7), gender, age, accent } };
});

const manifest = {
  schemaVersion: 1,
  builtAt: '2026-09-25T00:00:00Z',
  baseUrl: '',
  counts: { words: words.length, sentences: sentences.length },
  sources: [
    { id: 'audio-cmn', name: 'audio-cmn (Yue Tan, Shtooka) — FIXTURE tones', license: 'CC BY-SA 4.0', url: 'https://github.com/hugolpz/audio-cmn', kind: 'word', synthetic: false },
    { id: 'aishell3', name: 'AISHELL-3 — FIXTURE tones', license: 'Apache-2.0', url: 'https://www.openslr.org/93/', kind: 'sentence', synthetic: false },
  ],
  files: { words: 'words.json', sentences: 'sentences.json' },
};

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(join(OUT, 'words.json'), JSON.stringify(words));
writeFileSync(join(OUT, 'sentences.json'), JSON.stringify(sentences));
console.log(`fixture written to ${OUT}: ${words.length} words, ${sentences.length} sentences`);
