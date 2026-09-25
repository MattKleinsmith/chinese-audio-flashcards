"""Sentence clips from AISHELL-3 (OpenSLR SLR93; Apache-2.0). PLAN §6.3.

Works on the full 19 GB tarball or on any byte-range prefix of it: the tarball is streamed
once with tarfile mode "r|gz"; the truncated tail raises ReadError/EOFError, which we treat as
end-of-archive. Transcripts (`*/content.txt`) come before their split's WAVs, so each WAV can
be kept or dropped the moment it streams by (keep-filter = select_sentences candidate test).
Kept WAVs go to work/aishell3/wav/<speaker>/<utt>.wav; an index file makes re-runs skip the
stream pass entirely.
"""
from __future__ import annotations

import json
import os
import re
import tarfile
import time
from pathlib import Path

from common import is_han, log

SOURCE = {
    "id": "aishell3", "name": "AISHELL-3", "license": "Apache-2.0",
    "url": "https://www.openslr.org/93/", "kind": "sentence", "synthetic": False,
}
TAG = "a3"
CLIP_SUBDIR = "clips/sentences"
MIN_CHARS, MAX_CHARS = 4, 22
INDEX_VERSION = 1

_PINYIN_RE = re.compile(r"^[a-z]*[aeiouv][a-z]*[1-5]$|^(?:m|n|ng|hm|hng)[1-5]$")
_UTT_RE = re.compile(r"^(SSB\d{4})(\d{4})\.wav$")


def parse_transcript_line(line: str):
    """`SSB06930002.wav<TAB>武 wu3 术 shu4 …` -> (utt, chars, cp) or (None, reason).

    Rejects: malformed lines, odd token counts, multi-character "chars" (erhua such as
    `点儿 dianr3`, which has one syllable for two characters and would break the
    chars/cp/text alignment), non-Han characters (Latin letters, digits), pinyin that is not
    a plain numeric-tone syllable, and sentences shorter than 4 or longer than 22 chars.
    """
    line = line.strip().lstrip("﻿")
    if not line:
        return None, "empty"
    name, sep, body = line.partition("\t")
    if not sep:
        parts = line.split(None, 1)
        if len(parts) != 2:
            return None, "malformed"
        name, body = parts
    m = _UTT_RE.match(name.strip())
    if not m:
        return None, "malformed"
    toks = body.split()
    if not toks or len(toks) % 2:
        return None, "odd-tokens"
    chars, cp = toks[0::2], toks[1::2]
    if any(len(c) != 1 for c in chars):
        return None, "erhua" if any("儿" in c for c in chars) else "multi-char"
    if not all(is_han(c) for c in chars):
        return None, "non-han"
    if not all(_PINYIN_RE.match(p) for p in cp):
        return None, "bad-pinyin"
    if not (MIN_CHARS <= len(chars) <= MAX_CHARS):
        return None, "length"
    return (name[:-4], chars, cp), None


def parse_spk_info(text: str) -> dict[str, dict]:
    """`SSB1837<TAB>B<TAB>female<TAB>north` -> {"SSB1837": {"age","gender","accent"}}."""
    out = {}
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) >= 4 and parts[0].startswith("SSB"):
            out[parts[0]] = {"age": parts[1], "gender": parts[2], "accent": parts[3]}
    return out


def speaker_of(utt: str) -> str:
    return utt[:7]


class Transcripts:
    """Accumulates parsed transcript lines and rejection counts."""

    def __init__(self):
        self.lines: dict[str, tuple[list[str], list[str]]] = {}
        self.rejected: dict[str, int] = {}
        self.raw_lines = 0

    def add_text(self, text: str):
        for line in text.splitlines():
            if not line.strip():
                continue
            self.raw_lines += 1
            res, reason = parse_transcript_line(line)
            if res is None:
                self.rejected[reason] = self.rejected.get(reason, 0) + 1
                continue
            utt, chars, cp = res
            self.lines[utt] = (chars, cp)


