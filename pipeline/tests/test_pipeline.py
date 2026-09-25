"""Pipeline unit tests (no network, no ffmpeg, no corpus files needed).

    pipeline/.venv/bin/python -m unittest discover -s pipeline/tests -v
"""
from __future__ import annotations

import io
import json
import random
import re
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

PIPELINE = Path(__file__).resolve().parent.parent
REPO = PIPELINE.parent
sys.path.insert(0, str(PIPELINE))

import cedict  # noqa: E402
import common  # noqa: E402
import select_sentences as sel  # noqa: E402
import validate  # noqa: E402
from always_known import ALWAYS_KNOWN  # noqa: E402
from sources import aishell3, audio_cmn, tatoeba, tts_stub  # noqa: E402


class TestIds(unittest.TestCase):
    def test_word_id(self):
        self.assertEqual(common.word_id("学习"), "w_5b66_4e60")
        self.assertEqual(common.word_id("一"), "w_4e00")
        self.assertEqual(common.word_id("𠀀"), "w_20000")
        with self.assertRaises(ValueError):
            common.word_id("")

    def test_clip_and_sentence_ids(self):
        self.assertEqual(common.acmn_clip_id("学习"), "c_acmn_5b66_4e60")
        self.assertEqual(common.sentence_id("a3", "SSB06930002"), "s_a3_SSB06930002")
        with self.assertRaises(ValueError):
            common.sentence_id("a3", "SSB/../x")

    def test_ids_are_content_derived(self):
        self.assertEqual(common.word_id("图书馆"), common.word_id("图书馆"))
        self.assertNotEqual(common.word_id("图书"), common.word_id("图书馆"))


class TestPinyin(unittest.TestCase):
    def test_marks(self):
        cases = {
            "xue2 xi2": "xué xí", "lv4": "lǜ", "nv3": "nǚ", "de5": "de", "er2": "ér",
            "xiong2": "xióng", "liu2": "liú", "gui4": "guì", "hao3": "hǎo", "zhou1": "zhōu",
            "lve4": "lüè", "peng2 you5": "péng you", "r5": "r",
        }
        for num, marks in cases.items():
            self.assertEqual(common.numeric_to_marks(num), marks, num)

    def test_cedict_normalisation(self):
        self.assertEqual(common.normalize_cedict_pinyin("lu:4"), "lv4")
        self.assertEqual(common.normalize_cedict_pinyin("Bei3  jing1"), "bei3 jing1")
        self.assertEqual(common.normalize_cedict_pinyin("nü3"), "nv3")

    def test_syllable_re(self):
        for ok in ("xue2", "lv4", "de5", "r5", "ng2", "m2", "zhuang1"):
            self.assertTrue(common.SYLLABLE_RE.match(ok), ok)
        for bad in ("xue", "Xue2", "lu:4", "xue6", "2", "dianr3x"):
            self.assertFalse(common.SYLLABLE_RE.match(bad), bad)

    def test_fallback_pinyin_uses_v(self):
        self.assertEqual(common.fallback_pinyin("绿"), "lv4")
        self.assertEqual(common.fallback_pinyin("桌子"), "zhuo1 zi5")


