#!/usr/bin/env python3
"""Remove the sentences listed in pipeline/exclude.json from site/data (JSON, clips, manifest
counts). Idempotent. build.py applies the same list when it builds a bundle from scratch."""
from __future__ import annotations
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data"


def excluded_ids() -> set[str]:
    p = ROOT / "pipeline" / "exclude.json"
    return set(json.loads(p.read_text(encoding="utf-8")).get("sentences", {})) if p.exists() else set()


def main() -> int:
    ids = excluded_ids()
    sp = DATA / "sentences.json"
    sentences = json.loads(sp.read_text(encoding="utf-8"))
    keep = [s for s in sentences if s["id"] not in ids]
    removed = [s for s in sentences if s["id"] in ids]
    for s in removed:
        (DATA / s["clip"]["file"]).unlink(missing_ok=True)
    sp.write_text(json.dumps(keep, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    mp = DATA / "manifest.json"
    m = json.loads(mp.read_text(encoding="utf-8"))
    m["counts"]["sentences"] = len(keep)
    if "translated" in m["counts"]:
        m["counts"]["translated"] = sum(1 for s in keep if s.get("en"))
    mp.write_text(json.dumps(m, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"exclude: removed {len(removed)} sentences, {len(keep)} remain")
    return 0


if __name__ == "__main__":
    sys.exit(main())
