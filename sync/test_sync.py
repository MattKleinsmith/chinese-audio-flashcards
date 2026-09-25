import io, json, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import hackchinese_sync as hc


class SanityCheck(unittest.TestCase):
    def test_accepts_header_csv(self):
        info = hc.sanity_check("﻿simplified,pinyin,definition\n学习,xué xí,to study\n朋友,péng you,friend\n".encode())
        self.assertEqual(info, {"rows": 3, "han_rows": 2})

    def test_accepts_one_word_per_line(self):
        self.assertEqual(hc.sanity_check("学习\n朋友\n图书馆\n".encode())["han_rows"], 3)

    def test_rejects_html(self):
        with self.assertRaises(ValueError):
            hc.sanity_check(b"<!DOCTYPE html><html><body>Sign in</body></html>")

    def test_rejects_empty_and_no_chinese(self):
        with self.assertRaises(ValueError):
            hc.sanity_check(b"")
        with self.assertRaises(ValueError):
            hc.sanity_check(b"word,pinyin\nhello,world\n")


class WriteOutputs(unittest.TestCase):
    def test_writes_and_detects_change(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            data = "simplified\n学习\n".encode()
            self.assertTrue(hc.write_outputs(data, out, {"rows": 2, "han_rows": 1}))
            self.assertFalse(hc.write_outputs(data, out, {"rows": 2, "han_rows": 1}))
            self.assertTrue(hc.write_outputs("simplified\n学习\n朋友\n".encode(), out, {"rows": 3, "han_rows": 2}))
            meta = json.loads((out / "sync.json").read_text())
            self.assertEqual(meta["source"], "hackchinese")
            self.assertEqual(meta["rows"], 3)
            self.assertTrue(meta["syncedAt"].endswith("Z"))
            self.assertEqual(len(meta["sha256"]), 64)

    def test_offline_mode_cli(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "export.csv"
            src.write_text("simplified,pinyin\n图书馆,tú shū guǎn\n", encoding="utf-8")
            self.assertEqual(hc.main(["--csv", str(src), "--out-dir", d + "/out"]), 0)
            self.assertTrue((Path(d) / "out" / "hackchinese.csv").exists())


if __name__ == "__main__":
    unittest.main()