class TestCedict(unittest.TestCase):
    LINES = [
        "# comment",
        "圖書館 图书馆 [tu2 shu1 guan3] /library/CL:家[jia1],個|个[ge4]/",
        "綠 绿 [lu:4] /green/",
        "長 长 [chang2] /long/length/",
        "長 长 [zhang3] /chief/head/elder/",
        "王 王 [Wang2] /surname Wang/",
        "王 王 [wang2] /king or monarch/best or strongest of its type/",
        "一點 一点 [yi1 dian3] /a bit; a little/",
        "一點兒 一点儿 [yi1 dian3 r5] /erhua variant of 一點|一点[yi1 dian3]/",
        "著 着 [zhe5] /aspect particle/",
        "garbage line",
    ]

    def setUp(self):
        self.d = cedict.parse(self.LINES)

    def test_parse(self):
        self.assertEqual(len(self.d["长"]), 2)
        e = self.d["图书馆"][0]
        self.assertEqual((e.trad, e.pinyin, e.glosses[0]), ("圖書館", "tu2 shu1 guan3", "library"))
        self.assertEqual(self.d["绿"][0].pinyin, "lv4")
        self.assertNotIn("garbage", self.d)

    def test_choose(self):
        trad, py, gl = cedict.choose("图书馆", self.d["图书馆"])
        self.assertEqual((trad, py, gl), ("圖書館", "tu2 shu1 guan3", ["library"]))  # CL: dropped
        self.assertEqual(cedict.choose("长", self.d["长"], "zhang3")[1], "zhang3")
        self.assertEqual(cedict.choose("长", self.d["长"], "chang2")[1], "chang2")
        # common noun reading beats the capitalised surname entry
        trad, py, gl = cedict.choose("王", self.d["王"], "wang2")
        self.assertEqual(py, "wang2")
        self.assertEqual(gl[0], "king or monarch")
        self.assertNotIn("surname Wang", gl)
        self.assertIsNone(cedict.choose("无", []))

    def test_variant_resolution(self):
        _, py, gl = cedict.choose("一点儿", self.d["一点儿"], resolve=self.d)
        self.assertEqual((py, gl), ("yi1 dian3 r5", ["a bit; a little"]))

    def test_clean_glosses(self):
        gl = cedict.clean_glosses(["variant of X", "surname Li", "plum", "x" * 200, "a", "b"])
        self.assertEqual(len(gl), 3)
        self.assertEqual(gl[0], "plum")
        self.assertLessEqual(len(gl[1]), 120)
        self.assertEqual(cedict.clean_glosses(["variant of 們|们[men5]"]), ["variant of 們|们[men5]"])


class TestAudioCmn(unittest.TestCase):
    def test_filenames(self):
        self.assertEqual(audio_cmn.word_from_filename("cmn-学习.mp3"), "学习")
        self.assertIsNone(audio_cmn.word_from_filename("cmn-一_也_.mp3"))
        self.assertIsNone(audio_cmn.word_from_filename("cmn-从(到).mp3"))
        self.assertIsNone(audio_cmn.word_from_filename("cmn-abc.mp3"))
        self.assertIsNone(audio_cmn.word_from_filename("README.md"))

    def test_hsk_list(self):
        self.assertEqual(audio_cmn.parse_hsk_list("﻿HSK1\n的\n我\n\n你"), ["的", "我", "你"])
        self.assertEqual(audio_cmn.parse_hsk_list("的\n我"), ["的", "我"])

    def test_make_entry(self):
        d = cedict.parse(TestCedict.LINES)
        e = audio_cmn.make_entry("图书馆", d, {"图书馆": 3})
        self.assertEqual(e, {"id": "w_56fe_4e66_9986", "s": "图书馆", "t": "圖書館",
                             "p": "tu2 shu1 guan3", "d": ["library"], "hsk": 3, "clips": []})
        e = audio_cmn.make_entry("桌子", d, {"桌子": 1})  # not in the mini CEDICT
        self.assertEqual((e["t"], e["p"], e["d"]), ("桌子", "zhuo1 zi5", []))
        self.assertIsNone(audio_cmn.make_entry("电脑", d, {}))  # neither CEDICT nor HSK
        self.assertEqual(audio_cmn.make_entry("长", d, {"长": 2})["p"], "chang2")


