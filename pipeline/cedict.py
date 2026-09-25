"""Download and parse CC-CEDICT (CC BY-SA 4.0) -> {simplified: [Entry, ...]}.

Pinyin convention of the output (and of words.json `p`): lowercase, numeric tones 1-5
(5 = neutral), syllables separated by single spaces, `v` for ü (CEDICT's `u:`), e.g.
女 -> "nv3", 旅行 -> "lv3 xing2".
"""
from __future__ import annotations

import gzip
import re
from dataclasses import dataclass, field
from pathlib import Path

from common import SYLLABLE_RE, log, normalize_cedict_pinyin

CEDICT_URL = "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz"
CEDICT_FILE = "cedict_1_0_ts_utf-8_mdbg.txt.gz"

LINE_RE = re.compile(r"^(\S+) (\S+) \[([^\]]*)\] /(.*)/\s*$")
VARIANT_RE = re.compile(r"^(?:\(\w+\) )?(?:\w+ )?(?:variant|form) of ([^|\[\s]+)(?:\|([^\[\s]+))?(?:\[([^\]]+)\])?")
JUNK_PREFIXES = ("variant of", "surname", "old variant", "see ")
MAX_GLOSSES = 3
MAX_GLOSS_CHARS = 120


@dataclass
class Entry:
    trad: str
    simp: str
    pinyin_raw: str
    pinyin: str  # normalised (see module docstring)
    glosses: list[str] = field(default_factory=list)

    @property
    def proper_noun(self) -> bool:
        return any(c.isupper() for c in self.pinyin_raw)


def parse_line(line: str) -> Entry | None:
    line = line.rstrip("\n")
    if not line or line.startswith("#"):
        return None
    m = LINE_RE.match(line)
    if not m:
        return None
    trad, simp, py, gl = m.groups()
    glosses = [g.strip() for g in gl.split("/") if g.strip()]
    return Entry(trad, simp, py, normalize_cedict_pinyin(py), glosses)


def parse(lines) -> dict[str, list[Entry]]:
    out: dict[str, list[Entry]] = {}
    for line in lines:
        e = parse_line(line)
        if e:
            out.setdefault(e.simp, []).append(e)
    return out


def download(work_dir: Path) -> Path:
    path = Path(work_dir) / CEDICT_FILE
    if path.exists() and path.stat().st_size > 1_000_000:
        return path
    import requests

    log(f"cedict: downloading {CEDICT_URL}")
    path.parent.mkdir(parents=True, exist_ok=True)
    r = requests.get(CEDICT_URL, timeout=120, headers={"User-Agent": "chinese-audio-flashcards-pipeline"})
    r.raise_for_status()
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(r.content)
    tmp.replace(path)
    return path


def load(work_dir: Path) -> dict[str, list[Entry]]:
    path = download(work_dir)
    with gzip.open(path, "rt", encoding="utf-8") as f:
        d = parse(f)
    log(f"cedict: {sum(len(v) for v in d.values())} entries, {len(d)} simplified headwords")
    return d


def _is_junk(g: str) -> bool:
    return g.lower().startswith(JUNK_PREFIXES)


def _pinyin_ok(word: str, pinyin: str) -> bool:
    syls = pinyin.split()
    return len(syls) == len(word) and all(SYLLABLE_RE.match(s) for s in syls)


def clean_glosses(glosses: list[str]) -> list[str]:
    """Drop classifier lines and (when others exist) variant/surname/see-also glosses;
    dedupe; keep <= 3, each <= 120 chars."""
    gl = [g for g in glosses if not g.startswith("CL:")]
    good = [g for g in gl if not _is_junk(g)]
    if good:
        gl = good
    out: list[str] = []
    for g in gl:
        if len(g) > MAX_GLOSS_CHARS:
            g = g[: MAX_GLOSS_CHARS - 1].rstrip() + "…"
        if g not in out:
            out.append(g)
        if len(out) >= MAX_GLOSSES:
            break
    return out


def choose(word: str, entries: list[Entry], hint_pinyin: str | None = None,
           resolve: dict[str, list[Entry]] | None = None):
    """Pick the reading to show for `word`. Returns (trad, pinyin, glosses) or None.

    Preference: pinyin with one valid syllable per character > common noun (lowercase
    pinyin) > matches pypinyin's reading of the word (a good tie-breaker for 了/行/的 …) >
    has non-junk glosses > CEDICT order. Glosses are gathered from every entry with the
    chosen pinyin, common-noun entries first. If every remaining gloss is a cross-reference
    ("erhua variant of 一點|一点[yi1 dian3]") and `resolve` (the whole dictionary) is given,
    the glosses of the referenced entry are used instead.
    """
    if not entries:
        return None

    def score(ie):
        i, e = ie
        return (
            _pinyin_ok(word, e.pinyin),
            not e.proper_noun,
            hint_pinyin is not None and e.pinyin == hint_pinyin,
            any(not _is_junk(g) and not g.startswith("CL:") for g in e.glosses),
            -i,
        )

    _, best = max(enumerate(entries), key=score)
    same = [e for e in entries if e.pinyin == best.pinyin]
    same.sort(key=lambda e: (e.proper_noun, entries.index(e)))
    glosses: list[str] = []
    for e in same:
        glosses.extend(e.glosses)
    cleaned = clean_glosses(glosses)
    if resolve is not None and cleaned and all(VARIANT_RE.match(g) for g in cleaned):
        # e.g. 一点儿: "erhua variant of 一點|一点[yi1 dian3]" -> glosses of 一点 [yi1 dian3]
        m = VARIANT_RE.match(cleaned[0])
        target_simp, target_py = m.group(2) or m.group(1), normalize_cedict_pinyin(m.group(3) or "")
        targets = [e for e in resolve.get(target_simp, []) if not target_py or e.pinyin == target_py]
        resolved = clean_glosses([g for e in targets for g in e.glosses])
        if resolved and not all(VARIANT_RE.match(g) for g in resolved):
            cleaned = resolved
    return best.trad, best.pinyin, cleaned
