"""Shared helpers for the data pipeline: ffmpeg, encoding, ids, pinyin, JSON output.

Everything here is deterministic and has no network access.
"""
from __future__ import annotations

import array
import functools
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_DIR.parent
DEFAULT_WORK_DIR = PIPELINE_DIR / "work"
DEFAULT_OUT_DIR = REPO_ROOT / "site" / "data"
PRIVATE_OUT_DIR = REPO_ROOT / "site" / "data-private"

# Encoding targets (PLAN §2 "Audio format").
WORD_RATE_HZ, WORD_KBPS = 22050, 40
SENTENCE_RATE_HZ, SENTENCE_KBPS = 24000, 48

# PLAN §6.1. Leading silence is cut down to 50 ms, trailing silence to 150 ms (the reverse
# pass), then 80 ms of digital silence is appended so the clip ends without a click.
# ffmpeg's `start_silence` is the amount of silence *kept*, so speech onsets are never cut.
TRIM_FILTER = (
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,"
    "areverse,"
    "apad=pad_dur=0.08"
)

MAX_CLIP_MS = 8000
MAX_CLIPS_BYTES = 150_000_000  # 150 MB (decimal, the stricter reading)


# --------------------------------------------------------------------------- ffmpeg


@functools.lru_cache(maxsize=1)
def ffmpeg() -> str:
    """Path to the ffmpeg binary (imageio-ffmpeg's static build, or $FFMPEG)."""
    env = os.environ.get("FFMPEG")
    if env:
        return env
    import imageio_ffmpeg  # imported lazily so pure helpers work without it

    return imageio_ffmpeg.get_ffmpeg_exe()


def _run(args: list[str], *, capture_stdout: bool = False) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-800:]
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {' '.join(args[:6])} …\n{tail}")
    return proc