def stream(tar_path: Path, work_dir: Path, keep, *, force: bool = False,
           filter_sig: str = "") -> dict:
    """One streaming pass over the tarball.

    `keep(utt, speaker, chars, cp) -> bool` decides whether to write a WAV to disk.
    Returns the index: {"transcripts": {utt: [chars, cp]}, "spk": {...}, "available": [...],
    "wavs_seen": n, "truncated": bool, ...}. Cached in work/aishell3/index.json.
    """
    tar_path = Path(tar_path)
    base = Path(work_dir) / "aishell3"
    wav_dir = base / "wav"
    index_path = base / "index.json"
    tar_sig = {"path": str(tar_path.resolve()), "size": tar_path.stat().st_size}
    if index_path.exists() and not force:
        idx = json.loads(index_path.read_text(encoding="utf-8"))
        if (idx.get("version") == INDEX_VERSION and idx.get("tar") == tar_sig
                and idx.get("filter") == filter_sig
                and all((wav_dir / speaker_of(u) / f"{u}.wav").exists() for u in idx["available"])):
            log(f"aishell3: reusing stream index ({len(idx['available'])} kept WAVs, "
                f"{idx['wavs_seen']} WAVs in archive{' prefix' if idx['truncated'] else ''})")
            return idx

    log(f"aishell3: streaming {tar_path} ({tar_sig['size'] / 1e9:.2f} GB)")
    t0 = time.time()
    trans = Transcripts()
    spk: dict[str, dict] = {}
    available: list[str] = []
    wavs_seen = 0
    wavs_no_transcript = 0
    truncated = False
    decided: dict[str, bool] = {}
    try:
        with tarfile.open(tar_path, mode="r|gz") as tf:
            for m in tf:
                if not m.isfile():
                    continue
                name = m.name
                base_name = os.path.basename(name)
                if base_name in ("spk-info.txt", "spk_info.txt"):
                    spk.update(parse_spk_info(tf.extractfile(m).read().decode("utf-8", "replace")))
                elif base_name == "content.txt":
                    trans.add_text(tf.extractfile(m).read().decode("utf-8", "replace"))
                    log(f"aishell3: read {name}: {len(trans.lines)} usable transcripts so far")
                elif base_name.endswith(".wav"):
                    wavs_seen += 1
                    utt = base_name[:-4]
                    tr = trans.lines.get(utt)
                    if tr is None:
                        wavs_no_transcript += 1
                        continue
                    ok = decided.get(utt)
                    if ok is None:
                        ok = decided[utt] = bool(keep(utt, speaker_of(utt), tr[0], tr[1]))
                    if not ok:
                        continue
                    dst = wav_dir / speaker_of(utt) / base_name
                    if not dst.exists() or dst.stat().st_size != m.size:
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        tmp = dst.with_suffix(".tmp")
                        with tf.extractfile(m) as f, open(tmp, "wb") as out:
                            while chunk := f.read(1 << 20):
                                out.write(chunk)
                        os.replace(tmp, dst)
                    available.append(utt)
                    if wavs_seen % 2000 == 0:
                        log(f"aishell3: {wavs_seen} WAVs seen, {len(available)} kept")
    except (tarfile.ReadError, EOFError) as e:
        truncated = True
        log(f"aishell3: archive ends early ({type(e).__name__}: {e}) — treating as a prefix")
    # A WAV whose bytes were cut mid-entry raises inside extractfile; drop partial files.
    for p in wav_dir.glob("*/*.tmp"):
        p.unlink()
    log(f"aishell3: {wavs_seen} WAVs available in archive, {len(available)} kept "
        f"({wavs_no_transcript} without transcript), {len(trans.lines)}/{trans.raw_lines} "
        f"transcript lines usable, rejected: {trans.rejected} [{time.time() - t0:.0f}s]")
    idx = {
        "version": INDEX_VERSION, "tar": tar_sig, "filter": filter_sig, "truncated": truncated,
        "wavs_seen": wavs_seen, "available": sorted(set(available)),
        "transcripts": {u: [c, p] for u, (c, p) in trans.lines.items()},
        "transcript_lines": trans.raw_lines, "rejected": trans.rejected, "spk": spk,
    }
    base.mkdir(parents=True, exist_ok=True)
    tmp = index_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, index_path)
    return idx


def wav_path(work_dir: Path, utt: str) -> Path:
    return Path(work_dir) / "aishell3" / "wav" / speaker_of(utt) / f"{utt}.wav"


def wav_ms(path: Path) -> int:
    """Duration of a PCM WAV from its header (no decode)."""
    import wave

    with wave.open(str(path), "rb") as w:
        return round(w.getnframes() * 1000 / w.getframerate())
