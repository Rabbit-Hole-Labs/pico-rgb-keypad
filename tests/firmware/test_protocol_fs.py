import base64
import binascii
import json
import os
import tempfile
import unittest

from _path import FIRMWARE  # noqa: F401  (puts firmware/lib on sys.path)

from rgbkeypad.fs import READ_ONLY_MESSAGE, Files, check_path, file_handlers
from rgbkeypad.protocol import MAX_LINE, Protocol


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.out = []
        self.proto = Protocol(self.out.append)
        self.proto.on("echo", lambda msg: {"value": msg.get("value")})
        self.proto.on("boom", lambda msg: 1 / 0)
        self.proto.on("refuse", lambda msg: {"ok": False, "error": "no", "applied": True})

    def replies(self):
        return [json.loads(line) for chunk in self.out for line in chunk.decode().splitlines()]

    def test_reply_carries_request_id(self):
        self.proto.feed(b'{"id": 7, "cmd": "echo", "value": 3}\n')
        self.assertEqual(self.replies(), [{"id": 7, "ok": True, "value": 3}])

    def test_lines_split_across_chunks_and_batched(self):
        self.proto.feed(b'{"id": 1, "cmd": "ec')
        self.assertEqual(self.out, [])
        self.proto.feed(b'ho"}\r\n{"id": 2, "cmd": "echo"}\n\n')
        self.assertEqual([r["id"] for r in self.replies()], [1, 2])

    def test_errors_are_replies(self):
        self.proto.feed(b'{"id": 1, "cmd": "nope"}\n{"id": 2, "cmd": "boom"}\nnot json\n[1]\n')
        replies = self.replies()
        self.assertEqual([r["ok"] for r in replies], [False] * 4)
        self.assertIn("Unknown command", replies[0]["error"])
        self.assertIn("division", replies[1]["error"])
        self.assertEqual(replies[2]["error"], "Malformed JSON")

    def test_handler_can_reply_not_ok(self):
        self.proto.feed(b'{"id": 1, "cmd": "refuse"}\n')
        self.assertEqual(self.replies(), [{"id": 1, "ok": False, "error": "no", "applied": True}])

    def test_overlong_line_is_dropped_and_parsing_resumes(self):
        self.proto.feed(b"x" * (MAX_LINE + 1))
        self.proto.feed(b'still the same line\n{"id": 3, "cmd": "echo"}\n')
        replies = self.replies()
        self.assertFalse(replies[0]["ok"])
        self.assertEqual(replies[1]["id"], 3)
        self.assertEqual(len(replies), 2)


class PathTests(unittest.TestCase):
    def test_accepts_firmware_paths(self):
        for path in ("code.py", "lib/rgbkeypad/app.py", "config.json"):
            self.assertEqual(check_path(path), path)

    def test_refuses_escapes(self):
        for path in ("", "/code.py", "../x", "lib/../code.py", "lib//x", ".Trashes",
                     "lib/", "a b.py", None, "x" * 97):
            with self.assertRaises(ValueError, msg=path):
                check_path(path)


class FilesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.files = Files(self.tmp.name)
        self.handlers = file_handlers(self.files, True)

    def tearDown(self):
        self.tmp.cleanup()

    def call(self, cmd, **msg):
        return self.handlers[cmd](msg)

    def upload(self, path, data, chunk=5):
        for offset in range(0, len(data), chunk):
            part = base64.b64encode(data[offset:offset + chunk]).decode()
            self.assertEqual(self.call("fs_write", path=path, offset=offset, data=part)["size"],
                             min(offset + chunk, len(data)))

    def read(self, path):
        with open(os.path.join(self.tmp.name, path), "rb") as f:
            return f.read()

    def test_staged_upload_commit(self):
        with open(os.path.join(self.tmp.name, "code.py"), "wb") as f:
            f.write(b"old")
        data = b"print('new firmware')\n"
        self.upload("code.py", data)
        self.upload("lib/pkg/mod.py", b"x = 1\n")
        self.assertEqual(self.read("code.py"), b"old")  # untouched until commit
        crc = self.call("fs_crc", path="code.py", staged=True)
        self.assertEqual(crc, {"crc": binascii.crc32(data), "size": len(data)})
        self.call("fs_commit", paths=["code.py", "lib/pkg/mod.py"])
        self.assertEqual(self.read("code.py"), data)
        self.assertEqual(self.read("lib/pkg/mod.py"), b"x = 1\n")
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "code.py.new")))

    def test_out_of_order_chunk_is_refused(self):
        self.upload("code.py", b"12345")
        with self.assertRaises(ValueError):
            self.call("fs_write", path="code.py", offset=9, data="QQ==")

    def test_commit_checks_every_file_first(self):
        self.upload("code.py", b"new")
        with self.assertRaises(ValueError):
            self.call("fs_commit", paths=["code.py", "boot.py"])
        self.assertTrue(os.path.exists(os.path.join(self.tmp.name, "code.py.new")))
        self.call("fs_discard", paths=["code.py", "boot.py"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "code.py.new")))

    def test_read_list_delete(self):
        self.upload("notes.txt", b"hello world")
        self.call("fs_commit", paths=["notes.txt"])
        got = self.call("fs_read", path="notes.txt", offset=6, length=5)
        self.assertEqual(base64.b64decode(got["data"]), b"world")
        self.assertEqual(got["size"], 11)
        entries = self.call("fs_list")["entries"]
        self.assertEqual(entries, [{"name": "notes.txt", "size": 11, "dir": False}])
        self.call("fs_delete", path="notes.txt")
        self.assertEqual(self.call("fs_list")["entries"], [])

    def test_save_text_replaces_and_load_falls_back_to_tmp(self):
        self.files.save_text("config.json", "one")
        self.files.save_text("config.json", "two")
        self.assertEqual(self.files.load_text("config.json"), "two")
        os.rename(os.path.join(self.tmp.name, "config.json"),
                  os.path.join(self.tmp.name, "config.json.tmp"))
        self.assertEqual(self.files.load_text("config.json"), "two")
        self.assertIsNone(self.files.load_text("missing.json"))

    def test_read_only_mode_refuses_writes(self):
        handlers = file_handlers(self.files, False)
        with self.assertRaises(RuntimeError) as ctx:
            handlers["fs_write"]({"path": "code.py", "offset": 0, "data": ""})
        self.assertEqual(str(ctx.exception), READ_ONLY_MESSAGE)
        self.assertEqual(handlers["fs_list"]({})["entries"], [])


if __name__ == "__main__":
    unittest.main()
