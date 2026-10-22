"""Main loop: scan keys, run the engine, drive the LEDs and serve the web app."""

import gc
import json
import os
import sys
import time

import board
import storage
import supervisor
import usb_cdc
import usb_hid
from adafruit_hid.consumer_control import ConsumerControl
from adafruit_hid.keyboard import Keyboard
from adafruit_hid.keyboard_layout_us import KeyboardLayoutUS

from . import VERSION
from .config import ConfigError, compile_config, default_config, normalize
from .engine import NUM_KEYS, OFF, Engine, ticks_add, ticks_diff
from .fs import READ_ONLY_MESSAGE, Files, file_handlers
from .hardware import Keypad, Leds, reboot
from .protocol import Protocol

CONFIG_PATH = "config.json"
DEBOUNCE_MS = 5
RENDER_MS = 10
REBOOT_DELAY_MS = 200
REBOOT_MODES = ("reload", "normal", "drive", "bootloader")


class Hid:
    """adafruit_hid behind the engine's interface. USB may not be up yet (or the host
    may be asleep), so every call is best effort and reconnects lazily."""

    def __init__(self):
        self.keyboard = None
        self.consumer = None
        self.layout = None

    def _ready(self):
        if self.keyboard is None:
            if not supervisor.runtime.usb_connected:
                return False
            try:
                self.keyboard = Keyboard(usb_hid.devices, timeout=1)
                self.consumer = ConsumerControl(usb_hid.devices, timeout=1)
                self.layout = KeyboardLayoutUS(self.keyboard)
            except OSError:
                self.keyboard = None
                return False
        return True

    def _send(self, device, method, *args):
        if not self._ready():
            return
        try:
            getattr(getattr(self, device), method)(*args)
        except (OSError, ValueError) as error:
            print("hid:", error)

    def press(self, codes):
        self._send("keyboard", "press", *codes)

    def release(self, codes):
        self._send("keyboard", "release", *codes)

    def release_all(self):
        self._send("keyboard", "release_all")

    def consumer_press(self, code):
        self._send("consumer", "press", code)

    def consumer_release(self):
        self._send("consumer", "release")

    def char_codes(self, ch):
        if not self._ready():
            return None
        try:
            return self.layout.keycodes(ch)
        except ValueError:
            return None


