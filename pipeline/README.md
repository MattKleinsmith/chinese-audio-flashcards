# Data pipeline

Builds the audio bundle the web app loads from `site/data/`:

```
site/data/manifest.json      schema version, build time, baseUrl, counts, sources + licences
site/data/words.json         one entry per word with a clip (audio-cmn + CC-CEDICT + HSK level)
site/data/sentences.json     AISHELL-3 sentences: text, per-char pinyin, jieba token spans
site/data/clips/words/c_acmn_<hex>.mp3        22.05 kHz mono MP3, 40 kb/s
site/data/clips/sentences/s_a3_<UTT>.mp3      24 kHz mono MP3, 48 kb/s
```

The data contract is `docs/PLAN.md` §4; `validate.py` checks every invariant of it.

## Setup

System pip cannot build jieba on this Debian image, so always use a venv:

```sh
python3 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements.txt
```

`imageio-ffmpeg` ships a static ffmpeg (with libmp3lame); there is no ffprobe, so durations
are measured by decoding (`common.measure_ms`). Set `$FFMPEG` to use another binary.

## Build the committed bundle

The committed bundle was built from a 3,000,000,001-byte **prefix** of the AISHELL-3 tarball
(it contains `test/content.txt` and 15,757 of the test-set WAVs before it is cut off):

```sh
# one-off: the first 3 GB of the 19 GB tarball (a byte-range prefix is enough)
curl -r 0-3000000000 -o pipeline/work/aishell3_head.tgz \
     https://openslr.elda.org/resources/93/data_aishell3.tgz

pipeline/.venv/bin/python pipeline/build.py \
    --aishell3-tar pipeline/work/aishell3_head.tgz --max-sentences 2000 --min-sentence-ms 1000
pipeline/.venv/bin/python pipeline/validate.py --trim-check 40
pipeline/.venv/bin/python -m unittest discover -s pipeline/tests -v
```

`build.py` also downloads CC-CEDICT and sparse-clones `hugolpz/audio-cmn` (64k/hsk + lists)
into `pipeline/work/` (git-ignored) if they are missing. A clean build takes about 2 minutes on
4 cores; re-runs reuse every clip and the AISHELL-3 stream index and finish in ~20 s. `--force`
re-encodes everything. Output that is no longer referenced is pruned. `builtAt` in the manifest
only changes when words.json / sentences.json actually change. The build fails (exit 1) if
`site/data/clips` exceeds 150 MB.

### What the build does

1. **CC-CEDICT** → `{simplified: entries}`.
2. **audio-cmn words** (`sources/audio_cmn.py`): every `64k/hsk/cmn-<w>.mp3` whose name has
   no `_`/`(` (27 pattern files such as `一_也_` are skipped) and that has a CEDICT or HSK match
   (6 misspelled filenames have neither). The CEDICT reading is chosen by: one valid syllable
   per character > common noun (lowercase pinyin) > agrees with pypinyin's reading of the word
   > has real glosses. Glosses drop `CL:` classifier lines and, when other glosses exist,
   `variant of` / `surname` / `old variant` / `see …`; a word whose only gloss is a
   cross-reference (`erhua variant of 一點|一点[yi1 dian3]`) gets the referenced entry's
   glosses. ≤ 3 glosses, each ≤ 120 chars. HSK level = lowest `lists/HSK2012_n.txt` it is in.
3. **Transcript-only candidates** (`select_sentences.py`): each transcript is tokenised with
   `jieba.lcut(text, HMM=True)`; coverage = share of tokens in HSK 1–6 ∪ `ALWAYS_KNOWN`.
4. **AISHELL-3 streaming pass** (`sources/aishell3.py`): one pass over the tarball in
   `tarfile` `r|gz` mode; the truncated tail (`ReadError`/`EOFError`) is treated as the end.
   `content.txt` precedes its WAVs, so each WAV is kept (written to `work/aishell3/wav/`) or
   skipped as it streams by; kept = has a usable transcript and coverage ≥ 0.70 (the lowest
   selection tier). The index is cached in `work/aishell3/index.json`.
5. **Selection** among candidates with audio, greedy: score = coverage·10 − 0.5·maxLevel −
   0.05·len + 2·(new HSK tokens); ≤ 40 per speaker. Only coverage ≥ 0.85 is admitted first;
   if that cannot fill `--max-sentences`, tiers 0.80, 0.75, 0.70 are admitted in turn and, last,
   the speaker cap is doubled. Every relaxation is logged.
6. **Encode** selected WAVs; clips outside 1.5–8 s after trimming are rejected and the
   selection is re-run without them until stable.
7. Write minified JSON, print the summary (counts, bytes, HSK words with/without audio,
   sentences per max HSK level, speakers, gender, clip durations).

### Conventions

- **Pinyin** (`words.json` `p`, `sentences.json` `cp`): lowercase, numeric tones 1–5
  (5 = neutral), syllables separated by one space, **`v` for ü** — CEDICT's `u:` is converted
  (`lu:4` → `lv4`, 旅行 → `lv3 xing2`), pypinyin fallback uses `Style.TONE3` with
  `neutral_tone_with_five=True`, AISHELL-3 already uses `v` (`nv3`). Erhua appears as a separate
  `r5` syllable in CEDICT words (一会儿 → `yi1 hui4 r5`). AISHELL-3 `cp` has tone sandhi applied
  (一 yi2/yi4, 不 bu2) — it is what the speaker said. `common.numeric_to_marks` is a reference
  implementation of the tone-mark conversion.
- **IDs** are derived from content, never from enumeration order: word `w_<hex>_<hex>…`
  (codepoints of the simplified form), word clip `c_acmn_<hex>…`, sentence `s_a3_<UTT>`.
