#!/usr/bin/env python3
"""Build site/data/dict.json: CC-CEDICT readings for words that have no audio entry.

words.json only covers words with a clip. Everything else the app can show (sentence tokens,
single characters, HSK words without audio, the user's synced Hack Chinese words) still needs
pinyin and a definition, so this script writes a compact dictionary for exactly that set:

    { "<simplified>": { "t": "<traditional>", "p": "<numeric pinyin>", "d": ["gloss", ...] }, ... }

Sources of the word set (each optional): site/data/sentences.json (tokens + characters),
pipeline/work/audio-cmn/lists/HSK2012_*.txt, site/data/user/hackchinese.csv (+ characters).
Words already in words.json are left out. Needs only the standard library plus `requests`
(for the CEDICT download), so the daily sync workflow can run it too.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedict as cedict_mod  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"
HAN = re.compile(r"^[㐀-䶿一-鿿豈-﫿]+$")


HSK_RAW = "https://raw.githubusercontent.com/hugolpz/audio-cmn/master/lists/HSK2012_{n}.txt"


def hsk_lists(hsk_dir: Path | None) -> list[str]:
    """HSK 1-6 list texts from the audio-cmn checkout if present, else fetched (and cached in
    pipeline/work/hsk/) so the sync workflow produces the same dictionary as a local build."""
    out: list[str] = []
    for n in range(1, 7):
        local = hsk_dir / f"HSK2012_{n}.txt" if hsk_dir else None
        if local and local.exists():
            out.append(local.read_text(encoding="utf-8"))
            continue
        cache = ROOT / "pipeline" / "work" / "hsk" / f"HSK2012_{n}.txt"
        if not cache.exists():
            try:
                import requests
                r = requests.get(HSK_RAW.format(n=n), timeout=60)
                r.raise_for_status()
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_text(r.text, encoding="utf-8")
            except Exception as e:  # noqa: BLE001
                print(f"warning: could not fetch HSK list {n}: {e}", file=sys.stderr)
                continue
        out.append(cache.read_text(encoding="utf-8"))
    return out


def wanted_words(data_dir: Path, hsk_dir: Path | None) -> set[str]:
    words: set[str] = set()
    sp = data_dir / "sentences.json"
    if sp.exists():
        for s in json.loads(sp.read_text(encoding="utf-8")):
            text = s.get("text", "")
            for a, b in s.get("tokens", []):
                words.add(text[a:b])
            words.update(text)
    for text in hsk_lists(hsk_dir):
        lines = text.splitlines()[1:]
        words.update(w.strip() for w in lines if w.strip())
    hc = data_dir / "user" / "hackchinese.csv"
    if hc.exists():
        rows = list(csv.reader(hc.read_text(encoding="utf-8-sig").splitlines()))
        if rows:
            header = [c.strip().lower() for c in rows[0]]
            col = header.index("simplified") if "simplified" in header else 0
            for r in rows[1:]:
                if len(r) > col and r[col].strip():
                    w = r[col].strip()
                    words.add(w)
                    words.update(w)
    return {w for w in words if HAN.match(w)}


def build(data_dir: Path, work_dir: Path, hsk_dir: Path | None) -> dict:
    cedict = cedict_mod.load(work_dir)
    have = set()
    wp = data_dir / "words.json"
    if wp.exists():
        have = {w["s"] for w in json.loads(wp.read_text(encoding="utf-8"))}
    out: dict[str, dict] = {}
    missing = 0
    for w in sorted(wanted_words(data_dir, hsk_dir) - have):
        chosen = cedict_mod.choose(w, cedict.get(w, []), None, resolve=cedict)
        if not chosen:
            missing += 1
            continue
        trad, pinyin, glosses = chosen
        entry = {"p": pinyin}
        if trad and trad != w:
            entry["t"] = trad
        if glosses:
            entry["d"] = glosses
        out[w] = entry
    print(f"dict: {len(out)} entries ({missing} wanted words not in CEDICT)")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--data-dir", default=str(DATA))
    ap.add_argument("--work-dir", default=str(ROOT / "pipeline" / "work"))
    ap.add_argument("--hsk-dir", default=str(ROOT / "pipeline" / "work" / "audio-cmn" / "lists"))
    args = ap.parse_args(argv)
    data_dir, work_dir = Path(args.data_dir), Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    d = build(data_dir, work_dir, Path(args.hsk_dir))
    out = data_dir / "dict.json"
    text = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    if out.exists() and out.read_text(encoding="utf-8") == text:
        print("dict.json unchanged")
    else:
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out} ({len(text.encode('utf-8')) / 1024:.0f} KB)")
    mp = data_dir / "manifest.json"
    manifest = json.loads(mp.read_text(encoding="utf-8"))
    files = manifest.setdefault("files", {})
    if files.get("dict") != "dict.json":
        files["dict"] = "dict.json"
        mp.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