class TestTranscripts(unittest.TestCase):
    def test_parse_ok(self):
        line = "SSB06930002.wav\t武 wu3 术 shu4 始 shi3 终 zhong1 被 bei4 看 kan4 作 zuo4 我 wo3 国 guo2 的 de5 国 guo2 粹 cui4\n"
        (utt, chars, cp), reason = aishell3.parse_transcript_line(line)
        self.assertIsNone(reason)
        self.assertEqual(utt, "SSB06930002")
        self.assertEqual("".join(chars), "武术始终被看作我国的国粹")
        self.assertEqual(len(chars), len(cp))
        self.assertEqual(cp[9], "de5")

    def test_parse_trailing_space_and_nv(self):
        (utt, chars, cp), _ = aishell3.parse_transcript_line("SSB00050001.wav\t女 nv3 儿 er2 很 hen3 好 hao3 ")
        self.assertEqual(cp, ["nv3", "er2", "hen3", "hao3"])

    def test_parse_rejects(self):
        cases = {
            "SSB06930026.wav\t九 jiu3 千 qian1 二 er4 点儿 dianr3 一 yi1 七 qi1": "erhua",
            "SSB00050002.wav\t我 wo3 爱 ai4 A ei1 你 ni3": "non-han",
            "SSB00050003.wav\t我 wo3 爱 ai4 你": "odd-tokens",
            "SSB00050004.wav\t我 wo3 爱 ai4": "length",
            "SSB00050005.wav\t我 wo3 爱 ai4 你 ni 们 men5": "bad-pinyin",
            "hello world": "malformed",
            "": "empty",
        }
        for line, reason in cases.items():
            res, why = aishell3.parse_transcript_line(line)
            self.assertIsNone(res, line)
            self.assertEqual(why, reason, line)
        long = "SSB00050006.wav\t" + " ".join(["我 wo3"] * 23)
        self.assertEqual(aishell3.parse_transcript_line(long)[1], "length")

    def test_spk_info(self):
        text = "# voice-file name; age group; gender; accent\n\nSSB1837\tB\tfemale\tnorth\nSSB0005\tC\tmale\tsouth\n"
        info = aishell3.parse_spk_info(text)
        self.assertEqual(info["SSB1837"], {"age": "B", "gender": "female", "accent": "north"})
        self.assertEqual(len(info), 2)
        self.assertEqual(aishell3.speaker_of("SSB18370001"), "SSB1837")


class TestTokens(unittest.TestCase):
    def test_spans_tile(self):
        for text in ("武术始终被看作我国的国粹", "我们今天去图书馆学习", "新政的推出是一项长远的制度安排", "好"):
            spans = sel.token_spans(text)
            self.assertTrue(validate.tiles(spans, len(text)), (text, spans))
            self.assertEqual("".join(text[a:b] for a, b in spans), text)

    def test_tiles_rejects(self):
        self.assertFalse(validate.tiles([[0, 2], [3, 4]], 4))
        self.assertFalse(validate.tiles([[0, 2], [2, 3]], 4))
        self.assertFalse(validate.tiles([[0, 0], [0, 4]], 4))
        self.assertFalse(validate.tiles([], 0))
        self.assertTrue(validate.tiles([[0, 1], [1, 4]], 4))


