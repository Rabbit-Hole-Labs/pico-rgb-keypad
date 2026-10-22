"""Newline-delimited JSON over the USB data port.

The host sends {"id": n, "cmd": "...", ...}; every request gets exactly one
reply carrying the same id, {"ok": true, ...} or {"ok": false, "error": "..."}.
The device also sends unsolicited events, {"event": "...", ...}, which have no id.
"""

import json

MAX_LINE = 48 * 1024


class Protocol:
    def __init__(self, write):
        self.write = write
        self.handlers = {}
        self.buf = bytearray()
        self.discarding = False

    def on(self, cmd, handler):
        self.handlers[cmd] = handler

    def send(self, message):
        self.write((json.dumps(message) + "\n").encode())

    def feed(self, data):
        self.buf.extend(data)
        while True:
            end = self.buf.find(b"\n")
            if end < 0:
                break
            line = bytes(self.buf[:end])
            self.buf = self.buf[end + 1:]
            if self.discarding:
                self.discarding = False
                continue
            line = line.strip()
            if line:
                self.dispatch(line)
        if len(self.buf) > MAX_LINE:
            self.buf = bytearray()
            self.discarding = True
            self.send({"ok": False, "error": "Message longer than %d bytes" % MAX_LINE})

    def dispatch(self, line):
        try:
            message = json.loads(line)
        except ValueError:
            self.send({"ok": False, "error": "Malformed JSON"})
            return
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
        except Exception as error:  # report every failure to the host rather than crash
            reply = {"ok": False, "error": str(error) or type(error).__name__}
        reply["id"] = request_id
        if "ok" not in reply:
            reply["ok"] = True
        self.send(reply)
