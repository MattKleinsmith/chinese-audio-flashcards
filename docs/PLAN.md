# Chinese Listening Flashcards — Implementation Plan

Status: authoritative spec for v1. Written for an implementer who has not read the
conversation that produced it. Every "MUST" is a hard requirement; "SHOULD" is a strong
default; "MAY" is optional.

---

## 0. The problem being solved

The user studies Chinese vocabulary in Hack Chinese (character → pinyin/meaning flashcards)
and their vocabulary is growing fast, but they cannot recognise those same words when a
native speaker says them at normal speed. Reading gives unlimited thinking time; listening
does not. They want **listening reps in flashcard form**: micro-sessions they can do while
waiting in line, where even one card is a win.

Constraints the user stated:

1. Works on their phone. A mobile web app is fine. Local-only (no server) is fine.
2. Card format, v1: **front = an audio clip of a native speaker**; **back = Chinese
   characters + pinyin** (definition is a nice-to-have). Other modes can come later.
3. Audio MUST be replayable, but the UI MUST NOT show the clip duration or a seek bar,
   because the user could accidentally memorise "the 1.3 s one is 图书馆".
4. Vocabulary comes from the user's Hack Chinese account: they export their lists and import
   them here. Single user; no accounts.
5. **Real human speech is strongly preferred over TTS.** The user believes listening to
   synthetic voices trains a different skill. Free/openly-licensed corpora with reliable
   transcripts are the preferred source. Private, non-commercial use.
6. No long dialogues or multi-minute commitments; short clips only.
7. The user expects an easy manual test: a GitHub Pages URL that uses local storage.

---

## 1. Verified facts (research already done — do not redo)

### 1.1 Hack Chinese export
- Hack Chinese exports **per list**: open a list → *List Options* (⋮) → *Export*.
  (Source: hackchinese.com/study-guide/exporting-lists.) The exact file format is not
  documented publicly. Assume a CSV/TSV/TXT with some subset of: simplified, traditional,
  pinyin, definition/English, and possibly status columns. The importer MUST therefore be
  format-agnostic (see §5.3). Hack Chinese's own *importer* accepts one word per line or a
  CSV with a `simplified` (or `traditional`) column, so users' files may also look like that.
- There is no single "all known words" export; the user may import several list files. Imports
  MUST be additive (union) and idempotent (re-importing the same word is a no-op).

### 1.2 Word-level audio: `hugolpz/audio-cmn` (GitHub)
- 8,596 MP3 files, one per HSK (2000 list) word/character, path `64k/hsk/cmn-<hanzi>.mp3`
  (also `96k/`, `24k-abr/`, `18k-abr/`). Speaker: Yue Tan, a native speaker, recorded for the
  Shtooka project. Licence **CC BY-SA**. 64 kb/s mono 22.05 kHz, ~1.0–1.5 s each, ~10.7 KB avg,
  103 MB total for `64k/hsk`.
- 27 filenames contain variants like `cmn-一_也_.mp3` (patterns such as 一…也). Skip files whose
  name contains `_` or `(` in v1.
- Coverage check done: 学习 朋友 电脑 因为 虽然 突然 环境 经济 咖啡 高兴 医院 图书馆 一 不 的 all
  present; 你好 missing (it is not an HSK list entry). Expect ~90% coverage of HSK 1–6
  vocabulary; ~582 HSK-2012 words are known to be missing.
