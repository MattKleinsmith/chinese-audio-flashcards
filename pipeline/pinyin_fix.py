#!/usr/bin/env python3
"""Correct per-character pinyin (`cp`) of sentences where the corpus annotation isn't a real
reading of the character.

AISHELL-3 annotates what each speaker actually said, so its pinyin includes regional accents
(你 li3, 是 si4, 丈 zang4 — southern n/l and zh/z mergers) and occasional slips (重 chong4
in 重来, where the word is chong2). A learner should see the standard reading. Rule, per char:

  1. If the corpus syllable (ignoring tone) is one of the character's CC-CEDICT readings, keep it:
     the corpus knows the context (得 dei3, 地 de5, 教 jiao1, 重 chong in 重来).
     Keep its tone too when the difference is explained by tone sandhi or neutralisation
     (3→2 before a 3rd tone, 一/不 changes, neutral tone); otherwise use the dictionary tone.
  2. Otherwise the syllable is an accent or slip: use the word-level CEDICT reading for that
     position if there is one, else the character reading closest to what was said. The
     spoken tone is kept when sandhi explains it.

Used by build.py for new builds; `python pipeline/pinyin_fix.py` fixes site/data/sentences.json
in place (idempotent).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cedict as cedict_mod  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SANDHI_CHARS = set("一不七八")


def split(p: str) -> tuple[str, int]:
    m = re.fullmatch(r"([a-zv]+)([1-5])", p)
    return (m.group(1), int(m.group(2))) if m else (p, 0)


def tone_explained(char: str, spoken: int, dict_tone: int) -> bool:
    """Spoken tone differs from the dictionary tone for a regular reason: 3rd-tone sandhi,
    neutralisation in speech, or the 一/不/七/八 changes."""
    return spoken == dict_tone or spoken == 5 or char in SANDHI_CHARS or (dict_tone == 3 and spoken == 2)


def edit(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


class Fixer:
    def __init__(self, cedict: dict):
        self.cedict = cedict
        self._char = {}
        self._word = {}

    def char_readings(self, c: str) -> list[str]:
        if c not in self._char:
            seen = []
            for e in self.cedict.get(c, []):
                p = e.pinyin.lower()
                if re.fullmatch(r"[a-zv]+[1-5]", p) and p not in seen:
                    seen.append(p)
            self._char[c] = seen
        return self._char[c]

    def word_readings(self, w: str) -> list[list[str]]:
        """Every CEDICT reading of a multi-character word, as syllable lists."""
        if w not in self._word:
            out = []
            for e in self.cedict.get(w, []) if len(w) > 1 else []:
                syl = e.pinyin.lower().split()
                if len(syl) == len(w) and all(re.fullmatch(r"[a-zv]+[1-5]", x) for x in syl) and syl not in out:
                    out.append(syl)
            self._word[w] = out
        return self._word[w]

    def fix_char(self, c: str, spoken: str, word_syls: list[str], context: str | None) -> str:
        readings = self.char_readings(c)
        if not readings or spoken in readings:
            return spoken  # a real reading of this character: the corpus knows the context
        s_base, s_tone = split(spoken)
        if any(w == spoken for w in word_syls):
            return spoken  # e.g. a neutral tone that only the word entry lists
        same_w = [w for w in word_syls if split(w)[0] == s_base]
        same_c = [r for r in readings if split(r)[0] == s_base]

        def rank(r):  # prefer tone explained by sandhi, then the contextual reading, then CEDICT order
            return (not tone_explained(c, s_tone, split(r)[1]), r != context,
                    readings.index(r) if r in readings else 99)

        if same_w:
            target = min(same_w, key=rank)
        elif same_c:
            target = min(same_c, key=rank)
        else:  # accent or slip: nearest reading, the word's reading first
            pool = word_syls or readings
            target = min(pool, key=lambda r: (edit(s_base, split(r)[0]), r != context, split(r)[1] != s_tone,
                                              readings.index(r) if r in readings else 99))
        t_base, t_tone = split(target)
        return f"{t_base}{s_tone}" if tone_explained(c, s_tone, t_tone) else target

    def fix_sentence(self, s: dict) -> int:
        from pypinyin import Style, pinyin
        text, cp = s["text"], s["cp"]
        context = [p[0].replace("ü", "v") for p in pinyin(text, style=Style.TONE3, neutral_tone_with_five=True)]
        if len(context) != len(text):
            context = [None] * len(text)
        word_at: list[list[str]] = [[] for _ in text]
        for a, b in s["tokens"]:
            for syl in self.word_readings(text[a:b]):
                for i in range(a, b):
                    if syl[i - a] not in word_at[i]:
                        word_at[i].append(syl[i - a])
        changed = 0
        for i, c in enumerate(text):
            new = self.fix_char(c, cp[i], word_at[i], context[i])
            if new != cp[i]:
                cp[i] = new
                changed += 1
        return changed


def apply(entries: list[dict], cedict: dict, verbose: bool = False) -> int:
    fx = Fixer(cedict)
    total = 0
    for s in entries:
        before = list(s["cp"])
        n = fx.fix_sentence(s)
        total += n
        if verbose and n:
            diffs = [f"{c} {a}→{b}" for c, a, b in zip(s["text"], before, s["cp"]) if a != b]
            print(f"  {s['text']}: {', '.join(diffs)}")
    return total


def main() -> int:
    path = ROOT / "site" / "data" / "sentences.json"
    sentences = json.loads(path.read_text(encoding="utf-8"))
    cedict = cedict_mod.load(ROOT / "pipeline" / "work")
    n = apply(sentences, cedict, verbose="-v" in sys.argv)
    path.write_text(json.dumps(sentences, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"pinyin_fix: {n} syllables corrected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