class TestSelection(unittest.TestCase):
    HSK = {"我们": 1, "今天": 1, "去": 1, "图书馆": 3, "学习": 1, "喜欢": 1, "咖啡": 2, "经济": 4}

    def mk(self, utt, text, tokens):
        pos, spans = 0, []
        for t in tokens:
            spans.append([pos, pos + len(t)])
            pos += len(t)
        assert pos == len(text)
        return sel.analyze(utt, utt[:7], text, self.HSK, tokens=spans)

    def test_analyze(self):
        a = self.mk("SSB00010001", "我们今天去图书馆学习", ["我们", "今天", "去", "图书馆", "学习"])
        self.assertEqual((a.coverage, a.max_level), (1.0, 3))
        b = self.mk("SSB00010002", "我喜欢咖啡因", ["我", "喜欢", "咖啡因"])
        self.assertAlmostEqual(b.coverage, 2 / 3)
        self.assertEqual(b.max_level, 7)
        self.assertFalse(sel.is_candidate(b))
        self.assertTrue(sel.is_candidate(a))
        self.assertEqual(b.hsk_tokens, frozenset({"喜欢"}))  # 我 is ALWAYS_KNOWN, not HSK here

    def test_select_diversity_and_cap(self):
        cands = [self.mk("SSB00010001", "我们今天去图书馆学习", ["我们", "今天", "去", "图书馆", "学习"]),
                 self.mk("SSB00010002", "我们今天去图书馆学习", ["我们", "今天", "去", "图书馆", "学习"]),
                 self.mk("SSB00020001", "我喜欢咖啡", ["我", "喜欢", "咖啡"])]
        chosen = sel.select(cands, 2, per_speaker_cap=40, log=lambda *a: None)
        # the duplicate adds no new tokens, so the diverse sentence wins the second slot
        self.assertEqual([a.utt for a in chosen], ["SSB00010001", "SSB00020001"])
        chosen = sel.select(cands, 3, per_speaker_cap=1, relax=False, log=lambda *a: None)
        self.assertEqual(len(chosen), 2)
        chosen = sel.select(cands, 3, per_speaker_cap=1, relax=True, log=lambda *a: None)
        self.assertEqual(len(chosen), 3)
        d = sel.distribution(chosen, {"SSB0001": {"gender": "female"}})
        self.assertEqual(d["speakers"], 2)
        self.assertEqual(d["gender"], {"female": 2, "unknown": 1})

    def test_coverage_tiers(self):
        self.assertEqual(sel.coverage_tiers(), [0.85, 0.8, 0.75, 0.7])
        hi = self.mk("SSB00010001", "我们今天去图书馆学习", ["我们", "今天", "去", "图书馆", "学习"])
        lo = self.mk("SSB00020001", "我喜欢咖啡因", ["我", "喜欢", "咖啡因"])  # coverage 2/3
        logs = []
        chosen = sel.select([hi, lo], 2, tiers=[0.85, 0.6], log=logs.append)
        self.assertEqual([a.utt for a in chosen], ["SSB00010001", "SSB00020001"])
        self.assertTrue(any("admitting coverage >= 0.6" in m for m in logs))
        self.assertEqual(len(sel.select([hi, lo], 2, tiers=[0.85], log=logs.append)), 1)

    def test_select_deterministic(self):
        cands = [self.mk(f"SSB000{i}0001", "我喜欢咖啡", ["我", "喜欢", "咖啡"]) for i in range(1, 6)]
        a = [x.utt for x in sel.select(cands, 3, log=lambda *a: None)]
        b = [x.utt for x in sel.select(list(reversed(cands)), 3, log=lambda *a: None)]
        self.assertEqual(a, b)


class TestAlwaysKnown(unittest.TestCase):
    def test_list(self):
        self.assertLessEqual(len(ALWAYS_KNOWN), 40)
        self.assertEqual(len(ALWAYS_KNOWN), len(set(ALWAYS_KNOWN)))
        for w in ("的", "了", "是", "在", "我", "你", "他", "不", "吗", "说"):
            self.assertIn(w, ALWAYS_KNOWN)
        self.assertTrue(all(common.all_han(w) for w in ALWAYS_KNOWN))

    def test_json_copy_matches(self):
        data = json.loads((PIPELINE / "always_known.json").read_text(encoding="utf-8"))
        self.assertEqual(data, ALWAYS_KNOWN)

    def test_js_copy_matches(self):
        """site/js/queue.js must define the same ALWAYS_KNOWN list (PLAN §4.3, §6.4)."""
        js = REPO / "site" / "js" / "queue.js"
        if not js.exists():
            self.skipTest("site/js/queue.js not present")
        src = js.read_text(encoding="utf-8")
        m = re.search(r"ALWAYS_KNOWN\s*=\s*(?:new\s+Set\s*\(\s*)?(?:Object\.freeze\s*\(\s*)?\[(.*?)\]", src, re.S)
        self.assertIsNotNone(m, "ALWAYS_KNOWN array literal not found in queue.js")
        items = re.findall(r"""['"`]([^'"`]+)['"`]""", m.group(1))
        self.assertEqual(sorted(items), sorted(ALWAYS_KNOWN))


