"""Transcript-only sentence selection (PLAN §6.4).

Two stages, both computed from transcripts alone:

1. `analyze()` + `is_candidate()` — a per-sentence filter (coverage of tokens in
   HSK 1-6 ∪ ALWAYS_KNOWN >= the floor, 0.70). It is independent per sentence, so aishell3.py can apply it as the
   keep-filter while the tarball streams by, whatever order transcripts and WAVs arrive in.
2. `select()` — a greedy, diversity-aware pick of up to N sentences among the candidates whose
   audio turned out to be available (a byte-range prefix of the tarball only holds some WAVs).

Score = coverage*10 - 0.5*maxLevel - 0.05*len(text) + 2 * (#HSK tokens not yet seen in a
selected sentence), with at most `per_speaker_cap` (40) sentences per speaker. Only sentences
with coverage >= 0.85 are admitted first; if they cannot fill N (a 3 GB prefix of AISHELL-3
has only ~1,150 such sentences with audio), lower tiers (0.80, 0.75, 0.70) are admitted in
turn, and as a last resort the per-speaker cap is doubled. Each relaxation is logged.
"""
from __future__ import annotations

import heapq
import logging
from collections import Counter
from dataclasses import dataclass, field

from always_known import ALWAYS_KNOWN

MIN_COVERAGE = 0.85      # preferred threshold (PLAN §6.4)
COVERAGE_FLOOR = 0.70    # lowest tier admitted if 0.85 cannot fill N (logged)
PER_SPEAKER_CAP = 40
NON_HSK_LEVEL = 7

_jieba = None


def tokenizer():
    global _jieba
    if _jieba is None:
        import jieba

        jieba.setLogLevel(logging.WARNING)
        jieba.initialize()
        _jieba = jieba
    return _jieba


def token_spans(text: str) -> list[list[int]]:
    """jieba.lcut(text, HMM=True) as [start, end) char spans that tile `text`."""
    spans, pos = [], 0
    for tok in tokenizer().lcut(text, HMM=True):
        if not tok:
            continue
        spans.append([pos, pos + len(tok)])
        pos += len(tok)
    if pos != len(text):  # jieba never drops characters, but guard anyway
        raise ValueError(f"tokens do not tile {text!r}")
    return spans


@dataclass
class Analysis:
    utt: str
    speaker: str
    text: str
    tokens: list[list[int]]
    coverage: float
    max_level: int
    hsk_tokens: frozenset = field(default_factory=frozenset)

    @property
    def base_score(self) -> float:
        return self.coverage * 10 - 0.5 * self.max_level - 0.05 * len(self.text)


def analyze(utt: str, speaker: str, text: str, hsk_levels: dict[str, int],
            always_known=ALWAYS_KNOWN, tokens: list[list[int]] | None = None) -> Analysis:
    tokens = tokens if tokens is not None else token_spans(text)
    ak = set(always_known)
    covered, max_level, hsk_tokens = 0, 0, set()
    for a, b in tokens:
        tok = text[a:b]
        lvl = hsk_levels.get(tok)
        if lvl:
            covered += 1
            hsk_tokens.add(tok)
            max_level = max(max_level, lvl)
        elif tok in ak:
            covered += 1
            max_level = max(max_level, 1)
        else:
            max_level = NON_HSK_LEVEL
    coverage = covered / len(tokens) if tokens else 0.0
    return Analysis(utt, speaker, text, tokens, coverage, max_level, frozenset(hsk_tokens))


def is_candidate(a: Analysis, floor: float = COVERAGE_FLOOR) -> bool:
    return a.coverage >= floor - 1e-9


def coverage_tiers(min_coverage: float = MIN_COVERAGE, floor: float = COVERAGE_FLOOR,
                   step: float = 0.05) -> list[float]:
    """[0.85, 0.80, 0.75, 0.70] for the defaults: thresholds tried in order."""
    tiers, t = [], min_coverage
    while t >= floor - 1e-9:
        tiers.append(round(t, 4))
        t -= step
    return tiers or [floor]


