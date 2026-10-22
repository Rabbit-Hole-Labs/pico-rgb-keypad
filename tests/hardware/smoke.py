"""Protocol smoke test against a real keypad. Not part of `npm test`.

    python3 tests/hardware/smoke.py /dev/cu.usbmodemXXXX3

Pass the keypad's data port: its only serial port in normal mode, or the
second of its two in USB drive mode (the first is the Python console). The test
changes nothing permanently: the config it sends is not saved, the file it
uploads is staged and then discarded, and the original layer is restored. It
never presses keys on the computer; a key only types if you press it.
"""

import base64
import binascii
import json
import os
import select
import sys
import termios
import time
import tty


class Port:
    def __init__(self, path):
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        tty.setraw(self.fd)
        termios.tcflush(self.fd, termios.TCIOFLUSH)
        os.write(self.fd, b"\n")  # end any partial line an earlier client left behind
        self.buf = b""
        self.next_id = 1
        self.events = []

    def _lines(self, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                yield json.loads(line)
                continue
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if ready:
                try:
                    self.buf += os.read(self.fd, 65536)
                except BlockingIOError:
                    pass

    def call(self, cmd, timeout=3, **args):
        request_id = self.next_id
        self.next_id += 1
        data = (json.dumps(dict(args, id=request_id, cmd=cmd)) + "\n").encode()
        while data:  # the port is non-blocking, so large writes go out in pieces
            try:
                data = data[os.write(self.fd, data):]
            except BlockingIOError:
                select.select([], [self.fd], [], 1)
        for message in self._lines(timeout):
            if "event" in message:
                self.events.append(message)
            elif message.get("id") == request_id:
                return message
        raise TimeoutError("no reply to %s" % cmd)


def check(label, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + label + (" - " + str(detail) if detail else ""))
    if not condition:
        check.failures += 1


check.failures = 0


def main(path):
    port = Port(path)
    hello = port.call("hello")
    print("hello:", hello)
    check("hello ok", hello.get("ok") and "fw" in hello, hello.get("error"))
    check("not in recovery", "recovery" not in hello, hello.get("recovery"))
    check("firmware can write (normal boot)", hello.get("writable") is True)
    check("no config error", hello.get("config_error") is None, hello.get("config_error"))

    got = port.call("get_config")
    config = got["config"]
    check("get_config returns 16 keys per layer",
          all(len(layer["keys"]) == 16 for layer in config["layers"]))
    print("layers:", [layer["name"] for layer in config["layers"]])

    bad = port.call("set_config", config={"layers": []})
    check("invalid config refused with field name",
          not bad["ok"] and bad["error"].startswith("layers"), bad.get("error"))

    preview = json.loads(json.dumps(config))
    preview["layers"][0]["keys"][0]["color"] = "#00ff00"
    applied = port.call("set_config", config=preview, save=False)
    check("set_config applies without saving", applied["ok"] and applied["saved"] is False)
    check("device reports the previewed color",
          port.call("get_config")["config"]["layers"][0]["keys"][0]["color"] == "#00ff00")
    port.call("set_config", config=config, save=False)

    original_layer = hello.get("layer", 0)
    if len(config["layers"]) > 1:
        moved = port.call("set_layer", layer=1)
        check("set_layer", moved["ok"] and moved["layer"] == 1)
        check("layer event sent", any(e.get("event") == "layer" for e in port.events)
              or port.call("hello")["layer"] == 1)
        port.call("set_layer", layer=original_layer)
    check("bad layer refused", not port.call("set_layer", layer=99)["ok"])

    check("identify", port.call("identify", key=5)["ok"])

    payload = os.urandom(3000)
    offset = 0
    while offset < len(payload):
        chunk = payload[offset:offset + 768]
        reply = port.call("fs_write", path="smoke-test.bin", offset=offset,
                          data=base64.b64encode(chunk).decode())
        assert reply["ok"], reply
        offset = reply["size"]
    crc = port.call("fs_crc", path="smoke-test.bin", staged=True)
    check("staged upload crc matches", crc["crc"] == binascii.crc32(payload)
          and crc["size"] == len(payload), crc)
    port.call("fs_discard", paths=["smoke-test.bin"])
    names = [e["name"] for e in port.call("fs_list")["entries"]]
    check("staged file discarded", "smoke-test.bin.new" not in names, names)
    check("escape path refused", not port.call("fs_write", path="../x", offset=0, data="")["ok"])

    started = time.time()
    for _ in range(20):
        port.call("hello")
    print("round trip: %.1f ms" % ((time.time() - started) / 20 * 1000))

    print("\n%d failure(s)" % check.failures)
    return check.failures


if __name__ == "__main__":
    sys.exit(1 if main(sys.argv[1]) else 0)
