// contract.test.mjs — validates data bundles against the §4 data contract of docs/PLAN.md.
// Always checks the fixture (tests/fixtures/data); also checks site/data when it exists, so a
// pipeline build that would break the app fails `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join('_');

function checkBundle(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(manifest.builtAt)), 'builtAt is ISO date');
  assert.equal(typeof manifest.baseUrl, 'string');
  assert.ok(Array.isArray(manifest.sources) && manifest.sources.length >= 1);
  for (const s of manifest.sources) {
    for (const k of ['id', 'name', 'license', 'url', 'kind']) assert.equal(typeof s[k], 'string', `source.${k}`);
    assert.equal(typeof s.synthetic, 'boolean');
  }
  const files = manifest.files || { words: 'words.json', sentences: 'sentences.json' };
  const words = JSON.parse(readFileSync(join(dir, files.words), 'utf8'));
  const sentences = JSON.parse(readFileSync(join(dir, files.sentences), 'utf8'));
  assert.equal(manifest.counts.words, words.length, 'counts.words');
  assert.equal(manifest.counts.sentences, sentences.length, 'counts.sentences');
  const local = !manifest.baseUrl;

  const ids = new Set(); const ss = new Set();
  for (const w of words) {
    assert.equal(w.id, `w_${hex(w.s)}`, `word id for ${w.s}`);
    assert.ok(!ids.has(w.id), `duplicate ${w.id}`); ids.add(w.id);
    assert.ok(!ss.has(w.s), `duplicate s ${w.s}`); ss.add(w.s);
    assert.equal(typeof w.t, 'string');
    assert.equal(typeof w.p, 'string');
    assert.ok(Array.isArray(w.d) && w.d.length <= 3, `d for ${w.s}`);
    assert.ok(Number.isInteger(w.hsk) && w.hsk >= 0 && w.hsk <= 6, `hsk for ${w.s}`);
    assert.ok(Array.isArray(w.clips) && w.clips.length >= 1, `clips for ${w.s}`);
    for (const c of w.clips) {
      assert.equal(typeof c.id, 'string');
      assert.match(c.file, /^clips\/.+\.mp3$/, 'clip.file relative to data dir');
      assert.ok(Number.isFinite(c.ms) && c.ms > 0 && c.ms <= 8000, `ms for ${c.id}`);
      if (local) assert.ok(existsSync(join(dir, c.file)), `missing ${c.file}`);
    }
  }
  const sids = new Set();
  for (const s of sentences) {
    assert.match(s.id, /^s_/);
    assert.ok(!sids.has(s.id)); sids.add(s.id);
    assert.equal(s.chars.length, s.cp.length, `${s.id} chars/cp`);
    assert.equal(s.chars.length, s.text.length, `${s.id} chars/text`);
    assert.equal(s.chars.join(''), s.text);
    let pos = 0;
    for (const [a, b] of s.tokens) { assert.equal(a, pos, `${s.id} tokens tile`); assert.ok(b > a); pos = b; }
    assert.equal(pos, s.text.length, `${s.id} tokens cover text`);
    assert.match(s.clip.file, /^clips\/.+\.mp3$/);
    assert.ok(s.clip.ms > 0 && s.clip.ms <= 8000, `${s.id} ms`);
    if (local) assert.ok(existsSync(join(dir, s.clip.file)), `missing ${s.clip.file}`);
  }
  return { words, sentences };
}

test('fixture bundle follows the §4 data contract', () => {
  const { words, sentences } = checkBundle(join(REPO, 'tests/fixtures/data'));
  assert.ok(words.length >= 12 && sentences.length >= 4);
  for (const s of ['学习', '朋友', '图书馆']) assert.ok(words.some((w) => w.s === s), s);
  const f = join(REPO, 'tests/fixtures/data', words[0].clips[0].file);
  assert.equal(readFileSync(f).subarray(0, 3).toString('latin1') === 'ID3' || readFileSync(f)[0] === 0xff, true, 'clip is an MP3');
  assert.ok(statSync(f).size > 100);
});

const REAL = join(REPO, 'site/data');
test('site/data bundle (if present) follows the §4 data contract', { skip: !existsSync(join(REAL, 'manifest.json')) && 'site/data not built' }, () => {
  checkBundle(REAL);
});
