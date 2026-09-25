"""Word clips from hugolpz/audio-cmn (Yue Tan, Shtooka project; CC BY-SA 4.0). PLAN §6.2."""
from __future__ import annotations

import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cedict as cedict_mod
from common import (WORD_KBPS, WORD_RATE_HZ, acmn_clip_id, all_han, encode_mp3, fallback_pinyin,
                    log, measure_ms, word_id)

REPO_URL = "https://github.com/hugolpz/audio-cmn.git"
SOURCE = {
    "id": "audio-cmn", "name": "audio-cmn (Yue Tan, Shtooka)", "license": "CC BY-SA 4.0",
    "url": "https://github.com/hugolpz/audio-cmn", "kind": "word", "synthetic": False,
}
SPEAKER = "yue-tan"
CLIP_SUBDIR = "clips/words"
# Single-character heteronyms where pypinyin's default reading (used to pick among CEDICT
# readings) is not the HSK 2.0 reading at the word's level: 长 HSK2 cháng, 得 HSK2 de.
READING_OVERRIDES = {"长": "chang2", "得": "de5"}


def ensure_clone(work_dir: Path) -> Path:
    """Sparse-clone audio-cmn (64k/hsk + lists) into work/audio-cmn unless present."""
    repo = Path(work_dir) / "audio-cmn"
    if (repo / "64k" / "hsk").is_dir() and (repo / "lists").is_dir():
        return repo
    repo.parent.mkdir(parents=True, exist_ok=True)
    log(f"audio-cmn: sparse-cloning {REPO_URL} -> {repo}")
    subprocess.run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO_URL,
                    str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "sparse-checkout", "set", "64k/hsk", "lists"],
                   check=True)
    return repo


def parse_hsk_list(text: str) -> list[str]:
    """`HSK2012_n.txt`: first line is a header like `HSK1`, then one word per line."""
    lines = [ln.strip().lstrip("﻿") for ln in text.splitlines()]
    lines = [ln for ln in lines if ln]
    if lines and not all_han(lines[0]):
        lines = lines[1:]
    return lines


def load_hsk_levels(repo: Path) -> dict[str, int]:
    """word -> lowest HSK 2.0 level it appears in (1-6)."""
    levels: dict[str, int] = {}
    for n in range(1, 7):
        text = (Path(repo) / "lists" / f"HSK2012_{n}.txt").read_text(encoding="utf-8")
        for w in parse_hsk_list(text):
            levels.setdefault(w, n)
    return levels


def word_from_filename(name: str) -> str | None:
    """`cmn-学习.mp3` -> 学习; None for pattern files like `cmn-一_也_.mp3` or non-Han names."""
    if not (name.startswith("cmn-") and name.endswith(".mp3")):
        return None
    w = name[4:-4]
    if "_" in w or "(" in w or not all_han(w):
        return None
    return w


def make_entry(word: str, cedict: dict, hsk_levels: dict[str, int]) -> dict | None:
    """words.json entry without clips, or None if the word has no CEDICT and no HSK match."""
    hint = READING_OVERRIDES.get(word) or fallback_pinyin(word)
    chosen = cedict_mod.choose(word, cedict.get(word, []), hint, resolve=cedict)
    hsk = hsk_levels.get(word, 0)
    if chosen is None and not hsk:
        return None
    if chosen is None:
        trad, pinyin, glosses = word, hint, []
    else:
        trad, pinyin, glosses = chosen
        if not cedict_mod._pinyin_ok(word, pinyin):
            pinyin = hint
    return {"id": word_id(word), "s": word, "t": trad, "p": pinyin, "d": glosses, "hsk": hsk,
            "clips": []}


def build(*, cedict: dict, work_dir: Path, out_dir: Path, force: bool = False, jobs: int = 4,
          cache: dict | None = None, limit: int | None = None) -> tuple[list[dict], dict]:
    """Encode word clips into out_dir/clips/words and return (entries, stats)."""
    repo = ensure_clone(work_dir)
    hsk_levels = load_hsk_levels(repo)
    src_dir = repo / "64k" / "hsk"
    files = sorted(p.name for p in src_dir.glob("cmn-*.mp3"))
    stats = {"files": len(files), "skipped_pattern": 0, "skipped_nomatch": 0, "cedict": 0,
             "encoded": 0, "reused": 0}
    todo = []
    for name in files:
        w = word_from_filename(name)
        if w is None:
            stats["skipped_pattern"] += 1
            continue
        entry = make_entry(w, cedict, hsk_levels)
        if entry is None:
            stats["skipped_nomatch"] += 1
            continue
        if entry["d"] or w in cedict:
            stats["cedict"] += 1
        todo.append((w, entry, src_dir / name))
        if limit and len(todo) >= limit:
            break

    cache = cache if cache is not None else {}
    clip_dir = Path(out_dir) / CLIP_SUBDIR

    def work(item):
        w, entry, src = item
        cid = acmn_clip_id(w)
        rel = f"{CLIP_SUBDIR}/{cid}.mp3"
        dst = clip_dir / f"{cid}.mp3"
        key = f"{rel}|{src.stat().st_size}"
        if dst.exists() and not force:
            ms = cache.get(key)
            if ms is None:
                ms = measure_ms(dst)
            reused = True
        else:
            ms = encode_mp3(src, dst, rate_hz=WORD_RATE_HZ, kbps=WORD_KBPS, trim_silence=True)
            reused = False
        cache[key] = ms
        entry["clips"] = [{"id": cid, "src": SOURCE["id"], "file": rel, "ms": ms,
                           "speaker": SPEAKER}]
        return reused

    with ThreadPoolExecutor(max_workers=jobs) as ex:
        for i, reused in enumerate(ex.map(work, todo), 1):
            stats["reused" if reused else "encoded"] += 1
            if i % 1000 == 0:
                log(f"audio-cmn: {i}/{len(todo)} clips")
    entries = [e for _, e, _ in todo]
    entries.sort(key=lambda e: (e["hsk"] or 7, e["id"]))  # HSK order, stable across builds
    stats["words"] = len(entries)
    stats["hsk_levels"] = hsk_levels
    log(f"audio-cmn: {len(entries)} words ({stats['encoded']} encoded, {stats['reused']} reused, "
        f"{stats['skipped_pattern']} pattern files skipped, {stats['skipped_nomatch']} without "
        f"CEDICT/HSK match)")
    return entries, stats