def measure_ms(path: str | os.PathLike) -> int:
    """Exact decoded duration in ms (decodes to 16 kHz mono PCM and counts samples).

    There is no ffprobe in imageio-ffmpeg, and parsing `time=` only gives 10 ms resolution,
    so we count samples instead. Resampling preserves duration.
    """
    proc = _run(
        [ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
        capture_stdout=True,
    )
    samples = len(proc.stdout) // 2
    return round(samples / 16)


def encode_mp3(src: str | os.PathLike, dst: str | os.PathLike, *, rate_hz: int, kbps: int,
               trim_silence: bool = True) -> int:
    """Encode `src` to a mono CBR MP3 at `dst`; return the output duration in ms.

    Writes atomically (tmp file + rename) so an interrupted build never leaves a half file.
    Uses bitexact flags and strips metadata so rebuilds produce byte-identical files.
    """
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".tmp.mp3")
    args = [ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", str(src)]
    if trim_silence:
        args += ["-af", TRIM_FILTER]
    args += [
        "-map_metadata", "-1", "-vn", "-sn",
        "-ac", "1", "-ar", str(rate_hz),
        "-codec:a", "libmp3lame", "-b:a", f"{kbps}k",
        "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-id3v2_version", "0", "-write_id3v1", "0",
        "-f", "mp3", str(tmp),
    ]
    try:
        _run(args)
        os.replace(tmp, dst)
    finally:
        if tmp.exists():
            tmp.unlink()
    return measure_ms(dst)


def decode_pcm16k(path: str | os.PathLike) -> "array.array":
    """Decode any audio file to 16 kHz mono signed 16-bit samples."""
    proc = _run(
        [ffmpeg(), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path),
         "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
        capture_stdout=True,
    )
    pcm = array.array("h")
    pcm.frombytes(proc.stdout[: len(proc.stdout) // 2 * 2])
    if sys.byteorder == "big":
        pcm.byteswap()
    return pcm


def envelope_db(pcm, win_ms: int = 10) -> list[float]:
    """RMS level in dBFS for consecutive windows of `win_ms` (16 kHz input)."""
    n = 16 * win_ms
    out = []
    for i in range(0, len(pcm), n):
        seg = pcm[i:i + n]
        if not seg:
            break
        rms = math.sqrt(sum(x * x for x in seg) / len(seg))
        out.append(20 * math.log10(max(rms, 1.0) / 32768))
    return out


def sound_extent_ms(path: str | os.PathLike, threshold_db: float = -40,
                    win_ms: int = 10) -> tuple[int, int, int]:
    """(first_loud_ms, last_loud_ms_end, total_ms): span of windows louder than threshold.

    Used by validate.py to check that trimming did not cut into speech: the loud span of
    an encoded clip should be (almost) as long as the loud span of its source.
    """
    pcm = decode_pcm16k(path)
    env = envelope_db(pcm, win_ms)
    total = round(len(pcm) / 16)
    loud = [i for i, db in enumerate(env) if db > threshold_db]
    if not loud:
        return 0, 0, total
    return loud[0] * win_ms, min(total, (loud[-1] + 1) * win_ms), total


# --------------------------------------------------------------------------- MP3 parsing

_MP3_BITRATES = {  # (mpeg1?, index) -> kbps, layer III only
    True: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    False: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_MP3_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def mp3_info(path: str | os.PathLike) -> dict:
    """Parse MPEG audio layer III frame headers (pure Python, no ffmpeg).

    Returns {"rate", "channels", "kbps", "frames", "ms"}; `ms` counts audio frames
    (excluding a Xing/Info frame), so it may exceed the gapless duration by ~50 ms.
    Raises ValueError if the file is not a layer III MPEG stream.
    """
    data = Path(path).read_bytes()
    pos = 0
    if data[:3] == b"ID3":
        size = (data[6] << 21) | (data[7] << 14) | (data[8] << 7) | data[9]
        pos = 10 + size
    frames, rate, channels, kbps_set, first = 0, None, None, set(), True
    samples_per_frame = 1152
    while pos + 4 <= len(data):
        h = int.from_bytes(data[pos:pos + 4], "big")
        if (h >> 21) & 0x7FF != 0x7FF:
            if frames == 0:
                pos += 1
                continue
            break
        ver = (h >> 19) & 3
        layer = (h >> 17) & 3
        br_idx = (h >> 12) & 0xF
        sr_idx = (h >> 10) & 3
        pad = (h >> 9) & 1
        mode = (h >> 6) & 3
        if ver == 1 or layer != 1 or br_idx in (0, 15) or sr_idx == 3:
            raise ValueError(f"{path}: not an MPEG layer III stream at byte {pos}")
        mpeg1 = ver == 3
        kbps = _MP3_BITRATES[mpeg1][br_idx]
        sr = _MP3_RATES[ver][sr_idx]
        samples_per_frame = 1152 if mpeg1 else 576
        flen = (144 if mpeg1 else 72) * kbps * 1000 // sr + pad
        ch = 1 if mode == 3 else 2
        if first:
            first = False
            side = (17 if mpeg1 else 9) if ch == 1 else (32 if mpeg1 else 17)
            tag = data[pos + 4 + side: pos + 8 + side]
            if tag in (b"Xing", b"Info"):
                rate, channels = sr, ch
                pos += flen
                continue
        rate, channels = sr, ch if channels in (None, ch) else 2
        kbps_set.add(kbps)
        frames += 1
        pos += flen
    if not frames:
        raise ValueError(f"{path}: no MPEG audio frames")
    return {
        "rate": rate,
        "channels": channels,
        "kbps": sorted(kbps_set),
        "frames": frames,
        "ms": round(frames * samples_per_frame * 1000 / rate),
    }


# --------------------------------------------------------------------------- ids


def hex_cps(s: str) -> str:
    return "_".join(f"{ord(c):x}" for c in s)


def word_id(simplified: str) -> str:
    """PLAN §4.2: "w_" + hex codepoints joined by "_" (学习 -> w_5b66_4e60)."""
    if not simplified:
        raise ValueError("empty word")
    return "w_" + hex_cps(simplified)


def acmn_clip_id(simplified: str) -> str:
    """Clip id for an audio-cmn word clip (学习 -> c_acmn_5b66_4e60)."""
    if not simplified:
        raise ValueError("empty word")
    return "c_acmn_" + hex_cps(simplified)


def sentence_id(source_tag: str, utt: str) -> str:
    """PLAN §4.3: "s_" + source tag + "_" + corpus utterance id (s_a3_SSB06930002)."""
    if not re.fullmatch(r"[a-z0-9]+", source_tag) or not re.fullmatch(r"[A-Za-z0-9]+", utt):
        raise ValueError(f"bad sentence id parts {source_tag!r} {utt!r}")
    return f"s_{source_tag}_{utt}"


# --------------------------------------------------------------------------- text


def is_han(ch: str) -> bool:
    """True for a single CJK ideograph (URO, Ext A-G, compatibility ideographs)."""
    if len(ch) != 1:
        return False
    cp = ord(ch)
    return (
        0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF or 0x20000 <= cp <= 0x323AF
        or 0xF900 <= cp <= 0xFAFF or cp == 0x3007
    )


def all_han(s: str) -> bool:
    return bool(s) and all(is_han(c) for c in s)


# Numeric-tone syllable: letters (v = ü) + optional tone 1-5. Lowercase only.
SYLLABLE_RE = re.compile(r"^[a-z]*[aeiouv][a-z]*[1-5]$|^(?:m|n|ng|hm|hng)[1-5]$|^r5$")


def normalize_cedict_pinyin(p: str) -> str:
    """CEDICT pinyin -> our convention: lowercase, numeric tones, `v` for ü.

    `u:` (CEDICT's ü) becomes `v` (lu:4 -> lv4); `ü` also becomes `v`.
    """
    p = p.strip().lower().replace("u:", "v").replace("ü", "v")
    return re.sub(r"\s+", " ", p)


_TONE_MARKS = {
    "a": "āáǎà", "e": "ēéěè", "i": "īíǐì", "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ",
}


def syllable_to_marks(syl: str) -> str:
    """One numeric-tone syllable -> tone-mark form (lv4 -> lǜ, de5 -> de, xiong2 -> xióng)."""
    m = re.fullmatch(r"([A-Za-züÜv:]+?)([1-5])?", syl)
    if not m:
        return syl
    base, tone = m.group(1), int(m.group(2) or 5)
    base = base.replace("u:", "ü").replace("v", "ü").replace("V", "Ü")
    if tone == 5:
        return base
    low = base.lower()
    # Rules: a or e takes the mark; in "ou" the o does; otherwise the last vowel.
    if "a" in low:
        idx = low.index("a")
    elif "e" in low:
        idx = low.index("e")
    elif "ou" in low:
        idx = low.index("o")
    else:
        idx = max((i for i, c in enumerate(low) if c in "iouü"), default=-1)
        if idx < 0:  # m2, n2, ng4 …: no vowel. Leave unmarked but drop the digit.
            return base
    ch = low[idx]
    marked = _TONE_MARKS[ch][tone - 1]
    if base[idx].isupper():
        marked = marked.upper()
    return base[:idx] + marked + base[idx + 1:]


def numeric_to_marks(pinyin: str) -> str:
    """"xue2 xi2" -> "xué xí" (also used to sanity-check the JS implementation)."""
    return " ".join(syllable_to_marks(s) for s in pinyin.split())


def fallback_pinyin(word: str) -> str:
    """pypinyin TONE3, tone 5 for neutral, `v` for ü (e.g. 绿 -> lv4)."""
    from pypinyin import Style, lazy_pinyin

    syls = lazy_pinyin(word, style=Style.TONE3, neutral_tone_with_five=True)
    return normalize_cedict_pinyin(" ".join(syls))


# --------------------------------------------------------------------------- output


def dumps_min(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write_json_min(path: str | os.PathLike, obj) -> int:
    """Write minified UTF-8 JSON atomically; return bytes written."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = dumps_min(obj).encode("utf-8")
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return len(data)


def dir_bytes(path: str | os.PathLike) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            total += os.path.getsize(os.path.join(root, f))
    return total


def nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def log(*args) -> None:
    print(*args, flush=True)
