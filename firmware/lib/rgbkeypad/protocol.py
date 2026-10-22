"""Newline-delimited JSON over the USB data port.

The host sends {"id": n, "cmd": "...", ...}; every request gets exactly one
reply carrying the same id, {"ok": true, ...} or {"ok": false, "error": "..."}.
The device also sends unsolicited events, {"event": "...", ...}, which have no id.

RAM is the tight resource (around 90 KB free on an RP2040), so a received line
is handed to its handler without extra copies, and running out of memory drops
that one message with an error reply instead of wedging the port.
"""

import gc
import json

MAX_LINE = 16 * 1024  # a 12 KB layout (web/js/config.js MAX_CONFIG_BYTES) plus the request around it
OUT_OF_MEMORY = "The keypad ran out of memory handling that message. Make the layout smaller."
TOO_LONG = "Message longer than %d bytes. Make the layout smaller." % MAX_LINE


def peek_id(line):
    """The request id from a raw line, for replying when it can't be parsed.
    The web app writes "id" after the arguments, so search from the end."""
    at = line.rfind(b'"id":')
    if at < 0:
        return None
    value, i, found = 0, at + 5, False
    while i < len(line) and line[i] == 32:
        i += 1
    while i < len(line) and 48 <= line[i] <= 57:
        value = value * 10 + line[i] - 48
        i += 1
        found = True
    return value if found else None


class Protocol:
    def __init__(self, write, dump=None):
        """write(bytes) sends raw bytes. dump(message), if given, serializes a message
        straight to the port, so a large reply never exists as one string in RAM."""
        self.write = write
        self.dump = dump
        self.handlers = {}
        self.buf = bytearray()
        self.discarding = None  # error to reply with once an oversized line ends
        self._line = None

    def on(self, cmd, handler):
        self.handlers[cmd] = handler

    def send(self, message):
        if self.dump is not None:
            self.dump(message)
        else:
            self.write(json.dumps(message).encode())
            self.write(b"\n")

    def feed(self, data):
        try:
            self.buf.extend(data)
        except MemoryError:
            ends_here = b"\n" in data
            self._drop(peek_id(data) if ends_here else None, not ends_here)
            return
        while True:
            end = self.buf.find(b"\n")
            if end < 0:
                break
            try:
                if end == len(self.buf) - 1:
                    self._line, self.buf = self.buf, bytearray()  # usual case: no copy (keeps the "\n")
                else:
                    self._line, self.buf = self.buf[:end], self.buf[end + 1:]
            except MemoryError:
                self._drop(peek_id(self.buf[:end]), False)
                return
            if self.discarding:
                # The end of a dropped line: it carries the id, so reply now.
                error, self.discarding = self.discarding, None
                request_id = peek_id(self._line)
                self._line = None
                self.send({"id": request_id, "ok": False, "error": error})
                continue
            self.dispatch()
        if len(self.buf) > MAX_LINE:
            self.buf = bytearray()
            self.discarding = TOO_LONG

    def _drop(self, request_id, rest_still_coming):
        self.buf = bytearray()
        self._line = None
        gc.collect()
        if rest_still_coming:
            self.discarding = OUT_OF_MEMORY
        else:
            self.send({"id": request_id, "ok": False, "error": OUT_OF_MEMORY})

    def dispatch(self):
        line = self._line
        self._line = None
        if len(line) < 4 and all(b in (9, 10, 13, 32) for b in line):
            return  # blank line, e.g. the one a client sends to end any partial line
        request_id = peek_id(line)
        if len(line) > 2048:
            gc.collect()
        try:
            message = json.loads(line)
        except MemoryError:
            line = None
            gc.collect()
            self.send({"id": request_id, "ok": False, "error": OUT_OF_MEMORY})
            return
        except ValueError:
            self.send({"id": request_id, "ok": False, "error": "Malformed JSON"})
            return
        line = None  # let the raw text be collected while the handler runs
        if not isinstance(message, dict):
            self.send({"ok": False, "error": "Expected a JSON object"})
            return
        request_id = message.get("id")
        handler = self.handlers.get(message.get("cmd"))
        if handler is None:
            self.send({"id": request_id, "ok": False,
                       "error": "Unknown command %r" % (message.get("cmd"),)})
            return
        try:
            reply = handler(message) or {}
        except MemoryError:
            message = None
            gc.collect()
            reply = {"ok": False, "error": OUT_OF_MEMORY}
        except Exception as error:  # report every failure to the host rather than crash
            reply = {"ok": False, "error": str(error) or type(error).__name__}
        reply["id"] = request_id
        if "ok" not in reply:
            reply["ok"] = True
        try:
            self.send(reply)
        except MemoryError:
            reply = None
            gc.collect()
            self.send({"id": request_id, "ok": False, "error": OUT_OF_MEMORY})