- **Silence trimming** (PLAN §6.1): `silenceremove` at −45 dB keeping 50 ms before the first
  sound and 150 ms after the last, then `apad=pad_dur=0.08`. Speech is never cut:
  `validate.py --trim-check N` re-encodes a sample *without* trimming and confirms the span
  louder than −40 dBFS is unchanged (±30 ms). Some audio-cmn files have a noise floor
  near −45 dB, so up to ~250 ms of quiet lead-in can remain on a few word clips.
- MP3s are encoded with `-fflags +bitexact`, no ID3 tags: rebuilds are byte-identical.
- **`ALWAYS_KNOWN`** lives in `always_known.py` (and `always_known.json`, regenerated by
  running `always_known.py`). It must equal `ALWAYS_KNOWN` in `site/js/queue.js`;
  `tests/test_pipeline.py` compares them.

### Rejected AISHELL-3 transcripts

Lines with non-Han characters, pinyin that is not a numeric-tone syllable, odd token counts,
fewer than 4 or more than 22 characters, and **erhua** lines (`点儿 dianr3` is one syllable for
two characters, which would break `chars.length === cp.length === text.length`; ~2 % of lines).

## Full local build (not committed)

Download the whole 19 GB tarball (`https://openslr.elda.org/resources/93/data_aishell3.tgz`,
~10 MB/s from the EU mirror; `openslr.trmal.net` is a second mirror). It holds 88,035
utterances (test + train); expect ~60k usable sentences. Candidate WAVs are kept on disk in
`pipeline/work/aishell3/wav/` (roughly a quarter of the corpus, several GB). Then:

```sh
pipeline/.venv/bin/python pipeline/build.py --aishell3-tar data_aishell3.tgz \
    --max-sentences 20000 --out-dir /some/dir/data --base-url https://my-host.example/data/ \
    --max-bytes 2000000000
```

and upload `clips/` to a static host (GitHub Release asset, R2/S3 bucket). `baseUrl` in the
manifest is the prefix the app puts in front of every `clips/…` path, so the JSON can stay in
the repo while the audio lives elsewhere. Keep `site/data` itself under 150 MB.

## Tatoeba (opt-in, licence caveat)

`sources/tatoeba.py` fetches Mandarin sentence audio from Tatoeba, but **~98 % of those clips
have no licence recorded**, which Tatoeba treats as "may only be used on Tatoeba" (all 1,635
usable clips by `fucongcong`, the mainland/simplified speaker, are unlicensed). So:

- It is off by default. `build.py --with-tatoeba` **refuses** to run without `--private-build`.
- `--private-build` writes a complete, self-contained bundle to `site/data-private/`
  (git-ignored) instead of `site/data`; clips carry `license`, `redistributable: false` and an
  attribution URL. Never commit it. To use it locally, serve a copy of `site/` whose `data/` is
  replaced by `data-private/`.
- Only `fucongcong` (simplified) is used unless `--include-traditional` (adds `LeviHighway`,
  Taiwanese Mandarin, traditional characters). Requests are 0.5 s apart with an identifying
  User-Agent; `--tatoeba-max` caps the download (default 200).
- Smoke test (downloads the two exports and ≤ 3 clips into `work/tatoeba/`):
  `pipeline/.venv/bin/python pipeline/sources/tatoeba.py --smoke 3`.

## Future sources

- **AISHELL-1** (SLR33, Apache-2.0, 15.6 GB, 400 speakers) and **THCHS-30** (SLR18,
  Apache-2.0, 6.4 GB): more sentence voices; same streaming approach.
- **Wikimedia Commons / Lingua Libre** (`Zh-<word>.ogg`, `LL-Q9192 (cmn)-…`, CC BY-SA): more
  *word* voices. The Commons API rate-limits shared IPs (HTTP 429); needs a polite,
  User-Agent-identified ≤ 1 req/s fetcher or the Commons dumps. Transcode Ogg → MP3 (iOS).
- **Common Voice zh-CN** via Hugging Face (needs an access token; CC0).
- **Forced alignment** with Montreal Forced Aligner (`mandarin_mfa`) to cut word clips out of
  AISHELL-3 sentences — multi-speaker word audio for words audio-cmn lacks (~576 HSK words).
- **TTS** via `sources/tts_stub.py` (interface only; raises `NotImplementedError`). Any TTS clip
  must set `synthetic: true` so the app can badge it.
- CC BY-NC-ND corpora (MagicData SLR68, ST-CMDS SLR38, Primewords SLR47) are usable privately,
  but "NoDerivatives" makes clipping and redistribution questionable — private builds only.

## Files

| File | Purpose |
|---|---|
| `build.py` | orchestrates the build (PLAN §6.6) |
| `validate.py` | contract checks + summary; `--trim-check N` |
| `common.py` | ffmpeg, `encode_mp3`, `measure_ms`, MP3 header parser, ids, pinyin helpers |
| `cedict.py` | CC-CEDICT download/parse/reading choice |
| `select_sentences.py` | coverage analysis and greedy selection |
| `always_known.py` / `.json` | the `ALWAYS_KNOWN` stoplist |
| `sources/audio_cmn.py`, `sources/aishell3.py` | the two committed sources |
| `sources/tatoeba.py`, `sources/tts_stub.py` | opt-in / stub sources |
| `tests/test_pipeline.py` | unit tests (no network, no corpus files) |

## Licences of the generated data

- Word audio: audio-cmn by Yue Tan (Shtooka project), **CC BY-SA 4.0** — attribution required.
- Sentence audio and transcripts: AISHELL-3, Beijing Shell Shell Technology, **Apache-2.0**.
- Definitions: CC-CEDICT, **CC BY-SA 4.0**.
