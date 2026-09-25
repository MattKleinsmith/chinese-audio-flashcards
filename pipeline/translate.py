#!/usr/bin/env python3
"""Add English translations (`en`) to site/data/sentences.json.

The audio corpora provide transcripts but no meaning, so this step fills in a sentence-level
gloss. Provider "opus-mt" runs Helsinki-NLP/opus-mt-zh-en locally (free, no key; decent for
short sentences, clearly labelled as machine translation in the app). Results are cached in
pipeline/work/translations.json keyed by sentence text, so rebuilds only translate new
sentences.

    pipeline/.venv/bin/pip install -r pipeline/requirements-translate.txt
    pipeline/.venv/bin/python pipeline/translate.py            # fills missing `en`
    pipeline/.venv/bin/python pipeline/translate.py --force    # retranslate everything
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SENTENCES = ROOT / "site" / "data" / "sentences.json"
MANIFEST = ROOT / "site" / "data" / "manifest.json"
CACHE = ROOT / "pipeline" / "work" / "translations.json"

SOURCE = {
    "id": "opus-mt-zh-en", "name": "Helsinki-NLP opus-mt-zh-en (machine translation)",
    "license": "CC BY 4.0", "url": "https://huggingface.co/Helsinki-NLP/opus-mt-zh-en",
    "kind": "translation", "synthetic": True,
}


def clean(en: str) -> str:
    en = " ".join(en.split()).strip()
    if en and en[-1] not in ".!?…\"'”’" and len(en) > 1:
        en += "."
    return en[:1].upper() + en[1:] if en else en


class OpusMT:
    def __init__(self, beams: int = 4):
        from transformers import MarianMTModel, MarianTokenizer  # heavy; imported lazily
        name = "Helsinki-NLP/opus-mt-zh-en"
        self.tok = MarianTokenizer.from_pretrained(name)
        self.model = MarianMTModel.from_pretrained(name)
        self.beams = beams

    def translate(self, texts: list[str]) -> list[str]:
        batch = self.tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=128)
        out = self.model.generate(**batch, num_beams=self.beams, max_new_tokens=80)
        return [clean(t) for t in self.tok.batch_decode(out, skip_special_tokens=True)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--provider", choices=["opus-mt"], default="opus-mt")
    ap.add_argument("--batch", type=int, default=24)
    ap.add_argument("--force", action="store_true", help="retranslate even if `en` or a cache entry exists")
    ap.add_argument("--limit", type=int, default=0, help="only translate the first N missing (for smoke tests)")
    args = ap.parse_args(argv)

    sentences = json.loads(SENTENCES.read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() and not args.force else {}
    todo = [s for s in sentences if args.force or not s.get("en")]
    for s in todo:
        if not args.force and s["text"] in cache:
            s["en"] = cache[s["text"]]
    todo = [s for s in todo if args.force or not s.get("en")]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(sentences)} sentences; {len(todo)} to translate with {args.provider}", flush=True)

    if todo:
        mt = OpusMT()
        t0 = time.time()
        for i in range(0, len(todo), args.batch):
            chunk = todo[i:i + args.batch]
            for s, en in zip(chunk, mt.translate([s["text"] for s in chunk])):
                s["en"] = en
                cache[s["text"]] = en
            done = min(i + args.batch, len(todo))
            if done % (args.batch * 10) == 0 or done == len(todo):
                print(f"  {done}/{len(todo)} ({time.time() - t0:.0f}s)", flush=True)
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")

    SENTENCES.write_text(json.dumps(sentences, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    manifest["sources"] = [x for x in manifest.get("sources", []) if x.get("id") != SOURCE["id"]] + [SOURCE]
    manifest["counts"]["translated"] = sum(1 for s in sentences if s.get("en"))
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"done: {manifest['counts']['translated']}/{len(sentences)} sentences have `en`")
    return 0


if __name__ == "__main__":
    sys.exit(main())
