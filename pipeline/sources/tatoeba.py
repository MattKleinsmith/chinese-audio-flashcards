"""OPT-IN sentence clips from Tatoeba (PLAN §1.4, §6.5). Default OFF.

Licence caveat: ~98 % of Mandarin Tatoeba audio has *no licence recorded*, which Tatoeba
treats as "may only be used on Tatoeba". Clips without a licence are marked
`redistributable: false`. build.py never writes Tatoeba clips into site/data (the committed
bundle); they are only used with `--with-tatoeba --private-build`, which writes a complete
bundle to site/data-private/ (git-ignored).

Standalone smoke test (fetches the two exports plus at most N clips into work/):
    pipeline/.venv/bin/python pipeline/sources/tatoeba.py --smoke 3
"""
from __future__ import annotations

import bz2
import csv
import sys
import time
from pathlib import Path

if __name__ == "__main__":  # allow running as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import all_han, encode_mp3, log, SENTENCE_KBPS, SENTENCE_RATE_HZ, sentence_id

AUDIO_TSV = "https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences_with_audio.tsv.bz2"
TEXT_TSV = "https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences_detailed.tsv.bz2"
AUDIO_URL = "https://tatoeba.org/audio/download/{audio_id}"
USER_AGENT = ("chinese-audio-flashcards-pipeline/1.0 (personal study tool; "
              "https://github.com/mattkleinsmith/chinese-audio-flashcards)")
DELAY_S = 0.5
TAG = "tt"
SIMPLIFIED_USERS = ("fucongcong",)
CLIP_SUBDIR = "clips/sentences"
SOURCE = {
    "id": "tatoeba", "name": "Tatoeba (opt-in, private build only)",
    "license": "per clip; mostly none recorded (Tatoeba-only use)",
    "url": "https://tatoeba.org/", "kind": "sentence", "synthetic": False,
}


def _session():
    import requests

    s = requests.Session()
    s.headers["User-Agent"] = USER_AGENT
    return s


def download_exports(work_dir: Path, session=None) -> tuple[Path, Path]:
    d = Path(work_dir) / "tatoeba"
    d.mkdir(parents=True, exist_ok=True)
    session = session or _session()
    out = []
    for url in (AUDIO_TSV, TEXT_TSV):
        p = d / url.rsplit("/", 1)[1]
        if not p.exists():
            log(f"tatoeba: downloading {url}")
            r = session.get(url, timeout=120)
            r.raise_for_status()
            p.write_bytes(r.content)
            time.sleep(DELAY_S)
        out.append(p)
    return out[0], out[1]


def parse_audio_rows(lines) -> list[dict]:
    """cmn_sentences_with_audio.tsv: sentence_id, audio_id, username, licence, attribution_url."""
    rows = []
    for parts in csv.reader(lines, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(parts) < 3 or not parts[0].isdigit():
            continue
        parts += [""] * (5 - len(parts))
        lic = parts[3].strip()
        if lic == "\\N":
            lic = ""
        rows.append({"sentence_id": parts[0], "audio_id": parts[1], "username": parts[2],
                     "license": lic, "attribution_url": parts[4].strip().replace("\\N", ""),
                     "redistributable": bool(lic)})
    return rows


def parse_text_rows(lines) -> dict[str, str]:
    """cmn_sentences_detailed.tsv: id, lang, text, username, added, modified."""
    out = {}
    for parts in csv.reader(lines, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(parts) >= 3 and parts[0].isdigit():
            out[parts[0]] = parts[2]
    return out


def strip_punct(text: str) -> str:
    return "".join(c for c in text if all_han(c))


def load_rows(work_dir: Path, include_traditional: bool = False, session=None) -> list[dict]:
    audio_p, text_p = download_exports(work_dir, session)
    with bz2.open(audio_p, "rt", encoding="utf-8") as f:
        audio = parse_audio_rows(f)
    with bz2.open(text_p, "rt", encoding="utf-8") as f:
        texts = parse_text_rows(f)
    rows = []
    for r in audio:
        if not include_traditional and r["username"] not in SIMPLIFIED_USERS:
            continue
        raw = texts.get(r["sentence_id"])
        if not raw:
            continue
        text = strip_punct(raw)
        if not (4 <= len(text) <= 22):
            continue
        r = dict(r, raw_text=raw, text=text)
        rows.append(r)
    log(f"tatoeba: {len(audio)} audio rows, {len(rows)} usable "
        f"({sum(r['redistributable'] for r in rows)} with a recorded licence)")
    return rows


def fetch(rows: list[dict], work_dir: Path, limit: int, session=None) -> list[dict]:
    """Download up to `limit` MP3s politely (0.5 s between requests) into work/tatoeba/mp3."""
    session = session or _session()
    d = Path(work_dir) / "tatoeba" / "mp3"
    d.mkdir(parents=True, exist_ok=True)
    got = []
    for r in rows[:limit]:
        p = d / f"{r['audio_id']}.mp3"
        if not p.exists():
            resp = session.get(AUDIO_URL.format(audio_id=r["audio_id"]), timeout=60)
            resp.raise_for_status()
            p.write_bytes(resp.content)
            time.sleep(DELAY_S)
        got.append(dict(r, raw_path=str(p)))
    return got


def build(rows: list[dict], out_dir: Path, *, private_build: bool, force: bool = False) -> list[dict]:
    """Encode fetched rows into out_dir. Refuses to target anything but a private build.

    Returns sentences.json-style entries (tokens/cp are filled by build.py). Each clip carries
    `license` and `redistributable`.
    """
    if not private_build:
        raise PermissionError("Tatoeba clips may only be written with --private-build "
                              "(site/data-private/); never into site/data")
    out = []
    for r in rows:
        utt = f"{r['sentence_id']}x{r['audio_id']}"
        sid = sentence_id(TAG, utt)
        rel = f"{CLIP_SUBDIR}/{sid}.mp3"
        dst = Path(out_dir) / rel
        if dst.exists() and not force:
            from common import measure_ms

            ms = measure_ms(dst)
        else:
            ms = encode_mp3(r["raw_path"], dst, rate_hz=SENTENCE_RATE_HZ, kbps=SENTENCE_KBPS)
        out.append({"id": sid, "text": r["text"], "clip": {
            "src": "tatoeba", "file": rel, "ms": ms, "speaker": r["username"],
            "license": r["license"], "redistributable": r["redistributable"],
            "attribution": r["attribution_url"] or f"https://tatoeba.org/sentences/show/{r['sentence_id']}",
        }})
    return out


def _main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--smoke", type=int, default=3, help="fetch at most this many clips (max 3)")
    ap.add_argument("--work-dir", type=Path, default=Path(__file__).resolve().parent.parent / "work")
    ap.add_argument("--include-traditional", action="store_true")
    args = ap.parse_args(argv)
    n = max(0, min(args.smoke, 3))
    rows = load_rows(args.work_dir, args.include_traditional)
    got = fetch(rows, args.work_dir, n)
    for r in got:
        size = Path(r["raw_path"]).stat().st_size
        print(f"{r['sentence_id']}\t{r['audio_id']}\t{r['username']}\tlicence={r['license'] or '(none)'}"
              f"\t{r['text']}\t{size} bytes")


if __name__ == "__main__":
    _main()