class TestStreaming(unittest.TestCase):
    """aishell3.stream on a tiny synthetic tarball, truncated like a byte-range prefix."""

    def _wav(self, ms=2000):
        import wave

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * (16 * ms))
        return buf.getvalue()

    def test_stream_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            content = ("SSB00010001.wav\t我 wo3 们 men5 今 jin1 天 tian1 学 xue2 习 xi2\n"
                       "SSB00010002.wav\t武 wu3 术 shu4 始 shi3 终 zhong1\n"
                       "SSB00010003.wav\t九 jiu3 点儿 dianr3 一 yi1 七 qi1\n")
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                def add(name, data):
                    ti = tarfile.TarInfo(name)
                    ti.size = len(data)
                    tf.addfile(ti, io.BytesIO(data))
                add("spk-info.txt", b"# header\nSSB0001\tB\tfemale\tnorth\n")
                add("test/content.txt", content.encode())
                for i in (1, 2, 3):
                    add(f"test/wav/SSB0001/SSB0001000{i}.wav", self._wav())
                for i in range(4, 9):  # padding so truncation hits inside WAV data
                    add(f"test/wav/SSB0001/SSB0001000{i}.wav", random.Random(i).randbytes(100_000))
            data = buf.getvalue()
            tar = tmp / "prefix.tgz"
            tar.write_bytes(data[: int(len(data) * 0.8)])
            kept = []

            def keep(utt, spk, chars, cp):
                kept.append(utt)
                return utt != "SSB00010002"

            idx = aishell3.stream(tar, tmp / "work", keep)
            self.assertEqual(idx["available"], ["SSB00010001"])
            self.assertEqual(sorted(kept), ["SSB00010001", "SSB00010002"])  # erhua line rejected
            self.assertEqual(idx["spk"]["SSB0001"]["gender"], "female")
            self.assertEqual(idx["rejected"], {"erhua": 1})
            wav = aishell3.wav_path(tmp / "work", "SSB00010001")
            self.assertEqual(aishell3.wav_ms(wav), 2000)
            # second call reuses the index without re-streaming
            idx2 = aishell3.stream(tar, tmp / "work", lambda *a: self.fail("re-streamed"))
            self.assertEqual(idx2["available"], ["SSB00010001"])


class TestMp3Parser(unittest.TestCase):
    def test_rejects_non_mp3(self):
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            f.write(b"RIFF" + b"\x00" * 100)
            f.flush()
            with self.assertRaises(ValueError):
                common.mp3_info(f.name)

    def test_parses_synthetic_frames(self):
        # MPEG-2 layer III, 40 kb/s, 22050 Hz, mono: header FF F3 50 C4 (no padding)
        header = bytes([0xFF, 0xF3, 0x50, 0xC4])
        flen = 72 * 40000 // 22050
        frame = header + b"\x00" * (flen - 4)
        with tempfile.NamedTemporaryFile(suffix=".mp3") as f:
            f.write(frame * 10)
            f.flush()
            info = common.mp3_info(f.name)
        self.assertEqual((info["rate"], info["channels"], info["kbps"], info["frames"]),
                         (22050, 1, [40], 10))


class TestOptInSources(unittest.TestCase):
    def test_tatoeba_rows(self):
        rows = tatoeba.parse_audio_rows([
            "123\t456\tfucongcong\t\\N\t\\N\n",
            "124\t457\tfucongcong\tCC BY-NC 4.0\thttps://example.org\n",
            "bad row\n",
        ])
        self.assertEqual(len(rows), 2)
        self.assertFalse(rows[0]["redistributable"])
        self.assertTrue(rows[1]["redistributable"])
        self.assertEqual(tatoeba.parse_text_rows(["123\tcmn\t我喜欢咖啡。\tuser\n"]), {"123": "我喜欢咖啡。"})
        self.assertEqual(tatoeba.strip_punct("我喜欢咖啡。"), "我喜欢咖啡")

    def test_tatoeba_refuses_public_bundle(self):
        with self.assertRaises(PermissionError):
            tatoeba.build([], Path("/nonexistent"), private_build=False)

    def test_build_refuses_tatoeba_without_private(self):
        import build

        self.assertEqual(build.main(["--aishell3-tar", "/nonexistent", "--with-tatoeba"]), 2)

    def test_tts_stub(self):
        self.assertTrue(tts_stub.SOURCE["synthetic"])
        with self.assertRaises(NotImplementedError):
            tts_stub.synthesize("你好", Path("/tmp/x.mp3"))


if __name__ == "__main__":
    unittest.main()
