"""Fallback loop for when the firmware fails to start.

Keeps the data port answering hello, the fs_* commands and reboot, so the web
app can show the error and push a working firmware without the USB drive.
Imports only the small modules a broken update is least likely to touch.
"""

import time

import storage
import usb_cdc

from . import VERSION
from .fs import Files, file_handlers
from .protocol import Protocol

RED = (255, 0, 0)


def run(error):
    message = "%s: %s" % (type(error).__name__, error)
    writable = not storage.getmount("/").readonly
    port = usb_cdc.data
    try:
        from .hardware import Leds
        Leds().fill(RED, 2)
    except Exception:  # the LEDs may be what failed; recovery must still run
        pass
    if port is None:
        while True:
            time.sleep(1)
    port.timeout = 0
    port.write_timeout = 1

    def write(data):
        if port.connected:
            port.write(data)

    proto = Protocol(write)
    for cmd, handler in file_handlers(Files(""), writable).items():
        proto.on(cmd, handler)
    proto.on("hello", lambda msg: {"fw": VERSION, "recovery": message, "writable": writable})
    proto.on("get_config", lambda msg: {"ok": False, "error": message})
    reboot_mode = []
    proto.on("reboot", lambda msg: reboot_mode.append(msg.get("mode", "normal")) or {})

    while True:
        if port.in_waiting:
            proto.feed(port.read(port.in_waiting))
        if reboot_mode:
            time.sleep(0.2)
            from .hardware import reboot
            reboot(reboot_mode[0])
        time.sleep(0.005)