- Fetch with a sparse clone (verified working through this container's proxy):
  ```
  git clone --depth 1 --filter=blob:none --sparse https://github.com/hugolpz/audio-cmn.git
  cd audio-cmn && git sparse-checkout set 64k/hsk lists
  ```
  `lists/HSK2012_1.txt` … `HSK2012_6.txt` give HSK 2.0 levels (first line is a header like
  `HSK1`, then one word per line; 150/151/300/600/1300/2500 lines).

### 1.3 Sentence-level audio: AISHELL-3 (OpenSLR SLR93)
- 88,035 utterances, 218 native Mandarin speakers (175 f / 43 m), 44.1 kHz 16-bit mono PCM WAV,
  quiet studio, emotion-neutral **read speech** (news-like sentences, 5–25 characters).
  Licence **Apache 2.0** (commercial use allowed). Transcript accuracy > 98 %.
- Download: `https://openslr.elda.org/resources/93/data_aishell3.tgz` (19.06 GB; EU mirror
  ~10 MB/s from here; `openslr.trmal.net` ~6.5 MB/s). It is a gzip tar whose entries are ordered:
  `ChangeLog, phone_set.txt, ReadMe.txt, spk-info.txt, test/content.txt, test/wav/SSB*/…` then
  `train/…`. **So a byte-range prefix of the tarball is usable**: `tar` extracts whatever
  complete entries the prefix contains and errors only at the truncated tail. A 3 GB prefix
  (already downloaded in this session to the scratchpad as `raw/aishell3_head.tgz`) yields
  `test/content.txt` (24,773 lines) and roughly 7,000 test-set WAVs.
- `content.txt` format (tab-separated): `SSB06930002.wav<TAB>武 wu3 术 shu4 始 shi3 终 zhong1 …`
  i.e. alternating character and numeric-tone pinyin, space separated, tone 5 = neutral.
  Tone sandhi is already applied (一 yi2/yi4, 不 bu2). Speaker id = first 7 chars of filename.
- `spk-info.txt`: `SSB1837<TAB>B<TAB>female<TAB>north` (age group A<14, B 14–25, C 26–40, D>41;
  accent region).
- Other Apache-2.0 alternatives for a bigger local build later: AISHELL-1 (SLR33, 15.6 GB,
  400 speakers, 170 h), THCHS-30 (SLR18, 6.4 GB). CC BY-NC-ND corpora (MagicData SLR68,
  ST-CMDS SLR38, Primewords SLR47) are usable privately but "NoDerivatives" makes clipping and
  redistribution questionable; treat them as opt-in.

### 1.4 Tatoeba Mandarin audio (opt-in only)
- `https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences_with_audio.tsv.bz2`
  (columns: sentence_id, audio_id, username, licence, attribution_url) lists 5,826 clips;
  audio at `https://tatoeba.org/audio/download/<audio_id>` (MP3, verified 200).
  Text in `cmn_sentences_detailed.tsv.bz2` (id, lang, text, username, …).
- 5,742 of 5,826 clips have **no licence recorded** (Tatoeba treats those as
  "may only be used on Tatoeba"); 84 are CC BY-NC 4.0. 4,066 are by `LeviHighway`
  (Taiwanese Mandarin, traditional characters), 1,676 by `fucongcong` (mainland, simplified).
  → Provide the fetcher as an **opt-in** pipeline source, default off, never commit its
  clips to the repo.

### 1.5 Dictionary
- CC-CEDICT (CC BY-SA 4.0): `https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz`
  (verified 200, 3.98 MB, 125,109 entries). Line format:
  `圖書館 图书馆 [tu2 shu1 guan3] /library/CL:家[jia1],個|个[ge4]/`.

### 1.6 Wikimedia Commons / Lingua Libre
- Commons has tens of thousands of `Zh-<word>.ogg` files and Lingua Libre `LL-Q9192 (cmn)-…`
  recordings (CC BY-SA), but the Commons API returned HTTP 429 to this container's shared egress
  IP even for single requests. Not used in v1. Document as a future word-audio source
  (needs a polite, User-Agent-identified, ≤1 req/s fetcher or the Commons dumps).

### 1.7 Tooling available in this container
- Python 3.11 with `requests`. `jieba`/`pypinyin` MUST be installed in a venv
  (`python3 -m venv .venv && .venv/bin/pip install jieba pypinyin`) — system pip cannot build
  jieba because of a Debian setuptools patch (`install_layout` AttributeError).
- No system ffmpeg; `pip install imageio-ffmpeg` provides a static binary at
  `imageio_ffmpeg.get_ffmpeg_exe()` (v7.0.2) with `libmp3lame`, `aac`, `libopus`. Verified:
  `-ac 1 -ar 24000 -codec:a libmp3lame -b:a 48k` encodes a 5 s WAV to ~30 KB.
- Node 22, Chromium at `/opt/pw-browsers/chromium` with Playwright configured
  (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). Do not run
  `playwright install`.
- `apt-get` is not available. `gh` is not available; use the GitHub MCP tools.
- Disk: ~30 GB free. Outbound network is open.

### 1.8 Deployment target
- Repo: `mattkleinsmith/chinese-audio-flashcards`, dev branch
  `claude/chinese-listening-flashcards-4kse61`. GitHub Pages is **not yet enabled**
  (`https://mattkleinsmith.github.io/chinese-audio-flashcards/` → 404). Enabling Pages is a
  repo setting the owner must click once: *Settings → Pages → Build and deployment → Source:
  GitHub Actions*. The workflow in §7 then publishes on every push to `main` (and to the dev
  branch, so the user can test before merging).

---

## 2. Product decisions (v1)

| Decision | Choice | Why |
|---|---|---|
| Platform | Static mobile-first web app (PWA), hosted on GitHub Pages, all state in the browser (IndexedDB), no server | User asked for local-only, phone, github.io |
| Framework | **None.** Vanilla ES modules, no bundler, no npm runtime deps in the app | Zero build step; the `site/` folder is the deployable |
| Card types | **Word cards** (audio-cmn) and **Sentence cards** (AISHELL-3); study modes *Words*, *Sentences*, *Mixed* | Word cards match the user's literal ask; sentence cards match the actual goal (recognising known words at speed, in context) |
| Card front | Auto-plays the clip on card entry (configurable), one big **Replay** button, no duration, no seek bar, no waveform | Requirement 3 |
| Card back | Hanzi (large) + pinyin (tone marks, coloured by tone optionally) + definition (CC-CEDICT) for word cards; for sentence cards: full sentence hanzi with tappable words, per-character pinyin below, and the definition popover of the tapped word. Audio remains replayable on the back | Requirement 2 |
| Grading | Four buttons: Again / Hard / Good / Easy. SM-2-style scheduler (see §5.5) | Familiar, simple, good enough for v1 |
| Vocabulary source | Import Hack Chinese exports (CSV/TSV/TXT, auto-detected columns) **or** pick built-in HSK 1–6 levels for instant testing | Requirement 4 + the tester needs a path with no export file |
| Which cards are studied | Word cards for every vocab word that has a clip. Sentence cards for sentences whose tokens are ≥ *comprehensibility threshold* known (default: all tokens known, setting allows 1 or 2 unknown) | "reps on words I already know", i+0/i+1 |
| Audio format | MP3, mono. Words: 22.05 kHz 40 kb/s. Sentences: 24 kHz 48 kb/s | Universally playable on iOS Safari and Android Chrome; Opus/Ogg is not safe on iOS |
| Audio hosting | Committed to the repo under `site/data/clips/`, served by Pages. `manifest.json` has a `baseUrl` so the clips can move to another host (e.g. a GitHub Release or R2 bucket) without code changes | Simple; demo bundle kept ≤ ~120 MB |
| Offline | Service worker: app shell precached; clips cached on first play (cache-first) and pre-warmed for the next 10 due cards | "Waiting in line" often means bad signal |
| Traditional characters | Not converted in v1. Words are matched on simplified. Importer keeps a `traditional` column if present and matches on it as a fallback key too | audio-cmn filenames are simplified; OpenCC tables are large |
| TTS | **Not in v1.** Pipeline has a stub interface (`pipeline/sources/tts_stub.py`) and the data model has `synthetic: true` so a future TTS source can be added and shown with a badge | User distrusts TTS but listed it as an idea |

---

## 3. Repository layout

```
/
├── README.md                     ← what it is, live URL, how to import, how to run pipeline
├── docs/PLAN.md                  ← this document
├── docs/TESTING.md               ← manual test script (phone + desktop)
├── site/                         ← the deployable static app (GitHub Pages root)
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js                     ← service worker
│   ├── icons/icon-192.png, icon-512.png, icon.svg
│   ├── css/app.css
│   ├── js/
│   │   ├── main.js               ← boot, hash router, screen switching
│   │   ├── db.js                 ← IndexedDB wrapper (promise-based, versioned)
│   │   ├── data.js               ← loads manifest/words/sentences JSON, in-memory indexes
│   │   ├── importer.js           ← parse CSV/TSV/TXT → vocab entries (pure, unit-tested)
│   │   ├── scheduler.js          ← SM-2 variant (pure, unit-tested)
│   │   ├── queue.js              ← builds today's study queue from vocab + SRS state + mode
│   │   ├── audio.js              ← AudioPlayer (single <audio>, replay, no time UI, preload)
│   │   ├── pinyin.js             ← numeric tone → tone marks; tone colouring (pure, tested)
│   │   ├── screens/
│   │   │   ├── home.js           ← due counts, Start buttons per mode, import CTA
│   │   │   ├── study.js          ← the card UI
│   │   │   ├── import.js         ← file picker / paste box / HSK quick-add, preview, confirm
│   │   │   ├── vocab.js          ← list of vocab with has-audio flag, search, delete
│   │   │   └── settings.js       ← autoplay, threshold, new cards/day, tone colours, backup
│   │   └── util.js
│   ├── vendor/                   ← nothing in v1 (keep folder for future, e.g. papaparse)
│   └── data/                     ← GENERATED by pipeline; committed
│       ├── manifest.json
│       ├── words.json
│       ├── sentences.json
│       └── clips/
│           ├── words/w00001.mp3 …
│           └── sentences/s00001.mp3 …
├── pipeline/                     ← Python; builds site/data
│   ├── README.md
│   ├── requirements.txt          ← jieba, pypinyin, imageio-ffmpeg, requests
│   ├── build.py                  ← orchestrates: sources → select → encode → manifest
│   ├── common.py                 ← ffmpeg path, encode(), ids, hashing, pinyin helpers
│   ├── cedict.py                 ← download + parse CC-CEDICT → dict[simplified] → entries
│   ├── sources/
│   │   ├── audio_cmn.py          ← word clips from hugolpz/audio-cmn
│   │   ├── aishell3.py           ← sentence clips from an AISHELL-3 tarball (full or prefix)
│   │   ├── tatoeba.py            ← OPT-IN sentence clips (default off; licence caveats)
│   │   └── tts_stub.py           ← interface only; raises NotImplementedError
│   ├── select_sentences.py       ← coverage-based sentence selection
│   └── tests/test_pipeline.py    ← unit tests for parsers/selection (no network)
├── tests/
│   ├── unit/*.test.mjs           ← node:test for importer, scheduler, pinyin, queue
│   └── e2e/smoke.mjs             ← Playwright: serve site/, import, study a card, reload
├── scripts/serve.mjs             ← `node scripts/serve.mjs` → http://localhost:8080 (site/)
├── package.json                  ← scripts: test, test:unit, test:e2e, serve. devDeps: playwright
└── .github/workflows/
    ├── ci.yml                    ← unit + e2e on push/PR
    └── pages.yml                 ← deploy site/ to GitHub Pages
```

---

## 4. Data contract (pipeline output → app input)

All JSON is UTF-8, minified. IDs are stable across rebuilds (derived from content, not
enumeration order) so that user SRS state survives data updates.

### 4.1 `site/data/manifest.json`
```json
{
  "schemaVersion": 1,
  "builtAt": "2026-09-25T16:00:00Z",
  "baseUrl": "",                      // "" = relative to manifest; else absolute URL prefix for clips/
  "counts": { "words": 8569, "sentences": 2000 },
  "sources": [
    { "id": "audio-cmn", "name": "audio-cmn (Yue Tan, Shtooka)", "license": "CC BY-SA 4.0",
      "url": "https://github.com/hugolpz/audio-cmn", "kind": "word", "synthetic": false },
    { "id": "aishell3",  "name": "AISHELL-3", "license": "Apache-2.0",
      "url": "https://www.openslr.org/93/", "kind": "sentence", "synthetic": false }
  ],
  "files": { "words": "words.json", "sentences": "sentences.json" }
}
```

### 4.2 `site/data/words.json`
An array. One entry per distinct simplified word that has at least one clip.
```json
[
  {
    "id": "w_5b66_4e60",                 // "w_" + hex codepoints of the simplified form joined by "_"
    "s": "学习",                          // simplified
    "t": "學習",                          // traditional (from CEDICT; may equal s)
    "p": "xue2 xi2",                      // numeric-tone pinyin, space separated syllables
    "d": ["to learn; to study"],          // CEDICT glosses (≤3 kept, each ≤120 chars); may be []
    "hsk": 1,                             // HSK 2.0 level 1–6, or 0 if not in lists
    "clips": [
      { "id": "c_acmn_5b66_4e60", "src": "audio-cmn", "file": "clips/words/c_acmn_5b66_4e60.mp3",
        "ms": 1360, "speaker": "yue-tan" }
    ]
  }
]
```

### 4.3 `site/data/sentences.json`
```json
[
  {
    "id": "s_a3_SSB06930002",            // "s_" + source tag + corpus utterance id
    "text": "武术始终被看作我国的国粹",
    "chars": ["武","术","始","终","被","看","作","我","国","的","国","粹"],
    "cp": ["wu3","shu4","shi3","zhong1","bei4","kan4","zuo4","wo3","guo2","de5","guo2","cui4"],
    "tokens": [[0,2],[2,4],[4,6],[6,7],[7,9],[9,10],[10,11],[11,12]],
                                          // jieba word spans as [start,end) char indexes, in order
    "clip": { "src": "aishell3", "file": "clips/sentences/s_a3_SSB06930002.mp3", "ms": 4966,
              "speaker": "SSB0693", "gender": "female", "age": "B", "accent": "north" }
  }
]
```
Optional `"en": "Wushu has always been regarded as our national treasure."` — a sentence-level
machine translation added by `pipeline/translate.py` (opus-mt-zh-en, labelled "MT" in the app).

Rules: `chars.length === cp.length === text.length` (text contains only the characters, no
punctuation — AISHELL-3 transcripts have none). Tokens tile the text exactly. The app looks
each token up in `words.json` by simplified string **and** in the user's vocab; a token is
"known" if it is in the user's vocab **or** is in a small built-in stoplist of function
characters/punctuation (`的 了 是 在 我 你 他 她 它 们 不 吗 呢 吧 啊 和 有 这 那 也 就 都 很 会 要 说`
… the exact list lives in `site/js/queue.js` as `ALWAYS_KNOWN`; keep it ≤40 items).

### 4.3b `site/data/dict.json` (optional, `manifest.files.dict`)
`{ "<simplified>": { "t"?: "<traditional>", "p": "<numeric pinyin>", "d"?: ["gloss", ...] } }` for
words without audio (sentence tokens, characters, HSK words lacking a clip, synced Hack Chinese
words). The app's lookup order is words.json → dict.json → composed from single characters.

### 4.4 Size budget for the committed demo bundle
- Word clips: all audio-cmn words with a CEDICT or HSK match, re-encoded at 40 kb/s
  (≈ 6 KB each ≈ 50 MB).
- Sentence clips: **2,000** sentences selected per §6.3 (≈ 27 KB each ≈ 55 MB).
- JSON: words ≈ 1.5 MB, sentences ≈ 0.6 MB.
- Total ≈ 110 MB. Do not exceed 150 MB in the repo. Larger builds go to another host via
  `baseUrl`.

---

## 5. Web app specification

### 5.1 General
- Mobile-first, 100 dvh layout, large touch targets (≥ 48 px), works down to 320 px wide.
  Dark and light themes via `prefers-color-scheme`. System font stack incl. `"PingFang SC",
  "Noto Sans CJK SC", "Microsoft YaHei"`. No horizontal scroll.
- Hash routing: `#/` home, `#/study/:mode` (`words|sentences|mixed`), `#/import`, `#/vocab`,
  `#/settings`. Back button works.
- All persistent state in IndexedDB (db name `clf`, version 1) via `db.js`:
  - store `vocab` (key `s` simplified): `{ s, t?, p?, d?, addedAt, source: "import"|"hsk", listName? }`
  - store `cards` (key `cardId`): `{ cardId, kind: "word"|"sentence", ref, state }` where
    `state = { due, interval, ease, reps, lapses, lastReview, status: "new"|"learning"|"review" }`
    and `cardId = "word:" + wordId | "sentence:" + sentenceId`.
  - store `reviews` (auto-increment): `{ cardId, ts, grade, elapsedMs }` (append-only log).
  - store `settings` (key `key`).
  - store `meta` (key): `{ dataBuiltAt, lastOpen, ... }`.
- `localStorage` is used only for the theme and last-used mode.
- Card state is created lazily: a `cards` row exists only after a card is first shown.

### 5.2 Home screen
- Header: app name "听力卡" / "Listening Cards" (both), settings gear.
- If `vocab` is empty: a friendly empty state with two buttons: **Import from Hack Chinese**
  and **Quick start with HSK levels**.
- Otherwise: three mode tiles (Words / Sentences / Mixed), each showing `due · new` counts, plus
  small stats: vocab size, words with audio, sentences unlocked at current threshold. A
  **Start** on a tile goes to `#/study/<mode>`.
- If `manifest.builtAt` changed since last open, show a one-line "Audio bundle updated" toast.

### 5.3 Import screen (`importer.js` is pure and unit-tested)
- Inputs: (a) file picker (`.csv,.tsv,.txt`, multiple), (b) a textarea for pasting, (c) HSK
  quick-add checkboxes (levels 1–6, from `words.json` `hsk` field).
- Parsing algorithm (`parseVocabText(text, opts) → { entries, report }`):
  1. Strip BOM. Normalise line endings. Drop empty lines.
  2. Delimiter detection: count `\t`, `,`, `;` on the first 20 non-empty lines; pick the one
     with the most consistent (mode) count ≥ 1; if none, treat each line as a single field.
  3. Quoted CSV fields (RFC 4180, including embedded newlines) MUST be handled. Write the
     parser by hand (≤ 80 lines) — no dependency.
  4. Header detection: the first row is a header if none of its cells contain CJK
     (`\p{Script=Han}`) **and** at least one cell matches
     `/^(simplified|traditional|hanzi|word|characters?|chinese|pinyin|definition|meaning|english|status|notes?|hsk)/i`.
     If a header is present, map columns by name first (`simplified|hanzi|word|chinese|characters` →
     s; `traditional` → t; `pinyin` → p; `definition|meaning|english|translation` → d).
  5. Column inference when no header or names unmatched: for each column compute the fraction of
     cells that are (i) ≥ 1 Han char and nothing but Han/·/、 → candidate `s`; (ii) pinyin-like
     (`/^[a-zA-ZüÜāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ\s'’0-5:]+$/` with at least one vowel) → candidate `p`;
     (iii) other Latin text → candidate `d`. Choose the highest-fraction column for each role;
     if two Han columns exist, the first is `s` and the second `t` unless the second contains
     more characters that are known-traditional variants (skip this refinement if complex —
     just use first = s, second = t).
  6. A cell in the `s` column may contain multiple words separated by `/`, `、`, `,` or
     whitespace — split and emit each. Trim. Strip trailing `(…)` annotations.
  7. Reject entries with no Han chars. Deduplicate within the file.
  8. `report = { total, added, duplicates, noAudio: [words], columnsUsed: {...} }`.
- Preview: show the first 20 parsed entries in a table (s / p / d) and the column mapping;
  allow the user to override which column is which via `<select>`s; then **Import N words**.
- After import: toast "Added N words · M have audio · K sentences unlocked", link to Study.
- HSK quick-add adds all `words.json` entries with that `hsk` level to `vocab`
  with `source: "hsk"`.

### 5.4 Study screen (the core)
- Top bar: back arrow, mode name, progress `done/total` for this session, a "≡" menu with
  *Skip*, *Suspend card*, *Report bad audio* (writes to `reviews` with grade `bad-audio` and
  suspends the clip).
- **Front**:
  - Big circular **Replay** button (▶︎ icon, ≥ 96 px) centered. Tapping replays from the
    start. While playing, the icon shows a subtle pulsing ring — **no elapsed time, no
    progress bar, no duration, no waveform** anywhere (this is a hard requirement; add a
    comment in the code that says so).
  - Auto-play on card entry if `settings.autoplay` (default **true**). Mobile browsers block
    autoplay before a user gesture; the first card of a session starts only after the user
    taps *Start*, which is a gesture, and the same `<audio>` element is reused for the whole
    session so subsequent `.play()` calls are allowed. Handle the `NotAllowedError` rejection by
    showing "Tap to play" on the replay button instead of crashing.
  - For sentence cards, a small label "Sentence · <speaker gender>"; for word cards "Word".
    Nothing that reveals the answer.
  - Bottom: **Show answer** button (full-width). Also tapping anywhere on the lower half of the
    card reveals.
- **Back**:
  - Word card: hanzi (very large, ≥ 56 px), pinyin with tone marks beneath (tone colours if
    enabled: 1 red, 2 green, 3 blue, 4 purple, 5 grey — the Pleco scheme, which Hack Chinese also uses),
    definition lines (max 3), HSK badge. Traditional shown small if different and setting on.
  - Sentence card: the sentence rendered as tokens (each token a `<span class="tok">` with
    `data-known="true|false"`). Under each character, its pinyin (from `cp`), in a
    ruby-like two-row layout (use CSS grid, not `<ruby>`, for consistent cross-browser
    rendering). Unknown tokens get a dotted underline. Tapping a token opens a popover with
    the CEDICT definition from `words.json` (if the token is not in `words.json`, show
    "no definition"). A **+ Add to vocab** button in the popover adds the token.
  - The Replay button stays visible (smaller) on the back.
  - Grade bar: four buttons **Again · Hard · Good · Easy**, each showing the next interval
    label (e.g. `10m`, `1d`, `3d`, `7d`). Keyboard: 1–4, space = reveal/replay.
- Session flow: the queue is built once when the session starts (`queue.js`), then
  *Again* cards are re-inserted 3–6 positions later (learning steps). Session ends when the
  queue is empty → summary screen (cards done, accuracy, time) with **Study more** (builds
  a queue of extra new cards) and **Home**.
- Preloading: `audio.js` exposes `preload(url)` which fetches the clip into the Cache API
  (`caches.open('clips-v1')`). On session start and after each grade, preload the next 3 cards'
  clips.

### 5.5 Scheduler (`scheduler.js`, pure; unit-tested)
SM-2 variant with learning steps, in minutes/days:
- New card: `status: "new"`. Grades on a new/learning card:
  - Again → interval 1 min, stays learning.
  - Hard → interval 10 min, learning.
  - Good → if first step: 10 min learning; if already at 10 min step: graduate to review with
    interval 1 day.
  - Easy → graduate, interval 4 days, ease 2.65.
- Review card (`ease` default 2.5, min 1.3):
  - Again → lapses+1, ease −0.2, interval 1 min (learning), and when it graduates again the
    interval is `max(1, round(old * 0.3))` days.
  - Hard → interval `max(old+1, old*1.2)`, ease −0.15.
  - Good → interval `old * ease`.
  - Easy → interval `old * ease * 1.3`, ease +0.15.
  - Interval cap 365 days. Add ±5 % fuzz (deterministic given a seed argument for tests).
- `due` is an epoch ms. "Due today" = `due <= endOfToday`. Day boundary at 04:00 local.
- Export functions: `gradeCard(state, grade, nowMs, rng) → newState` and
  `previewIntervals(state, nowMs) → { again, hard, good, easy }` (human labels).

### 5.6 Queue building (`queue.js`, pure; unit-tested)
Inputs: vocab set, words/sentences data, cards state, settings
(`newPerDay` default 15 words + 10 sentences, `threshold` unknown-token allowance default 0,
`mode`). Output: ordered array of `{ cardId, kind, ref }`.
1. Candidate word cards = vocab words that exist in `words.json` with ≥ 1 non-suspended clip.
2. Candidate sentence cards = sentences where `#unknownTokens ≤ threshold`, where a token is
   known iff in vocab or in `ALWAYS_KNOWN`, or is a single char that is a digit/Latin.
   Also require at least one token that is in the user's **imported** vocab (so HSK quick-add
   with tiny vocab doesn't unlock sentences made only of stoplist words).
3. Due cards first (sorted by `due`), then new cards up to today's `newPerDay` for that kind,
   choosing new sentence cards that cover the user's *least recently reviewed* vocab words
   first (score = sum over tokens of days since that word's last review; unknown-history
   words score highest), and new word cards in HSK order then insertion order.
4. `mixed` interleaves the two kinds roughly 1:1 while keeping due-before-new.
5. Cap a session at `settings.sessionSize` (default 20) cards; the summary screen's *Study more*
   builds another.

### 5.7 Vocab screen
- Searchable list (by hanzi/pinyin/definition), each row: hanzi, pinyin, audio icon (grey if no
  clip), SRS status chip, swipe/long-press → delete. Filter chips: All / No audio / Suspended.
- Bulk: "Delete all imported", "Delete HSK quick-add".

### 5.8 Settings screen
- Autoplay (on), Playback rate (1.0; options 0.85/1.0; label the slow option as "not natural
  speed"), Tone colours (on), Show traditional (off), Show definition on word back (on),
  Unknown tokens allowed in sentences (0/1/2), New words per day (15), New sentences per day
  (10), Session size (20), Day starts at (4 am).
- **Backup**: *Export everything* → downloads `clf-backup-YYYYMMDD.json` (vocab, cards,
  reviews, settings). *Restore* → file picker, replaces state after confirm.
- **Danger zone**: Reset SRS progress; Delete all data.
- About: lists `manifest.sources` with licence + link; app version; data build date.

### 5.9 PWA
- `manifest.webmanifest`: name "Listening Cards", short_name "听力卡", display standalone,
  theme colours, icons 192/512 (generate simple SVG → PNG with a Node script or commit
  hand-made PNGs; an SVG icon with a 听 glyph is fine).
- `sw.js`: on install precache app shell (`index.html`, css, js, manifest, icons, `data/*.json`);
  network-first for `data/*.json` with cache fallback; cache-first for `clips/**` in
  `clips-v1`; skipWaiting + clients.claim; bump `SHELL_VERSION` on each deploy (pages workflow
  injects the git SHA into `sw.js` via `sed`).
- `index.html` MUST work when opened from `file://` for quick local checks except for the
  service worker (guard registration with `location.protocol.startsWith('http')`).

### 5.10 Accessibility / robustness
- All buttons have `aria-label`s. Replay button announces "Replay audio" only.
- Wrap all IndexedDB and Cache API calls in try/catch; if IndexedDB is unavailable (private
  mode on old iOS), fall back to an in-memory store and show a persistent warning banner.
- Never throw on malformed data rows; skip and count them in the import report.

---

## 6. Pipeline specification (`pipeline/`)

Run with the venv Python. All scripts are idempotent and resumable (skip outputs that exist
unless `--force`). Network downloads go to `--work-dir` (default `pipeline/work/`, git-ignored).

### 6.1 `common.py`
- `ffmpeg()` → path from `imageio_ffmpeg.get_ffmpeg_exe()`.
- `encode_mp3(src, dst, *, rate_hz, kbps, trim_silence=True)`: mono, given rate, libmp3lame CBR
  `-b:a {kbps}k`, and when `trim_silence`, apply
  `-af silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse`
  then `apad=pad_dur=0.08` so clips start promptly but do not click. Return duration ms
  (parse with `ffprobe` from the same binary dir if present, else compute from the output
  size/bitrate; simplest: run ffmpeg with `-f null -` on the output and parse `time=`).
- `word_id(simplified)` → `"w_" + "_".join(f"{ord(c):x}" for c in simplified)`.
- `numeric_to_marks("xue2 xi2") → "xué xí"` (also used to sanity-check the JS implementation).

### 6.2 `sources/audio_cmn.py`
1. Sparse-clone `hugolpz/audio-cmn` into `work/audio-cmn` (skip if present).
2. For each `64k/hsk/cmn-<w>.mp3` where `<w>` has no `_`/`(`: simplified = `<w>`.
3. Look up CEDICT (`cedict.py`): if found, take traditional, numeric pinyin, glosses (drop
   entries whose gloss starts with "variant of", "surname", "old variant", "see " when other
   glosses exist; keep ≤ 3). If not found, pinyin from `pypinyin.lazy_pinyin(w, style=TONE3,
   neutral_tone_with_five=True)`, `d = []`, `t = w`.
4. HSK level from `lists/HSK2012_{n}.txt` (skip header line).
5. Encode to `site/data/clips/words/c_acmn_<hex>.mp3` at 22050 Hz, 40 kb/s.
6. Yield word entries per §4.2.

### 6.3 `sources/aishell3.py`
- Args: `--tar PATH` (full tarball or byte-range prefix), `--max-utts N`.
- Read `spk-info.txt` and `test/content.txt` (and `train/content.txt` if present) with
  `tarfile` in streaming mode (`mode="r|gz"`); tolerate `tarfile.ReadError`/`EOFError` at the
  truncated end and log how many WAVs were available.
- Because streaming a 3–19 GB gzip twice is slow, do it in **one pass**: first pass collects
  `content.txt` lines (they come before the WAVs); as each WAV entry streams by, decide
  immediately whether to keep it (it is kept iff its utterance id is in the transcript **and**
  the selection filter in `select_sentences.py` says yes — the selection is therefore
  computed **from transcripts alone** before any audio is read; see below) and write it to
  `work/aishell3/wav/`.
- Parse a transcript line into `chars` and `cp` (alternating tokens). Text = `"".join(chars)`.
  Skip lines with Latin letters or digits in `chars`, or with length < 4 or > 22 chars.
- Tokenise `text` with `jieba.lcut(text, HMM=True)` → spans.
- Speaker metadata from `spk-info.txt`.
- Encode kept WAVs to `site/data/clips/sentences/s_a3_<utt>.mp3` at 24 kHz, 48 kb/s.

### 6.4 `select_sentences.py` (transcript-only selection)
Goal: pick up to N sentences that are most useful to an HSK learner and diverse.
1. Load HSK 1–6 word set (from audio-cmn lists) ∪ `ALWAYS_KNOWN` (duplicate the JS list in
   Python; keep them in sync by a unit test that reads both files).
2. For each transcript: tokens via jieba; `coverage = #tokens in HSK1–6 / #tokens`;
   `maxLevel` = highest HSK level among tokens (7 if any token is non-HSK).
3. Keep sentences with `coverage ≥ 0.85`. Score = `coverage * 10 - 0.5 * maxLevel -
   0.05 * len(text)`; greedily pick highest score while enforcing: ≤ 40 sentences per speaker,
   and a "coverage of vocab" bonus: +2 for each HSK token that has not yet appeared in a
   selected sentence (recomputed greedily; a simple loop over sorted candidates with a
   `seen_words` set is fine).
4. Output the set of kept utterance ids; `aishell3.py` uses it as the keep-filter during the
   streaming pass. Log distribution: sentences per HSK maxLevel, speakers used, gender split.

### 6.5 `sources/tatoeba.py` (opt-in; `--with-tatoeba`)
- Download the two `.tsv.bz2` files, join, filter `username == "fucongcong"` (simplified,
  mainland) unless `--include-traditional`. Fetch MP3s politely (0.5 s delay, custom
  User-Agent). Record `license` (may be empty) in the clip metadata and set
  `redistributable: false` when empty. `build.py` MUST refuse to write non-redistributable
  clips into `site/data` unless `--private-build` is given (they then go to
  `site/data-private/`, which is git-ignored, and `baseUrl` points there for local use).

### 6.6 `build.py`
```
build.py --aishell3-tar work/aishell3_head.tgz --max-sentences 2000 [--with-tatoeba] [--force]
```
1. CEDICT → dict. 2. audio-cmn words. 3. select_sentences on transcripts. 4. aishell3 streaming
pass + encode. 5. Write `words.json`, `sentences.json`, `manifest.json`. 6. Print a summary:
counts, total bytes in `site/data/clips`, words per HSK level with/without audio, sentences
per max HSK level, speakers, gender. 7. Fail (exit 1) if `site/data/clips` > 150 MB.

### 6.7 `pipeline/README.md`
Document: venv setup, the exact build command used for the committed bundle, how to do a
**full local build** (download the full 19 GB AISHELL-3 tarball; expect ~60k usable
sentences; then set `--max-sentences 20000` and host clips elsewhere with `baseUrl`), the
Tatoeba opt-in and its licence caveat, and future sources (AISHELL-1, THCHS-30, Commons/Lingua
Libre with a polite fetcher, Common Voice zh-CN via Hugging Face with a token, forced alignment
with Montreal Forced Aligner `mandarin_mfa` to cut word clips out of sentences, TTS via the
stub with `synthetic: true`).

---

## 7. CI and deployment

### 7.1 `.github/workflows/pages.yml`
```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main, claude/chinese-listening-flashcards-4kse61]
  workflow_dispatch:
permissions: { contents: read, pages: write, id-token: write }
concurrency: { group: pages, cancel-in-progress: true }
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: ${{ steps.deployment.outputs.page_url }} }
    steps:
      - uses: actions/checkout@v4
      - run: sed -i "s/__BUILD_SHA__/${GITHUB_SHA::7}/" site/sw.js site/index.html
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with: { path: site }
      - id: deployment
        uses: actions/deploy-pages@v4
```
`site/sw.js` contains `const SHELL_VERSION = '__BUILD_SHA__';` and `index.html` shows the
short SHA in Settings → About.

### 7.2 `.github/workflows/ci.yml`
On push/PR: `npm ci`, `npm run test:unit` (node:test), `npm run test:e2e` (Playwright with
`npx playwright install --with-deps chromium` in CI only). Keep under 3 minutes.

### 7.3 Local dev
`npm run serve` → `scripts/serve.mjs` serves `site/` at `http://localhost:8080` with correct
MIME types (`.mjs/.js` → `text/javascript`, `.webmanifest` → `application/manifest+json`,
`.mp3` → `audio/mpeg`) and `Range` support for audio (required by Safari).

---

## 8. Tests

### 8.1 Unit (`tests/unit`, `node --test`)
- `importer.test.mjs`: header CSV (`simplified,pinyin,definition`), headerless TSV,
  one-word-per-line, quoted fields with commas, BOM, CRLF, multi-word cells (`朋友/朋友们`),
  traditional-only column, Anki plain-text export (tab separated, HTML stripped).
- `scheduler.test.mjs`: each grade transition above; interval cap; fuzz determinism; lapses.
- `pinyin.test.mjs`: `xue2 xi2 → xué xí`, `lv4 → lǜ`, `nv3 → nǚ`, `de5 → de`, `er2 → ér`,
  `xiong2 → xióng` (mark on o in ou/iu rules), `iu → iú`, `ui → uì`.
- `queue.test.mjs`: threshold 0 vs 1; ALWAYS_KNOWN; due-before-new; per-day caps; mixed
  interleave; imported-word requirement.

### 8.2 E2E (`tests/e2e/smoke.mjs`, Playwright, mobile viewport 390×844, headless Chromium)
1. Start `scripts/serve.mjs`. Open `/`. Expect empty state.
2. Go to Import, paste `学习\t xué xí\t to study\n朋友\tpéng you\tfriend\n图书馆`, expect preview
   shows 3 rows with correct column mapping; click Import; expect toast mentions "3".
3. Quick-add HSK 1. Home shows Words due/new > 0.
4. Start Words. Expect replay button visible, **no** element matching
   `[data-testid=duration], .progress, input[type=range], audio[controls]`. Expect the
   `<audio>` element to have `controls` absent. Click reveal → hanzi visible. Click Good.
5. Reload page → progress persisted (done count or card state via `window.__clf.debug()`).
6. Start Sentences (threshold 0 after HSK1+HSK2 quick-add → at least 1 sentence unlocked;
   if not, set threshold 2 via settings and assert ≥ 1). Reveal → tokens rendered with pinyin
   row; tap a token → popover.
7. Export backup → file downloaded, JSON parses, has `vocab` length ≥ 150.
Audio playback itself cannot be asserted headlessly; assert `audio.src` ends with `.mp3` and
the request for it returned 200 (listen to `page.on('response')`).

### 8.3 Manual (`docs/TESTING.md`)
Step-by-step for the phone: open the Pages URL, Add to Home Screen, import a Hack Chinese
export, study, toggle airplane mode and confirm cached cards still play, restore backup.

---

## 9. Implementation order (each step ends with green tests and a commit)

1. Scaffold: `package.json`, `scripts/serve.mjs`, `site/index.html` shell, `css`, router,
   `db.js`, empty screens, workflows, README stub. Commit.
2. `pinyin.js`, `scheduler.js`, `importer.js`, `queue.js` + unit tests. Commit.
3. Pipeline: `common.py`, `cedict.py`, `sources/audio_cmn.py` → words bundle. Commit data.
4. Pipeline: `select_sentences.py`, `sources/aishell3.py`, `build.py` → sentences bundle
   (2,000). Commit data.
5. Screens: home, import (with preview + HSK quick add), study (word cards), settings, vocab.
   Commit.
6. Sentence cards (token layout, popover, add-to-vocab). Commit.
7. PWA (`sw.js`, manifest, icons), preloading, backup/restore. Commit.
8. E2E smoke test; `docs/TESTING.md`; README with live URL and the one manual step (enable
   Pages). Commit, push.

---

## 10. Definition of done (v1)

- `npm test` passes locally (unit + e2e).
- `python pipeline/build.py …` reproduces `site/data` from scratch given the tarball prefix.
- `site/data/clips` ≤ 150 MB, all clips MP3 mono, no clip > 8 s.
- On a phone: import a Hack Chinese export → study words and sentences → the clip auto-plays,
  can be replayed, shows no duration/seek UI → grades persist across reloads → works offline
  for cards already played.
- README states the live URL `https://mattkleinsmith.github.io/chinese-audio-flashcards/`
  and the licences/attribution of the audio sources (CC BY-SA requires attribution: put it in
  Settings → About and in the README).

---

## 11. Known tough calls to surface to the user (do not block on them)

1. **Read speech vs. conversational speech.** AISHELL-3 is studio read speech (news-like
   sentences). It is real humans at natural pace, but not casual conversation. Conversational
   corpora (MagicData-RAMC, WenetSpeech) exist but have NC-ND licences or ASR-derived
   transcripts.
2. **Tatoeba licences.** 98 % of Mandarin Tatoeba clips have no licence recorded. We ship the
   fetcher opt-in and never commit those clips.
3. **Single word-speaker.** All word clips are one voice (Yue Tan). Sentences bring 200+
   voices. Adding Commons/Lingua Libre word recordings would add voices but needs a
   rate-limit-friendly fetcher.
4. **Traditional characters** are not converted; matching is on simplified with a traditional
   fallback from CEDICT.
5. **TTS** intentionally excluded from v1; stub exists.
6. **Repo size**: ~110 MB of MP3 committed for zero-infrastructure hosting. A bigger build
   should go to a Release asset or object storage via `baseUrl`.
7. **Enabling GitHub Pages** is a one-time click the repo owner must make.
