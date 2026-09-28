#!/usr/bin/env python3
"""Check sentence clips against their transcripts with Whisper (local, CPU).

For each sentence in site/data/sentences.json, transcribe its clip and compute the character
error rate (CER) against `text`, comparing pinyin without tones so homophones (他/她/它, 的/得)
don't count as errors. Writes pipeline/work/asr_check.json and prints the worst clips.

    pipeline/.venv/bin/pip install openai-whisper
    PATH=<dir with ffmpeg>:$PATH pipeline/.venv/bin/python pipeline/asr_check.py [--limit N]
"""
from __future__ import annotations
import argparse, json, re, sys, time, warnings
from pathlib import Path
warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "pipeline" / "work" / "asr_check.json"
HAN = re.compile(r"[㐀-鿿]")


def syllables(text: str) -> list[str]:
    from pypinyin import lazy_pinyin
    return [p for c, p in zip(text, lazy_pinyin(text)) if HAN.match(c)]


def edit_distance(a: list, b: list) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args(argv)
    import whisper
    sentences = json.loads((ROOT / "site/data/sentences.json").read_text(encoding="utf-8"))
    done = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    todo = [s for s in sentences if s["id"] not in done]
    if args.limit:
        todo = todo[: args.limit]
    model = whisper.load_model(args.model)
    t0 = time.time()
    for i, s in enumerate(todo, 1):
        path = ROOT / "site/data" / s["clip"]["file"]
        r = model.transcribe(str(path), language="zh", fp16=False, initial_prompt="以下是普通话的句子。", condition_on_previous_text=False)
        hyp = "".join(HAN.findall(r["text"]))
        ref_s, hyp_s = syllables(s["text"]), syllables(hyp)
        cer = edit_distance(ref_s, hyp_s) / max(1, len(ref_s))
        done[s["id"]] = {"text": s["text"], "asr": hyp, "cer": round(cer, 3)}
        if i % 25 == 0 or i == len(todo):
            OUT.write_text(json.dumps(done, ensure_ascii=False, indent=0), encoding="utf-8")
            print(f"{i}/{len(todo)} ({time.time() - t0:.0f}s)", flush=True)
    OUT.write_text(json.dumps(done, ensure_ascii=False, indent=0), encoding="utf-8")
    worst = sorted(done.items(), key=lambda kv: -kv[1]["cer"])
    buckets = {k: sum(1 for _, v in done.items() if lo <= v["cer"] < hi) for k, lo, hi in [("<0.1", 0, .1), ("0.1-0.3", .1, .3), ("0.3-0.5", .3, .5), (">=0.5", .5, 9)]}
    print("CER buckets:", buckets)
    for sid, v in worst[:25]:
        print(f"{v['cer']:.2f} {sid} ref={v['text']} asr={v['asr']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