class App:
    def __init__(self):
        self.files = Files("")
        self.writable = not storage.getmount("/").readonly
        self.port = usb_cdc.data
        if self.port:
            self.port.timeout = 0
            self.port.write_timeout = 1
        self.proto = Protocol(self._write, self._dump)
        self.leds = Leds()
        self.keypad = Keypad()
        self.engine = Engine(Hid(), self.emit)
        self.config, self.config_error = self._load_config()
        self.engine.load(compile_config(self.config), supervisor.ticks_ms())
        self.pending_reboot = None
        for cmd, handler in file_handlers(self.files, self.writable).items():
            self.proto.on(cmd, handler)
        self.proto.on("hello", self.cmd_hello)
        self.proto.on("get_config", self.cmd_get_config)
        self.proto.on("get_default_config",
                      lambda msg: {"config": default_config(msg.get("platform", "mac"))})
        self.proto.on("set_config", self.cmd_set_config)
        self.proto.on("set_layer", self.cmd_set_layer)
        self.proto.on("identify", self.cmd_identify)
        self.proto.on("set_paused", self.cmd_set_paused)
        self.proto.on("reboot", self.cmd_reboot)

    def _load_config(self):
        try:
            saved = self.files.load_json(CONFIG_PATH)
            if saved is not None:
                return normalize(saved), None
        except ValueError as error:  # bad JSON, or a ConfigError (also a ValueError)
            print("config.json ignored:", error)
            return default_config(), "config.json was ignored: %s" % error
        cfg = default_config()
        if self.writable:
            self.files.save_json(CONFIG_PATH, cfg)
        return cfg, None

    def _write(self, data):
        port = self.port
        if port is not None and port.connected:
            try:
                port.write(data)
            except OSError:
                pass

    def _dump(self, message):
        port = self.port
        if port is not None and port.connected:
            try:
                json.dump(message, port)
                port.write(b"\n")
            except OSError:
                pass

    def emit(self, event):
        if self.port is not None and self.port.connected:
            self.proto.send(event)

    # Protocol commands

    def cmd_hello(self, msg):
        fs = os.statvfs("/")
        return {
            "fw": VERSION,
            "board": board.board_id,
            "circuitpython": ".".join(str(n) for n in sys.implementation.version[:3]),
            "keys": NUM_KEYS,
            "writable": self.writable,
            "layer": self.engine.active_layer(),
            "mem_free": gc.mem_free(),
            "fs_free": fs[0] * fs[3],
            "config_error": self.config_error,
        }

    def cmd_get_config(self, msg):
        return {"config": self.config}

    def cmd_set_config(self, msg):
        # Memory is tight: drop each intermediate form as soon as the next exists.
        cfg = normalize(msg.pop("config", None))
        gc.collect()
        self.engine.load(compile_config(cfg), supervisor.ticks_ms())
        self.config = cfg
        self.config_error = None
        gc.collect()
        if not msg.get("save"):
            return {"saved": False}
        if not self.writable:
            return {"ok": False, "applied": True, "error": READ_ONLY_MESSAGE}
        self.files.save_json(CONFIG_PATH, cfg)
        return {"saved": True}

    def cmd_set_layer(self, msg):
        self.engine.set_layer(msg.get("layer"), supervisor.ticks_ms())
        return {"layer": self.engine.active_layer()}

    def cmd_identify(self, msg):
        self.engine.identify(msg.get("key"), supervisor.ticks_ms())
        return {}

    def cmd_set_paused(self, msg):
        """Pick mode: presses select keys in the web app instead of running actions."""
        self.engine.release_all()
        self.engine.paused = bool(msg.get("paused"))
        return {"paused": self.engine.paused}

    def cmd_reboot(self, msg):
        mode = msg.get("mode", "normal")
        if mode not in REBOOT_MODES:
            raise ValueError("mode must be one of " + ", ".join(REBOOT_MODES))
        # Reply first; the reset happens a moment later in the main loop.
        self.pending_reboot = (mode, ticks_add(supervisor.ticks_ms(), REBOOT_DELAY_MS))
        return {}

    # Main loop

    def _guard(self, fn, *args):
        try:
            fn(*args)
        except Exception as error:  # one bad key or macro must not stop the keypad
            print("error:", error)
            self.emit({"event": "error", "message": str(error)})

    def run(self):
        raw = stable = 0
        changed = last_render = supervisor.ticks_ms()
        while True:
            now = supervisor.ticks_ms()
            try:
                mask = self.keypad.read()
            except OSError:
                mask = raw
            if mask != raw:
                raw = mask
                changed = now
            elif mask != stable and ticks_diff(now, changed) >= DEBOUNCE_MS:
                diff = mask ^ stable
                stable = mask
                for key in range(NUM_KEYS):
                    if diff >> key & 1:
                        self._guard(self.engine.key_event, key, bool(mask >> key & 1), now)
            self._guard(self.engine.tick, now)

            if self.port is not None:
                if self.port.in_waiting:
                    self._guard(self.proto.feed, self.port.read(self.port.in_waiting))
                if self.engine.paused and not self.port.connected:
                    self.engine.paused = False  # never stay paused once the web app is gone

            if ticks_diff(now, last_render) >= RENDER_MS:
                last_render = now
                frame = self.engine.render(now)
                if frame:
                    self.leds.show(*frame)

            if self.pending_reboot and ticks_diff(now, self.pending_reboot[1]) >= 0:
                self.engine.release_all()
                self.leds.fill(OFF, 0)
                reboot(self.pending_reboot[0])

            time.sleep(0.001)


def main():
    App().run()
