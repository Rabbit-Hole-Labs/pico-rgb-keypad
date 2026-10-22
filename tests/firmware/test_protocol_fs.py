import base64
import binascii
import json
import os
import tempfile
import unittest

from _path import FIRMWARE  # noqa: F401  (puts firmware/lib on sys.path)

from rgbkeypad import protocol
from rgbkeypad.fs import READ_ONLY_MESSAGE, Files, check_path, file_handlers
from rgbkeypad.protocol import MAX_LINE, OUT_OF_MEMORY, TOO_LONG, Protocol, peek_id


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.out = []
        self.proto = Protocol(self.out.append)
        self.proto.on("echo", lambda msg: {"value": msg.get("value")})
        self.proto.on("boom", lambda msg: 1 / 0)
        self.proto.on("refuse", lambda msg: {"ok": False, "error": "no", "applied": True})

    def replies(self):
        return [json.loads(line) for line in b"".join(self.out).decode().splitlines() if line]

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

    def test_peek_id(self):
        self.assertEqual(peek_id(b'{"config": {"id": 3}, "id": 42, "cmd": "x"}'), 42)
        self.assertEqual(peek_id(b'{"id":7,"cmd":"x"}'), 7)
        self.assertIsNone(peek_id(b'{"cmd": "x"}'))
        self.assertIsNone(peek_id(b'{"id": "abc"}'))

    def test_out_of_memory_parsing_replies_and_recovers(self):
        real_loads = protocol.json.loads
        calls = []

        def loads(text):
            calls.append(1)
            if len(calls) == 1:
                raise MemoryError("memory allocation failed")
            return real_loads(text)

        protocol.json.loads = loads
        try:
            self.proto.feed(b'{"cmd": "echo", "id": 5}\n{"id": 6, "cmd": "echo"}\n')
        finally:
            protocol.json.loads = real_loads
        self.assertEqual(self.replies(), [
            {"id": 5, "ok": False, "error": OUT_OF_MEMORY},
            {"id": 6, "ok": True, "value": None},
        ])

    def test_dump_streams_replies_and_out_of_memory_while_sending_still_replies(self):
        sent = []
        attempts = []

        def dump(message):
            attempts.append(message)
            if len(attempts) == 1:
                raise MemoryError()
            sent.append(message)

        proto = Protocol(self.out.append, dump)
        proto.on("big", lambda msg: {"config": "x" * 100})
        proto.feed(b'{"id": 4, "cmd": "big"}\n')
        self.assertEqual(sent, [{"id": 4, "ok": False, "error": OUT_OF_MEMORY}])
        self.assertEqual(self.out, [])

    def test_out_of_memory_in_handler_is_a_reply(self):
        def hungry(msg):
            raise MemoryError()
        self.proto.on("hungry", hungry)
        self.proto.feed(b'{"id": 9, "cmd": "hungry"}\n')
        self.assertEqual(self.replies(), [{"id": 9, "ok": False, "error": OUT_OF_MEMORY}])

    def test_overlong_line_is_dropped_and_parsing_resumes(self):
        self.proto.feed(b"x" * (MAX_LINE + 1))
        self.assertEqual(self.out, [])  # the reply waits for the line to end, to carry its id
        self.proto.feed(b'still the same line", "id": 12, "cmd": "set_config"}\n{"id": 3, "cmd": "echo"}\n')
        self.assertEqual(self.replies(), [
            {"id": 12, "ok": False, "error": TOO_LONG},
            {"id": 3, "ok": True, "value": None},
        ])


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

    def test_save_json_replaces_and_load_falls_back_to_tmp(self):
        self.files.save_json("config.json", {"n": 1})
        self.files.save_json("config.json", {"n": 2})
        self.assertEqual(self.files.load_json("config.json"), {"n": 2})
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "config.json.tmp")))
        os.rename(os.path.join(self.tmp.name, "config.json"),
                  os.path.join(self.tmp.name, "config.json.tmp"))
        self.assertEqual(self.files.load_json("config.json"), {"n": 2})
        self.assertIsNone(self.files.load_json("missing.json"))
        with open(os.path.join(self.tmp.name, "broken.json"), "w") as f:
            f.write("{nope")
        with self.assertRaises(ValueError):
            self.files.load_json("broken.json")

    def test_read_only_mode_refuses_writes(self):
        handlers = file_handlers(self.files, False)
        with self.assertRaises(RuntimeError) as ctx:
            handlers["fs_write"]({"path": "code.py", "offset": 0, "data": ""})
        self.assertEqual(str(ctx.exception), READ_ONLY_MESSAGE)
        self.assertEqual(handlers["fs_list"]({})["entries"], [])


if __name__ == "__main__":
    unittest.main()
