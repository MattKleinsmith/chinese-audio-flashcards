#!/usr/bin/env python3
"""Validate site/data against the data contract (PLAN §4) and print the §6.6 summary.

    pipeline/.venv/bin/python pipeline/validate.py [--data-dir site/data] [--trim-check 40]

Exit status 1 if any invariant is violated. `--trim-check N` additionally compares N word and
N sentence clips with their sources in pipeline/work/ to confirm silence trimming did not cut
into speech.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from always_known import ALWAYS_KNOWN  # noqa: E402
from common import (DEFAULT_OUT_DIR, DEFAULT_WORK_DIR, MAX_CLIP_MS, MAX_CLIPS_BYTES,  # noqa: E402
                    SENTENCE_KBPS, SENTENCE_RATE_HZ, SYLLABLE_RE, WORD_KBPS, WORD_RATE_HZ,
                    acmn_clip_id, all_han, dir_bytes, dumps_min, is_han, mp3_info,
                    sound_extent_ms, word_id)

MANIFEST_KEYS = {"schemaVersion", "builtAt", "baseUrl", "counts", "sources", "files"}
SOURCE_KEYS = {"id", "name", "license", "url", "kind", "synthetic"}
WORD_KEYS = {"id", "s", "t", "p", "d", "hsk", "clips"}
WORD_CLIP_KEYS = {"id", "src", "file", "ms", "speaker"}
SENT_KEYS = {"id", "text", "chars", "cp", "tokens", "clip"}
SENT_CLIP_KEYS = {"src", "file", "ms", "speaker", "gender", "age", "accent"}
A3_ID_RE = re.compile(r"^s_a3_(SSB\d{4})\d{4}$")
WORD_MS_SANE = (500, 2500)
SENT_MS_SANE = (1500, 8000)


class Report:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: Counter = Counter()
        self.warning_examples: dict[str, list[str]] = {}

    def err(self, msg: str):
        if len(self.errors) < 200:
            self.errors.append(msg)
        elif len(self.errors) == 200:
            self.errors.append("… (more errors suppressed)")

    def warn(self, kind: str, example: str):
        self.warnings[kind] += 1
        ex = self.warning_examples.setdefault(kind, [])
        if len(ex) < 5:
            ex.append(example)


def load_min_json(path: Path, rep: Report):
    raw = path.read_text(encoding="utf-8")
    obj = json.loads(raw)
    if raw != dumps_min(obj):
        rep.err(f"{path.name}: not minified UTF-8 JSON (compact separators, ensure_ascii=False)")
    return obj


def tiles(tokens, n: int) -> bool:
    pos = 0
    for t in tokens:
        if not (isinstance(t, list) and len(t) == 2 and all(isinstance(x, int) for x in t)):
            return False
        a, b = t
        if a != pos or b <= a:
            return False
        pos = b
    return pos == n and n > 0


def check_word(w: dict, rep: Report, data_dir: Path) -> None:
    wid = w.get("id", "?")
    if set(w) != WORD_KEYS:
        rep.err(f"word {wid}: keys {sorted(w)} != {sorted(WORD_KEYS)}")
        return
    s = w["s"]
    if not all_han(s):
        rep.err(f"word {wid}: s={s!r} is not all Han")
    if wid != word_id(s):
        rep.err(f"word {wid}: id != word_id({s!r}) = {word_id(s)}")
    if not isinstance(w["t"], str) or not w["t"]:
        rep.err(f"word {wid}: bad t")
    elif len(w["t"]) != len(s):
        rep.warn("traditional length differs from simplified", f"{s}/{w['t']}")
    syls = w["p"].split() if isinstance(w["p"], str) else []
    if not syls or not all(SYLLABLE_RE.match(x) for x in syls) or w["p"] != " ".join(syls):
        rep.err(f"word {wid}: pinyin {w['p']!r} is not lowercase numeric-tone with v for ü")
    elif len(syls) != len(s):
        rep.warn("pinyin syllables != characters", f"{s} [{w['p']}]")
    d = w["d"]
    if not isinstance(d, list) or len(d) > 3 or not all(isinstance(g, str) and 0 < len(g) <= 120 for g in d):
        rep.err(f"word {wid}: bad d {d!r}")
    if not d:
        rep.warn("no definition", s)
    if not isinstance(w["hsk"], int) or not 0 <= w["hsk"] <= 6:
        rep.err(f"word {wid}: bad hsk {w['hsk']!r}")
    clips = w["clips"]
    if not isinstance(clips, list) or not clips:
        rep.err(f"word {wid}: has no clips")
        return
    for c in clips:
        if set(c) != WORD_CLIP_KEYS:
            rep.err(f"word {wid}: clip keys {sorted(c)}")
            continue
        if c["src"] == "audio-cmn":
            if c["id"] != acmn_clip_id(s):
                rep.err(f"word {wid}: clip id {c['id']} != {acmn_clip_id(s)}")
            if c["speaker"] != "yue-tan":
                rep.err(f"word {wid}: speaker {c['speaker']}")
        if c["file"] != f"clips/words/{c['id']}.mp3":
            rep.err(f"word {wid}: clip file {c['file']}")
        if not (data_dir / c["file"]).is_file():
            rep.err(f"word {wid}: missing {c['file']}")
        if not isinstance(c["ms"], int) or not 0 < c["ms"] <= MAX_CLIP_MS:
            rep.err(f"word {wid}: ms {c['ms']!r} out of (0, {MAX_CLIP_MS}]")
        elif not WORD_MS_SANE[0] <= c["ms"] <= WORD_MS_SANE[1]:
            rep.warn(f"word clip outside {WORD_MS_SANE[0]}-{WORD_MS_SANE[1]} ms", f"{s} {c['ms']}ms")


def check_sentence(e: dict, rep: Report, data_dir: Path) -> None:
    sid = e.get("id", "?")
    if set(e) - {"en"} != SENT_KEYS:
        rep.err(f"sentence {sid}: keys {sorted(e)} != {sorted(SENT_KEYS)} (+ optional en)")
    if "en" in e and not isinstance(e["en"], str):
        rep.err(f"sentence {sid}: en must be a string")
        return
    text, chars, cp, toks, clip = e["text"], e["chars"], e["cp"], e["tokens"], e["clip"]
    if not (isinstance(chars, list) and isinstance(cp, list) and len(chars) == len(cp) == len(text)):
        rep.err(f"sentence {sid}: lengths text={len(text)} chars={len(chars)} cp={len(cp)}")
        return
    if "".join(chars) != text or not all(is_han(c) for c in chars):
        rep.err(f"sentence {sid}: chars do not spell text / non-Han char")
    if not all(isinstance(p, str) and SYLLABLE_RE.match(p) for p in cp):
        rep.err(f"sentence {sid}: bad cp {cp}")
    if not tiles(toks, len(text)):
        rep.err(f"sentence {sid}: tokens {toks} do not tile [0,{len(text)})")
    required = SENT_CLIP_KEYS if clip.get("src") == "aishell3" else {"src", "file", "ms", "speaker"}
    if (set(clip) != required) if clip.get("src") == "aishell3" else not required <= set(clip):
        rep.err(f"sentence {sid}: clip keys {sorted(clip)}")
        return
    if clip["src"] == "aishell3":
        m = A3_ID_RE.match(sid)
        if not m:
            rep.err(f"sentence {sid}: id is not s_a3_<SSBxxxxxxxx>")
        elif clip["speaker"] != m.group(1):
            rep.err(f"sentence {sid}: speaker {clip['speaker']} != {m.group(1)}")
        if clip["gender"] not in ("female", "male"):
            rep.err(f"sentence {sid}: gender {clip['gender']!r}")
    if clip["file"] != f"clips/sentences/{sid}.mp3":
        rep.err(f"sentence {sid}: clip file {clip['file']}")
    if not (data_dir / clip["file"]).is_file():
        rep.err(f"sentence {sid}: missing {clip['file']}")
    ms = clip["ms"]
    if not isinstance(ms, int) or not 0 < ms <= MAX_CLIP_MS:
        rep.err(f"sentence {sid}: ms {ms!r} out of (0, {MAX_CLIP_MS}]")
    elif not SENT_MS_SANE[0] <= ms <= SENT_MS_SANE[1]:
        rep.warn(f"sentence clip outside {SENT_MS_SANE[0]}-{SENT_MS_SANE[1]} ms", f"{text} {ms}ms")


def check_mp3(path: Path, ms: int, rate: int, kbps: int) -> str | None:
    try:
        info = mp3_info(path)
    except (OSError, ValueError) as ex:
        return f"{path.name}: {ex}"
    if info["channels"] != 1:
        return f"{path.name}: not mono"
    if info["rate"] != rate or info["kbps"] != [kbps]:
        return f"{path.name}: {info['rate']} Hz {info['kbps']} kb/s, expected {rate} Hz {kbps} kb/s"
    if info["ms"] > MAX_CLIP_MS + 60:
        return f"{path.name}: {info['ms']} ms of frames > {MAX_CLIP_MS}"
    if abs(info["ms"] - ms) > 90:
        return f"{path.name}: frame duration {info['ms']} ms vs recorded {ms} ms"
    return None


def trim_check(data_dir: Path, work_dir: Path, words, sentences, n: int) -> tuple[list, list[str]]:
    """Check that silence trimming did not cut into speech.

    For a deterministic sample of N word and N sentence clips, the source is re-encoded with
    the same codec settings but WITHOUT trimming (so codec effects cancel out), and the loud
    span (windows > -40 dBFS, 10 ms) of that reference is compared with the shipped clip.
    Trimming only removes sub -45 dB lead-in/tail, so both spans should match within 30 ms.
    """
    import tempfile

    from common import encode_mp3

    rows, problems = [], []
    pairs = []
    ws = sorted(words, key=lambda w: w["id"])
    for w in ws[:: max(1, len(ws) // n)][:n]:
        src = work_dir / "audio-cmn" / "64k" / "hsk" / f"cmn-{w['s']}.mp3"
        pairs.append(("word", w["s"], src, data_dir / w["clips"][0]["file"], WORD_RATE_HZ, WORD_KBPS))
    ss = sorted([s for s in sentences if s["clip"]["src"] == "aishell3"], key=lambda s: s["id"])
    for s in ss[:: max(1, len(ss) // n)][:n]:
        utt = s["id"][5:]
        src = work_dir / "aishell3" / "wav" / utt[:7] / f"{utt}.wav"
        pairs.append(("sentence", s["text"], src, data_dir / s["clip"]["file"], SENTENCE_RATE_HZ,
                      SENTENCE_KBPS))
    pairs = [p for p in pairs if p[2].exists()]

    with tempfile.TemporaryDirectory() as tmp:
        def one(item):
            i, (kind, label, src, out, rate, kbps) = item
            ref = Path(tmp) / f"ref{i}.mp3"
            ref_ms = encode_mp3(src, ref, rate_hz=rate, kbps=kbps, trim_silence=False)
            a0, a1, _ = sound_extent_ms(ref)
            b0, b1, bt = sound_extent_ms(out)
            return kind, label, ref_ms, bt, a1 - a0, b1 - b0, b0, bt - b1

        with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as ex:
            for r in ex.map(one, enumerate(pairs)):
                rows.append(r)
                kind, label, at, bt, span_src, span_out, lead, tail = r
                if span_out < span_src - 30:
                    problems.append(f"{kind} {label}: loud span {span_src} -> {span_out} ms (speech cut?)")
                if bt > at + 100:
                    problems.append(f"{kind} {label}: trimmed clip longer than source ({at} -> {bt} ms)")
    return rows, problems


def validate(data_dir: Path) -> tuple[Report, dict, list, list]:
    rep = Report()
    manifest = load_min_json(data_dir / "manifest.json", rep)
    if set(manifest) != MANIFEST_KEYS:
        rep.err(f"manifest keys {sorted(manifest)} != {sorted(MANIFEST_KEYS)}")
    if manifest.get("schemaVersion") != 1:
        rep.err("manifest schemaVersion != 1")
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", str(manifest.get("builtAt"))):
        rep.err(f"manifest builtAt {manifest.get('builtAt')!r} is not ISO-8601 UTC")
    if not isinstance(manifest.get("baseUrl"), str):
        rep.err("manifest baseUrl must be a string")
    for s in manifest.get("sources", []):
        if set(s) != SOURCE_KEYS:
            rep.err(f"manifest source keys {sorted(s)}")
    files = manifest.get("files", {})
    if {k: v for k, v in files.items() if k != "dict"} != {"words": "words.json", "sentences": "sentences.json"}:
        rep.err(f"manifest files {files}")
    if "dict" in files:
        dp = data_dir / files["dict"]
        if not dp.exists():
            rep.err(f"manifest files.dict {files['dict']} missing")
        else:
            d = json.loads(dp.read_text(encoding="utf-8"))
            bad = [k for k, v in d.items() if not isinstance(v, dict) or not isinstance(v.get("p"), str)]
            if bad:
                rep.err(f"dict.json: {len(bad)} entries without a pinyin string, e.g. {bad[:3]}")
    words = load_min_json(data_dir / files.get("words", "words.json"), rep)
    sentences = load_min_json(data_dir / files.get("sentences", "sentences.json"), rep)
    counts = manifest.get("counts", {})
    core = {k: v for k, v in counts.items() if k in ("words", "sentences")}
    if core != {"words": len(words), "sentences": len(sentences)}:
        rep.err(f"manifest counts {counts} != actual words={len(words)} sentences={len(sentences)}")
    translated = sum(1 for s in sentences if s.get("en"))
    if "translated" in counts and counts["translated"] != translated:
        rep.err(f"manifest counts.translated {counts['translated']} != actual {translated}")
    src_ids = {s.get("id") for s in manifest.get("sources", [])}

    for kind, items, key in (("word", words, "id"), ("sentence", sentences, "id")):
        ids = Counter(x.get(key) for x in items)
        dups = [i for i, c in ids.items() if c > 1]
        if dups:
            rep.err(f"duplicate {kind} ids: {dups[:5]}")
    dup_s = [s for s, c in Counter(w.get("s") for w in words).items() if c > 1]
    if dup_s:
        rep.err(f"duplicate simplified words: {dup_s[:5]}")

    for w in words:
        check_word(w, rep, data_dir)
        for c in w.get("clips", []):
            if c.get("src") not in src_ids:
                rep.err(f"word {w.get('id')}: clip src {c.get('src')} not in manifest sources")
    for e in sentences:
        check_sentence(e, rep, data_dir)
        if e.get("clip", {}).get("src") not in src_ids:
            rep.err(f"sentence {e.get('id')}: clip src not in manifest sources")

    # Clip files: referenced == present; every file is a mono layer-III MP3 <= 8 s.
    referenced = {}
    for w in words:
        for c in w.get("clips", []):
            referenced[c["file"]] = (c["ms"], WORD_RATE_HZ, WORD_KBPS)
    for e in sentences:
        c = e.get("clip", {})
        if "file" in c:
            referenced[c["file"]] = (c["ms"], SENTENCE_RATE_HZ, SENTENCE_KBPS)
    present = set()
    for sub in ("clips/words", "clips/sentences"):
        d = data_dir / sub
        if d.is_dir():
            present |= {f"{sub}/{p.name}" for p in d.iterdir() if p.is_file()}
    other = [p for p in (data_dir / "clips").rglob("*") if p.is_file()
             and not str(p.relative_to(data_dir)).startswith(("clips/words/", "clips/sentences/"))] \
        if (data_dir / "clips").is_dir() else []
    for p in other:
        rep.err(f"unexpected file {p.relative_to(data_dir)}")
    orphans = sorted(present - set(referenced))
    if orphans:
        rep.err(f"{len(orphans)} clip files not referenced by JSON, e.g. {orphans[:3]}")
    for f in present:
        if not f.endswith(".mp3"):
            rep.err(f"non-mp3 clip {f}")

    def mp3_job(item):
        f, (ms, rate, kbps) = item
        p = data_dir / f
        return check_mp3(p, ms, rate, kbps) if p.exists() else None

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as ex:
        for problem in ex.map(mp3_job, sorted(referenced.items())):
            if problem:
                rep.err(problem)

    total = dir_bytes(data_dir / "clips") if (data_dir / "clips").is_dir() else 0
    if total > MAX_CLIPS_BYTES:
        rep.err(f"clips total {total} bytes > {MAX_CLIPS_BYTES}")
    return rep, manifest, words, sentences


def load_hsk_levels(work_dir: Path) -> dict[str, int] | None:
    lists = work_dir / "audio-cmn" / "lists"
    if not lists.is_dir():
        return None
    from sources.audio_cmn import load_hsk_levels as _load

    return _load(work_dir / "audio-cmn")


def summarize(data_dir: Path, hsk_levels: dict[str, int] | None = None) -> dict:
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    words = json.loads((data_dir / "words.json").read_text(encoding="utf-8"))
    sentences = json.loads((data_dir / "sentences.json").read_text(encoding="utf-8"))
    have = {w["s"] for w in words}
    if hsk_levels is None:
        hsk_levels = {w["s"]: w["hsk"] for w in words if w["hsk"]}
    by_level = {}
    for n in range(1, 7):
        lvl_words = [w for w, l in hsk_levels.items() if l == n]
        with_audio = sum(1 for w in lvl_words if w in have)
        by_level[n] = (with_audio, len(lvl_words) - with_audio)
    non_hsk = sum(1 for w in words if not w["hsk"])
    ak = set(ALWAYS_KNOWN)
    sent_levels = Counter()
    for e in sentences:
        lv = 0
        for a, b in e["tokens"]:
            t = e["text"][a:b]
            lv = max(lv, hsk_levels.get(t) or (1 if t in ak else 7))
        sent_levels[lv] += 1
    speakers = Counter(e["clip"]["speaker"] for e in sentences)
    spk_gender = {}
    for e in sentences:
        spk_gender[e["clip"]["speaker"]] = e["clip"].get("gender", "unknown")
    wms = [w["clips"][0]["ms"] for w in words]
    sms = [e["clip"]["ms"] for e in sentences]
    clips = data_dir / "clips"
    return {
        "builtAt": manifest["builtAt"],
        "counts": manifest["counts"],
        "bytes": {
            "clips_total": dir_bytes(clips) if clips.is_dir() else 0,
            "clips_words": dir_bytes(clips / "words") if (clips / "words").is_dir() else 0,
            "clips_sentences": dir_bytes(clips / "sentences") if (clips / "sentences").is_dir() else 0,
            "words.json": (data_dir / "words.json").stat().st_size,
            "sentences.json": (data_dir / "sentences.json").stat().st_size,
            "manifest.json": (data_dir / "manifest.json").stat().st_size,
        },
        "hsk_words": by_level,
        "non_hsk_words": non_hsk,
        "words_without_definition": sum(1 for w in words if not w["d"]),
        "sentences_by_max_level": dict(sorted(sent_levels.items())),
        "speakers": len(speakers),
        "max_sentences_per_speaker": max(speakers.values()) if speakers else 0,
        "sentences_by_gender": dict(Counter(e["clip"].get("gender", "unknown") for e in sentences)),
        "speakers_by_gender": dict(Counter(spk_gender.values())),
        "word_ms": _stats(wms),
        "sentence_ms": _stats(sms),
    }


def _stats(xs):
    if not xs:
        return {}
    xs = sorted(xs)
    return {"min": xs[0], "median": xs[len(xs) // 2], "mean": round(sum(xs) / len(xs)), "max": xs[-1]}


def format_summary(s: dict) -> str:
    b = s["bytes"]
    mb = lambda x: f"{x / 1e6:.1f} MB"  # noqa: E731
    lines = [
        "=== site/data summary ===",
        f"built at            {s['builtAt']}",
        f"counts              words={s['counts']['words']}  sentences={s['counts']['sentences']}",
        f"clips total         {mb(b['clips_total'])} ({b['clips_total']} bytes; words {mb(b['clips_words'])}, "
        f"sentences {mb(b['clips_sentences'])})",
        f"json                words.json {mb(b['words.json'])}, sentences.json {mb(b['sentences.json'])}, "
        f"manifest.json {b['manifest.json']} B",
        "HSK words           level: with audio / without audio",
    ]
    for n, (w, wo) in s["hsk_words"].items():
        lines.append(f"                    HSK{n}: {w} / {wo}")
    tot_w = sum(v[0] for v in s["hsk_words"].values())
    tot_wo = sum(v[1] for v in s["hsk_words"].values())
    lines.append(f"                    all HSK: {tot_w} / {tot_wo}; non-HSK words with audio: {s['non_hsk_words']}; "
                 f"words without CEDICT definition: {s['words_without_definition']}")
    lv = "  ".join(f"L{k}:{v}" for k, v in s["sentences_by_max_level"].items())
    lines += [
        f"sentences/max HSK   {lv}   (7 = contains a non-HSK token)",
        f"speakers            {s['speakers']} (max {s['max_sentences_per_speaker']} sentences/speaker); "
        f"speakers by gender {s['speakers_by_gender']}",
        f"sentences by gender {s['sentences_by_gender']}",
        f"word clip ms        {s['word_ms']}",
        f"sentence clip ms    {s['sentence_ms']}",
    ]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", type=Path, default=DEFAULT_OUT_DIR)
    ap.add_argument("--work-dir", type=Path, default=DEFAULT_WORK_DIR)
    ap.add_argument("--trim-check", type=int, default=0, metavar="N",
                    help="compare N word + N sentence clips with their sources (needs work dir)")
    args = ap.parse_args(argv)
    rep, _manifest, words, sentences = validate(args.data_dir)
    print(format_summary(summarize(args.data_dir, load_hsk_levels(args.work_dir))))
    if args.trim_check:
        rows, problems = trim_check(args.data_dir, args.work_dir, words, sentences, args.trim_check)
        print(f"\n=== trim check ({len(rows)} clips vs untrimmed re-encodes; loud = > -40 dBFS, 10 ms windows; lead/tail = ms before first / after last loud window) ===")
        print(f"{'kind':8} {'untrim':>7} {'out ms':>7} {'loud ref':>8} {'loud out':>8} {'lead':>5} {'tail':>5}  text")
        for kind, label, at, bt, ss, so, lead, tail in rows[:12] + rows[len(rows) // 2: len(rows) // 2 + 12]:
            print(f"{kind:8} {at:7} {bt:7} {ss:8} {so:8} {lead:5} {tail:5}  {label}")
        for p in problems:
            rep.err("trim: " + p)
        print(f"trim check: {len(problems)} problems")
    print("\n=== invariants ===")
    for kind, n in rep.warnings.most_common():
        print(f"warning: {n} × {kind}; e.g. {', '.join(rep.warning_examples[kind])}")
    for e in rep.errors:
        print("ERROR:", e)
    print("OK: all invariants hold" if not rep.errors else f"FAILED: {len(rep.errors)} errors")
    return 1 if rep.errors else 0


if __name__ == "__main__":
    sys.exit(main())
