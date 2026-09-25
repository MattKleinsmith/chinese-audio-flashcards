"""TTS source interface (PLAN §2 "TTS"): NOT implemented in v1, by design.

The user prefers real human speech. This stub fixes the interface a future TTS source must
implement so it can be plugged into build.py. Every clip it produces MUST be marked
`synthetic: true` (both in its manifest `sources` entry and in the clip object), so the app can
show a "synthetic" badge.
"""
from __future__ import annotations

from pathlib import Path

SOURCE = {
    "id": "tts", "name": "Text-to-speech (not implemented)", "license": "n/a",
    "url": "", "kind": "word", "synthetic": True,
}


class TTSSource:
    """Interface for a synthetic-speech source."""

    source = SOURCE
    synthetic = True

    def voices(self) -> list[str]:
        raise NotImplementedError("TTS is intentionally not part of v1")

    def synthesize(self, text: str, dst: Path, *, voice: str | None = None,
                   rate_hz: int = 24000, kbps: int = 48) -> int:
        """Render `text` to a mono MP3 at `dst`; return its duration in ms."""
        raise NotImplementedError("TTS is intentionally not part of v1")


def synthesize(text: str, dst: Path, **kw) -> int:
    return TTSSource().synthesize(text, dst, **kw)
