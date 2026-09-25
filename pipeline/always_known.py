"""Canonical ALWAYS_KNOWN stoplist (PLAN §4.3, §6.4).

Tokens that count as "known" in sentence cards even when they are not in the user's vocab:
high-frequency function characters/words. The web app keeps an identical copy as
`ALWAYS_KNOWN` in site/js/queue.js; pipeline/always_known.json is the same list for tooling,
and pipeline/tests/test_pipeline.py checks that all three agree. Keep it <= 40 items.
"""
ALWAYS_KNOWN = [
    "的", "了", "是", "在", "我", "你", "他", "她", "它", "们",
    "不", "吗", "呢", "吧", "啊", "和", "有", "这", "那", "也",
    "就", "都", "很", "会", "要", "说", "个", "一", "着", "过",
    "地", "得", "我们", "你们", "他们", "她们", "这个", "那个",
]

if __name__ == "__main__":  # regenerate always_known.json
    import json
    from pathlib import Path

    Path(__file__).with_suffix(".json").write_text(
        json.dumps(ALWAYS_KNOWN, ensure_ascii=False) + "\n", encoding="utf-8")
