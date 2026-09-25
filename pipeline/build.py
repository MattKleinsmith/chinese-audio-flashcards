#!/usr/bin/env python3
"""Build site/data (manifest.json, words.json, sentences.json, clips/) — PLAN §6.6.

    pipeline/.venv/bin/python pipeline/build.py --aishell3-tar pipeline/work/aishell3_head.tgz \
        --max-sentences 2000

Steps: 1. CC-CEDICT  2. audio-cmn word clips  3. transcript-only sentence candidates
4. AISHELL-3 streaming pass + selection + encode  5. JSON  6. summary  7. size check.
Idempotent: existing clips are reused unless --force; outputs no longer referenced are pruned.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cedict as cedict_mod  # noqa: E402
import select_sentences as sel_mod  # noqa: E402
import validate as validate_mod  # noqa: E402
from always_known import ALWAYS_KNOWN  # noqa: E402
from common import (DEFAULT_OUT_DIR, DEFAULT_WORK_DIR, MAX_CLIP_MS, MAX_CLIPS_BYTES,  # noqa: E402
                    PRIVATE_OUT_DIR, SENTENCE_KBPS, SENTENCE_RATE_HZ, dir_bytes, encode_mp3,
                    log, measure_ms, sentence_id, write_json_min)
from sources import aishell3, audio_cmn  # noqa: E402

MIN_SENTENCE_MS = 1500  # "sane" sentence range is 1.5-8 s
SCHEMA_VERSION = 1


def load_cache(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_cache(path: Path, cache: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def build_sentences(args, hsk_levels: dict[str, int], out_dir: Path, cache: dict):
    """AISHELL-3: candidates -> stream -> select -> encode. Returns (entries, stats)."""
    analyses: dict[str, sel_mod.Analysis] = {}

    def keep(utt, speaker, chars, cp):
        a = sel_mod.analyze(utt, speaker, "".join(chars), hsk_levels)
        analyses[utt] = a
        return sel_mod.is_candidate(a, args.coverage_floor)

    ak_sig = hashlib.sha1(json.dumps(ALWAYS_KNOWN, ensure_ascii=False).encode()).hexdigest()[:8]
    filter_sig = f"v1;cov>={args.coverage_floor};hsk={len(hsk_levels)};ak={ak_sig}"
    idx = aishell3.stream(args.aishell3_tar, args.work_dir, keep, force=args.force,
                          filter_sig=filter_sig)
    spk = idx["spk"]
    transcripts = idx["transcripts"]

    cands = []
    too_long_raw = 0
    for utt in idx["available"]:
        chars, _cp = transcripts[utt]
        a = analyses.get(utt) or sel_mod.analyze(utt, aishell3.speaker_of(utt), "".join(chars),
                                                  hsk_levels)
        raw_ms = aishell3.wav_ms(aishell3.wav_path(args.work_dir, utt))
        # Trimming removes at most leading/trailing silence; skip WAVs that cannot fit.
        if raw_ms > MAX_CLIP_MS + 2000 or raw_ms < args.min_sentence_ms:
            too_long_raw += 1
            continue
        cands.append(a)
    n_all = len(transcripts)
    tiers = sel_mod.coverage_tiers(args.min_coverage, args.coverage_floor)
    by_tier = {t: sum(1 for a in cands if a.coverage >= t - 1e-9) for t in tiers}
    log(f"select: {n_all} usable transcripts; {len(idx['available'])} candidates (coverage >= "
        f"{args.coverage_floor}) have audio in the archive; {too_long_raw} dropped by raw "
        f"duration; candidates per coverage tier: {by_tier}")

    clip_dir = out_dir / aishell3.CLIP_SUBDIR
    rejected: dict[str, int] = {}
    ms_of: dict[str, int] = {}

    def encode_one(utt, need_file=False):
        sid = sentence_id(aishell3.TAG, utt)
        rel = f"{aishell3.CLIP_SUBDIR}/{sid}.mp3"
        dst = clip_dir / f"{sid}.mp3"
        src = aishell3.wav_path(args.work_dir, utt)
        key = f"{rel}|{src.stat().st_size}"
        if not args.force and key in cache and (dst.exists() or not need_file):
            # Reuse. During selection rounds only the (deterministic) duration is needed, so
            # a clip that is not on disk is encoded only if it makes the final selection.
            return utt, cache[key], False
        if dst.exists() and not args.force:
            ms = measure_ms(dst)
        else:
            ms = encode_mp3(src, dst, rate_hz=SENTENCE_RATE_HZ, kbps=SENTENCE_KBPS)
        cache[key] = ms
        return utt, ms, True

    def ok_ms(ms: int) -> bool:
        return args.min_sentence_ms <= ms <= MAX_CLIP_MS

    rounds = 0
    while True:
        rounds += 1
        pool = [a for a in cands if a.utt not in rejected]
        chosen = sel_mod.select(pool, args.max_sentences, args.per_speaker_cap, log=log, tiers=tiers)
        todo = [a.utt for a in chosen if a.utt not in ms_of]
        new_rejects = 0
        with ThreadPoolExecutor(max_workers=args.jobs) as ex:
            for i, (utt, ms, _enc) in enumerate(ex.map(encode_one, todo), 1):
                ms_of[utt] = ms
                if not ok_ms(ms):
                    rejected[utt] = ms
                    new_rejects += 1
                if i % 500 == 0:
                    log(f"aishell3: encoded {i}/{len(todo)} (round {rounds})")
        log(f"select round {rounds}: {len(chosen)} chosen, {len(todo)} newly encoded or looked up, "
            f"{new_rejects} rejected by duration (>{MAX_CLIP_MS} or <{args.min_sentence_ms} ms)")
        if not new_rejects:
            break
    missing = [a.utt for a in chosen
               if not (clip_dir / f"{sentence_id(aishell3.TAG, a.utt)}.mp3").exists()]
    with ThreadPoolExecutor(max_workers=args.jobs) as ex:
        for utt, ms, _enc in ex.map(lambda u: encode_one(u, need_file=True), missing):
            ms_of[utt] = ms
    for utt in rejected:
        p = clip_dir / f"{sentence_id(aishell3.TAG, utt)}.mp3"
        if p.exists():
            p.unlink()

    dist = sel_mod.distribution(chosen, spk)
    log("select: " + sel_mod.format_distribution(dist))

    entries = []
    for a in chosen:
        chars, cp = transcripts[a.utt]
        sid = sentence_id(aishell3.TAG, a.utt)
        info = spk.get(a.speaker, {})
        entries.append({
            "id": sid, "text": a.text, "chars": chars, "cp": cp, "tokens": a.tokens,
            "clip": {"src": aishell3.SOURCE["id"], "file": f"{aishell3.CLIP_SUBDIR}/{sid}.mp3",
                     "ms": ms_of[a.utt], "speaker": a.speaker,
                     "gender": info.get("gender", "unknown"), "age": info.get("age", ""),
                     "accent": info.get("accent", "")},
        })
    entries.sort(key=lambda e: e["id"])
    stats = {"transcripts": n_all, "candidates_with_audio": len(idx["available"]),
             "wavs_in_archive": idx["wavs_seen"], "truncated": idx["truncated"],
             "rejected_duration": len(rejected), "distribution": dist}
    return entries, stats


def build_tatoeba(args, out_dir: Path) -> list[dict]:
    from pypinyin import Style, lazy_pinyin

    from sources import tatoeba

    rows = tatoeba.load_rows(args.work_dir, args.include_traditional)
    rows = tatoeba.fetch(rows, args.work_dir, args.tatoeba_max)
    entries = []
    for e in tatoeba.build(rows, out_dir, private_build=args.private_build, force=args.force):
        text = e["text"]
        cp = [s.replace("ü", "v") for s in
              lazy_pinyin(text, style=Style.TONE3, neutral_tone_with_five=True)]
        if len(cp) != len(text) or e["clip"]["ms"] > MAX_CLIP_MS:
            continue
        entries.append({"id": e["id"], "text": text, "chars": list(text), "cp": cp,
                        "tokens": sel_mod.token_spans(text), "clip": e["clip"]})
    return entries


def prune(out_dir: Path, referenced: set[str]) -> int:
    n = 0
    for sub in ("clips/words", "clips/sentences"):
        d = out_dir / sub
        if not d.is_dir():
            continue
        for p in d.iterdir():
            rel = f"{sub}/{p.name}"
            if p.is_file() and rel not in referenced:
                p.unlink()
                n += 1
    return n


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--aishell3-tar", type=Path, required=True,
                    help="AISHELL-3 data_aishell3.tgz, full or a byte-range prefix")
    ap.add_argument("--max-sentences", type=int, default=2000)
    ap.add_argument("--work-dir", type=Path, default=DEFAULT_WORK_DIR)
    ap.add_argument("--out-dir", type=Path, default=None,
                    help=f"default {DEFAULT_OUT_DIR} ({PRIVATE_OUT_DIR} with --private-build)")
    ap.add_argument("--base-url", default="", help='manifest baseUrl ("" = relative to manifest)')
    ap.add_argument("--min-coverage", type=float, default=sel_mod.MIN_COVERAGE,
                    help="preferred HSK coverage threshold (default 0.85)")
    ap.add_argument("--coverage-floor", type=float, default=sel_mod.COVERAGE_FLOOR,
                    help="lowest coverage tier admitted when N cannot be filled (default 0.70)")
    ap.add_argument("--per-speaker-cap", type=int, default=sel_mod.PER_SPEAKER_CAP)
    ap.add_argument("--min-sentence-ms", type=int, default=MIN_SENTENCE_MS,
                    help="drop sentence clips shorter than this after trimming (default 1500)")
    ap.add_argument("--with-tatoeba", action="store_true", help="OPT-IN; requires --private-build")
    ap.add_argument("--tatoeba-max", type=int, default=200)
    ap.add_argument("--include-traditional", action="store_true")
    ap.add_argument("--private-build", action="store_true",
                    help="write a complete bundle to site/data-private/ (git-ignored)")
    ap.add_argument("--max-bytes", type=int, default=MAX_CLIPS_BYTES)
    ap.add_argument("--force", action="store_true", help="re-encode / re-stream everything")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 4)
    args = ap.parse_args(argv)

    if args.with_tatoeba and not args.private_build:
        log("error: Tatoeba clips are mostly unlicensed (not redistributable); build.py refuses to "
            "write them into site/data. Re-run with --with-tatoeba --private-build.")
        return 2
    out_dir = args.out_dir or (PRIVATE_OUT_DIR if args.private_build else DEFAULT_OUT_DIR)
    out_dir = out_dir.resolve()
    if args.with_tatoeba and out_dir == DEFAULT_OUT_DIR.resolve():
        log("error: refusing to write Tatoeba clips into site/data")
        return 2
    args.work_dir = args.work_dir.resolve()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    cache_path = args.work_dir / "clip_ms_cache.json"
    cache = load_cache(cache_path)

    # 1. CEDICT
    cedict = cedict_mod.load(args.work_dir)
    # 2. audio-cmn words
    words, wstats = audio_cmn.build(cedict=cedict, work_dir=args.work_dir, out_dir=out_dir,
                                    force=args.force, jobs=args.jobs, cache=cache)
    save_cache(cache_path, cache)
    hsk_levels = wstats.pop("hsk_levels")
    # 3+4. AISHELL-3
    sentences, sstats = build_sentences(args, hsk_levels, out_dir, cache)
    save_cache(cache_path, cache)
    sources = [audio_cmn.SOURCE, aishell3.SOURCE]
    if args.with_tatoeba:
        from sources import tatoeba

        tt = build_tatoeba(args, out_dir)
        log(f"tatoeba: {len(tt)} sentences added to the PRIVATE bundle")
        sentences += tt
        sources.append(tatoeba.SOURCE)

    referenced = {c["file"] for w in words for c in w["clips"]} | {s["clip"]["file"] for s in sentences}
    pruned = prune(out_dir, referenced)
    if pruned:
        log(f"pruned {pruned} clip files no longer referenced")

    # 5. JSON (keep builtAt when the data did not change, so the app's "bundle updated" toast
    # only fires on real changes)
    words_bytes = json.dumps(words, ensure_ascii=False, separators=(",", ":")).encode()
    sent_bytes = json.dumps(sentences, ensure_ascii=False, separators=(",", ":")).encode()
    built_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest_path = out_dir / "manifest.json"
    try:
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        if ((out_dir / "words.json").read_bytes() == words_bytes
                and (out_dir / "sentences.json").read_bytes() == sent_bytes
                and old.get("baseUrl") == args.base_url and old.get("sources") == sources):
            built_at = old["builtAt"]
    except (OSError, ValueError, KeyError):
        pass
    write_json_min(out_dir / "words.json", words)
    write_json_min(out_dir / "sentences.json", sentences)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "builtAt": built_at,
        "baseUrl": args.base_url,
        "counts": {"words": len(words), "sentences": len(sentences)},
        "sources": sources,
        "files": {"words": "words.json", "sentences": "sentences.json"},
    }
    write_json_min(manifest_path, manifest)

    # 6. summary
    log("")
    log(validate_mod.format_summary(validate_mod.summarize(out_dir, hsk_levels)))
    # 7. size check
    total = dir_bytes(out_dir / "clips")
    if total > args.max_bytes:
        log(f"FAIL: {out_dir / 'clips'} is {total / 1e6:.1f} MB > {args.max_bytes / 1e6:.0f} MB")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
