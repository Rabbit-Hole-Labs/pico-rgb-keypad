"""File access for config saves and firmware updates over the data port.

Updates are staged: each file is written to "<path>.new" in base64 chunks,
checked by CRC32, and only renamed into place by one commit once every file
has arrived, so an interrupted transfer leaves the running firmware untouched.

Paths are relative to the CIRCUITPY root. root is "" on the device and a temp
directory in tests; CircuitPython has no os.path, so paths are joined by hand.
"""

import binascii
import json
import os

STAGED = ".new"
MAX_PATH = 96
CHUNK = 1024
_PATH_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/"
_DIR_FLAG = 0x4000
READ_ONLY_MESSAGE = ("The keypad is in USB drive mode, so the firmware can't write its "
                     "files. Reboot it normally first.")


def check_path(path):
    """Accept "code.py" or "lib/x/y.py"; refuse absolute, hidden or parent paths."""
    if not isinstance(path, str) or not path or len(path) > MAX_PATH:
        raise ValueError("Bad path %r" % (path,))
    for ch in path:
        if ch not in _PATH_CHARS:
            raise ValueError("Bad path %r" % (path,))
    for part in path.split("/"):
        if not part or part[0] == ".":
            raise ValueError("Bad path %r" % (path,))
    return path


class Files:
    def __init__(self, root=""):
        self.root = root.rstrip("/")

    def full(self, path):
        return self.root + "/" + path

    def _stat(self, full):
        try:
            return os.stat(full)
        except OSError:
            return None

    def _makedirs(self, path):
        current = self.root
        for part in path.split("/")[:-1]:
            current += "/" + part
            if self._stat(current) is None:
                os.mkdir(current)

    def _sync(self):
        sync = getattr(os, "sync", None)
        if sync:
            sync()

    def load_json(self, path):
        """Parse a file saved by save_json, or None if neither copy exists.
        Raises ValueError if the file isn't valid JSON."""
        for candidate in (path, path + ".tmp"):
            try:
                f = open(self.full(candidate), "r")
            except OSError:
                continue
            with f:
                return json.load(f)
        return None

    def save_json(self, path, value):
        """Replace a file so a power cut leaves either the old or the new copy.
        json.dump streams to the file, so no second copy of the text is built."""
        full = self.full(path)
        with open(full + ".tmp", "w") as f:
            json.dump(value, f)
        if self._stat(full) is not None:
            os.remove(full)
        os.rename(full + ".tmp", full)
        self._sync()

    def write_chunk(self, path, offset, data):
        """Append data to the staged copy of path; offset 0 starts it over."""
        staged = self.full(check_path(path)) + STAGED
        if offset == 0:
            self._makedirs(path)
            mode = "wb"
        else:
            st = self._stat(staged)
            size = st[6] if st else 0
            if size != offset:
                raise ValueError("Chunk offset %d but %s has %d bytes staged" % (
                    offset, path, size))
            mode = "ab"
        with open(staged, mode) as f:
            f.write(data)
        return offset + len(data)

    def crc(self, path, staged=False):
        full = self.full(check_path(path)) + (STAGED if staged else "")
        value, size = 0, 0
        with open(full, "rb") as f:
            while True:
                block = f.read(CHUNK)
                if not block:
                    break
                value = binascii.crc32(block, value)
                size += len(block)
        return value & 0xFFFFFFFF, size

    def commit(self, paths):
        """Move every staged file into place, after checking they all exist."""
        for path in paths:
            if self._stat(self.full(check_path(path)) + STAGED) is None:
                raise ValueError("%s was never uploaded" % path)
        for path in paths:
            full = self.full(path)
            if self._stat(full) is not None:
                os.remove(full)
            os.rename(full + STAGED, full)
        self._sync()

    def discard(self, paths):
        for path in paths:
            staged = self.full(check_path(path)) + STAGED
            if self._stat(staged) is not None:
                os.remove(staged)

    def read_chunk(self, path, offset, length):
        full = self.full(check_path(path))
        size = self._stat(full)[6]
        with open(full, "rb") as f:
            f.seek(offset)
            return f.read(min(length, CHUNK * 4)), size

    def listdir(self, path=""):
        base = self.full(check_path(path)) if path else (self.root or "/")
        entries = []
        for name in sorted(os.listdir(base)):
            st = os.stat(base.rstrip("/") + "/" + name)
            entries.append({"name": name, "size": st[6], "dir": bool(st[0] & _DIR_FLAG)})
        return entries

    def delete(self, path):
        full = self.full(check_path(path))
        st = self._stat(full)
        if st is None:
            raise ValueError("%s does not exist" % path)
        if st[0] & _DIR_FLAG:
            raise ValueError("%s is a folder" % path)
        os.remove(full)


def file_handlers(files, writable):
    """Protocol handlers for the fs_* commands, shared by the app and recovery mode."""

    def need_writable():
        if not writable:
            raise RuntimeError(READ_ONLY_MESSAGE)

    def fs_write(msg):
        need_writable()
        data = binascii.a2b_base64(msg.get("data", ""))
        return {"size": files.write_chunk(msg.get("path"), msg.get("offset", 0), data)}

    def fs_crc(msg):
        value, size = files.crc(msg.get("path"), bool(msg.get("staged")))
        return {"crc": value, "size": size}

    def fs_commit(msg):
        need_writable()
        files.commit(msg.get("paths") or [])
        return {}

    def fs_discard(msg):
        need_writable()
        files.discard(msg.get("paths") or [])
        return {}

    def fs_read(msg):
        data, size = files.read_chunk(msg.get("path"), msg.get("offset", 0),
                                      msg.get("length", CHUNK))
        return {"data": binascii.b2a_base64(data).decode().strip(), "size": size}

    def fs_list(msg):
        return {"entries": files.listdir(msg.get("path", ""))}

    def fs_delete(msg):
        need_writable()
        files.delete(msg.get("path"))
        return {}

    return {
        "fs_write": fs_write, "fs_crc": fs_crc, "fs_commit": fs_commit,
        "fs_discard": fs_discard, "fs_read": fs_read, "fs_list": fs_list,
        "fs_delete": fs_delete,
    }