def select(cands: list[Analysis], n: int, per_speaker_cap: int = PER_SPEAKER_CAP,
           relax: bool = True, log=print, tiers: list[float] | None = None) -> list[Analysis]:
    """Lazy-greedy selection (the new-token bonus only shrinks, so stale heap scores are
    upper bounds). Deterministic: ties break on utterance id.

    Candidates are admitted in coverage tiers (default: only coverage >= 0.85). When a tier
    cannot fill N, the next lower tier is admitted (continuing the same greedy state); when
    all tiers are exhausted, the per-speaker cap is doubled. Every relaxation is logged.
    """
    tiers = tiers or [0.0]
    seen: set[str] = set()
    per_spk: Counter = Counter()
    chosen: list[Analysis] = []
    chosen_ids: set[str] = set()
    cap = per_speaker_cap

    def run(pool: list[Analysis], cap: int) -> None:
        heap = [(-(a.base_score + 2 * len(a.hsk_tokens - seen)), a.utt, i)
                for i, a in enumerate(pool)]
        heapq.heapify(heap)
        while heap and len(chosen) < n:
            _neg, utt, i = heapq.heappop(heap)
            a = pool[i]
            score = a.base_score + 2 * len(a.hsk_tokens - seen)
            if heap and score < -heap[0][0] - 1e-9:
                heapq.heappush(heap, (-score, utt, i))
                continue
            if per_spk[a.speaker] >= cap:
                continue
            chosen.append(a)
            chosen_ids.add(a.utt)
            per_spk[a.speaker] += 1
            seen.update(a.hsk_tokens)

    ordered = sorted(cands, key=lambda a: a.utt)
    for k, tier in enumerate(tiers):
        if k:
            log(f"select: only {len(chosen)}/{n} sentences at coverage >= {tiers[k - 1]}; "
                f"admitting coverage >= {tier}")
        run([a for a in ordered if a.coverage >= tier - 1e-9 and a.utt not in chosen_ids], cap)
        if len(chosen) >= n:
            return chosen
    while relax and len(chosen) < n:
        left = [a for a in ordered if a.coverage >= tiers[-1] - 1e-9 and a.utt not in chosen_ids]
        if not left or all(per_spk[a.speaker] < cap for a in left):
            break  # nothing is blocked by the cap any more
        cap *= 2
        log(f"select: only {len(chosen)}/{n} sentences under the per-speaker cap; relaxing cap "
            f"to {cap}")
        run(left, cap)
    return chosen


def distribution(sel: list[Analysis], speaker_info: dict | None = None) -> dict:
    speaker_info = speaker_info or {}
    by_level = Counter(a.max_level for a in sel)
    spk = Counter(a.speaker for a in sel)
    gender = Counter(speaker_info.get(a.speaker, {}).get("gender", "unknown") for a in sel)
    new_tokens = set().union(*[a.hsk_tokens for a in sel]) if sel else set()
    return {
        "sentences": len(sel),
        "by_max_level": {str(k): by_level[k] for k in sorted(by_level)},
        "speakers": len(spk),
        "max_per_speaker": max(spk.values()) if spk else 0,
        "gender": dict(sorted(gender.items())),
        "distinct_hsk_tokens": len(new_tokens),
        "mean_len": round(sum(len(a.text) for a in sel) / len(sel), 1) if sel else 0,
    }


def format_distribution(d: dict) -> str:
    lv = ", ".join(f"L{k}:{v}" for k, v in d["by_max_level"].items())
    return (f"{d['sentences']} sentences | by max HSK level: {lv} | speakers: {d['speakers']} "
            f"(max {d['max_per_speaker']}/speaker) | gender: {d['gender']} | distinct HSK "
            f"tokens covered: {d['distinct_hsk_tokens']} | mean length {d['mean_len']} chars")
