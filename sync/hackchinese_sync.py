#!/usr/bin/env python3
"""Download the "all studied words" export from Hack Chinese into the site bundle.

Runs unattended in GitHub Actions (see .github/workflows/hackchinese-sync.yml) and can also
be run by hand. It signs in with HC_EMAIL / HC_PASSWORD, downloads
https://www.hackchinese.com/all-studied-words.csv, checks that the file looks like a word
list, and writes:

    site/data/user/hackchinese.csv   the export, byte for byte
    site/data/user/sync.json         {"source", "syncedAt", "rows", "sha256"}

The web app fetches these on open and imports any new words with its own format-agnostic
parser (site/js/importer.js), so this script never has to know the CSV's columns.

Nothing secret is ever printed: not the credentials, not cookies, not the CSV contents.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://www.hackchinese.com"
SIGN_IN = f"{BASE}/users/sign_in"
EXPORT = f"{BASE}/all-studied-words.csv"
UA = "chinese-audio-flashcards sync (personal use; github.com/MattKleinsmith/chinese-audio-flashcards)"
HAN = re.compile(r"[㐀-䶿一-鿿豈-﫿]")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sanity_check(data: bytes) -> dict:
    """Raise ValueError unless `data` looks like a CSV/TSV word list. Returns {rows, han_rows}."""
    if not data or len(data) < 4:
        raise ValueError("export is empty")
    text = data.decode("utf-8-sig", errors="replace")
    low = text[:2000].lower()
    if "<html" in low or "<!doctype" in low:
        raise ValueError("export is an HTML page, not a CSV (probably not signed in)")
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    han_rows = sum(1 for r in rows if any(HAN.search(c) for c in r))
    if han_rows == 0:
        raise ValueError("export contains no Chinese characters")
    return {"rows": len(rows), "han_rows": han_rows}


def sign_in(session, email: str, password: str) -> None:
    r = session.get(SIGN_IN, timeout=60)
    r.raise_for_status()
    m = re.search(r'name="authenticity_token"\s+value="([^"]+)"', r.text) or \
        re.search(r'name="csrf-token"\s+content="([^"]+)"', r.text)
    if not m:
        raise RuntimeError("could not find the sign-in CSRF token (page layout changed?)")
    token = html.unescape(m.group(1))
    r = session.post(SIGN_IN, data={
        "authenticity_token": token,
        "user[email]": email,
        "user[password]": password,
        "user[remember_me]": "1",
        "commit": "Sign in",
    }, headers={"Referer": SIGN_IN}, timeout=60, allow_redirects=True)
    r.raise_for_status()
    signed_in = "/users/sign_out" in r.text or "sign_out" in r.text or r.url.rstrip("/") != SIGN_IN.rstrip("/")
    if not signed_in or "Invalid Email or password" in r.text:
        raise RuntimeError("sign-in failed (check HC_EMAIL / HC_PASSWORD)")


def download(session) -> bytes:
    r = session.get(EXPORT, headers={"Accept": "text/csv,*/*"}, timeout=120)
    r.raise_for_status()
    return r.content


def write_outputs(data: bytes, out_dir: Path, info: dict) -> bool:
    """Write the CSV and sync.json. Returns True if the word list changed."""
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "hackchinese.csv"
    meta_path = out_dir / "sync.json"
    digest = sha256(data)
    changed = not csv_path.exists() or sha256(csv_path.read_bytes()) != digest
    if changed:
        csv_path.write_bytes(data)
    meta = {
        "source": "hackchinese",
        "url": EXPORT,
        "syncedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "rows": info["rows"],
        "sha256": digest,
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changed


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out-dir", default="site/data/user", help="where to write hackchinese.csv and sync.json")
    ap.add_argument("--csv", help="offline mode: use this already-exported CSV instead of signing in")
    args = ap.parse_args(argv)
    out_dir = Path(args.out_dir)

    if args.csv:
        data = Path(args.csv).read_bytes()
    else:
        import requests  # only needed online
        email, password = os.environ.get("HC_EMAIL", ""), os.environ.get("HC_PASSWORD", "")
        if not email or not password:
            print("HC_EMAIL and HC_PASSWORD must be set (as GitHub Actions secrets or env vars)", file=sys.stderr)
            return 2
        s = requests.Session()
        s.headers["User-Agent"] = UA
        for attempt in range(1, 4):
            try:
                sign_in(s, email, password)
                data = download(s)
                break
            except Exception as e:  # noqa: BLE001 - retry any network/login hiccup, then fail loudly
                print(f"attempt {attempt} failed: {e}", file=sys.stderr)
                if attempt == 3:
                    return 1
                time.sleep(5 * attempt)

    try:
        info = sanity_check(data)
    except ValueError as e:
        print(f"refusing to write export: {e}", file=sys.stderr)
        return 1
    changed = write_outputs(data, out_dir, info)
    print(f"ok: {info['rows']} rows ({info['han_rows']} with Chinese), {len(data)} bytes, {'changed' if changed else 'unchanged'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
