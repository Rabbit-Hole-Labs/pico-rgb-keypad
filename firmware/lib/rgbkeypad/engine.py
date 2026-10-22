"""Key presses, layers, macro playback and LED frames.

Pure Python: the HID adapter, event sink and clock are passed in, so CPython
tests drive it with fakes. Times are supervisor.ticks_ms() values, which wrap
at 2**29, so they are only ever compared through ticks_diff().
"""

NUM_KEYS = 16
TICKS_PERIOD = 1 << 29
_HALF_PERIOD = TICKS_PERIOD // 2
FLASH_MS = 120
IDENTIFY_MS = 2000
BLINK_MS = 250         # half-period of the "macro running" blink
MAX_QUEUE = 1024
OPS_PER_TICK = 32
OFF = (0, 0, 0)
WHITE = (255, 255, 255)


def ticks_add(ticks, delta):
    return (ticks + delta) % TICKS_PERIOD


def ticks_diff(end, start):
    return ((end - start + _HALF_PERIOD) % TICKS_PERIOD) - _HALF_PERIOD


class Engine:
    """Turns key edges into HID reports and decides what each LED shows.

    hid needs press(codes), release(codes), release_all(), consumer_press(code),
    consumer_release() and char_codes(ch) -> codes or None. emit(dict) receives
    events for the web app.
    """

    def __init__(self, hid, emit):
        self.hid = hid
        self.emit = emit
        self.layers = [[(OFF, None)] * NUM_KEYS]
        self.level = 0
        self.highlight = WHITE
        self.idle_ms = 0
        self.type_delay = 0
        self.base = 0
        self.holds = []        # (key, layer) for momentary layers, newest last
        self.held = {}         # key -> action resolved when it went down
        self.queue = []        # pending macro ops, each action ends with ("end", key)
        self.runs = {}         # key -> [queued runs, blink color] while its macro runs
        self.text = None       # string being typed, one character per tick
        self.text_i = 0
        self.wait_until = None
        self.macro_keys = []   # codes the macro runner is holding down
        self.flash = {}        # key -> ticks when its press highlight ends
        self.identify_key = None
        self.identify_start = 0
        self.last_activity = 0
        self.paused = False    # pick mode: report presses to the web app, run nothing
        self._last_frame = None

    def load(self, compiled, now):
        """Swap in a compiled config. Anything held or queued is released first."""
        self.release_all()
        before = self.active_layer()
        self.layers = compiled["layers"]
        self.level = compiled["level"]
        self.highlight = compiled["highlight"]
        self.idle_ms = compiled["idle_ms"]
        self.type_delay = compiled["type_delay"]
        if self.base >= len(self.layers):
            self.base = 0
        self.last_activity = now
        self._last_frame = None
        self._layer_changed(before)

    def release_all(self):
        before = self.active_layer()
        self.hid.release_all()
        self.hid.consumer_release()
        self.held = {}
        self.holds = []
        self.queue = []
        self.runs = {}
        self.text = None
        self.wait_until = None
        self.macro_keys = []
        self._layer_changed(before)

    def active_layer(self):
        layer = self.holds[-1][1] if self.holds else self.base
        return layer if layer < len(self.layers) else 0

    def set_layer(self, layer, now):
        if not 0 <= layer < len(self.layers):
            raise ValueError("no layer %d" % layer)
        before = self.active_layer()
        self.base = layer
        self.holds = []
        self.last_activity = now
        self._layer_changed(before)

    def identify(self, key, now):
        """Blink one key so the web app can show which physical key it means."""
        if not 0 <= key < NUM_KEYS:
            raise ValueError("no key %d" % key)
        self.identify_key = key
        self.identify_start = now
        self.last_activity = now

    def busy(self):
        return bool(self.queue) or self.text is not None

    def key_event(self, key, down, now):
        self.last_activity = now
        self.emit({"event": "key", "key": key, "down": down})
        if down:
            self.flash[key] = ticks_add(now, FLASH_MS)
            action = None if self.paused else self.layers[self.active_layer()][key][1]
            self.held[key] = action
            if action is None:
                return
            kind = action[0]
            if kind == "keys":
                self.hid.press(action[1])
            elif kind == "media":
                self.hid.consumer_press(action[1])
            elif kind == "seq":
                self._enqueue(action[1], key, self._blink_color(action[2], key))
            elif kind == "layer":
                self._layer_down(key, action[1], action[2])
            return
        action = self.held.pop(key, None)
        if action is None:
            return
        kind = action[0]
        if kind == "keys":
            self.hid.release(action[1])
        elif kind == "media":
            self.hid.consumer_release()
        elif kind == "layer" and action[1] == "hold":
            before = self.active_layer()
            self.holds = [h for h in self.holds if h[0] != key]
            self._layer_changed(before)

    def _layer_down(self, key, mode, target):
        before = self.active_layer()
        if mode == "to":
            self.base = target
        elif mode == "next":
            self.base = (self.base + 1) % len(self.layers)
        else:
            self.holds.append((key, target))
        self._layer_changed(before)

    def _layer_changed(self, before):
        after = self.active_layer()
        if after != before:
            self._last_frame = None
            self.emit({"event": "layer", "layer": after})

    def _blink_color(self, blink, key):
        """None, "key" (this key's color, or the highlight if it's unlit) or a color."""
        if blink != "key":
            return blink
        color = self.layers[self.active_layer()][key][0]
        return color if color != OFF else self.highlight

    def _enqueue(self, ops, key=None, blink=None):
        if len(self.queue) + len(ops) + 1 > MAX_QUEUE:
            self.emit({"event": "error", "message": "Macro queue is full; press ignored"})
            return
        self.queue.extend(ops)
        self.queue.append(("end", key if blink else None))
        if blink:
            run = self.runs.get(key)
            if run:
                run[0] += 1
                run[1] = blink
            else:
                self.runs[key] = [1, blink]

    def tick(self, now):
        """Run queued macro work: up to OPS_PER_TICK ops, or one typed character."""
        if self.wait_until is not None:
            if ticks_diff(now, self.wait_until) < 0:
                return
            self.wait_until = None
        for _ in range(OPS_PER_TICK):
            if self.text is not None:
                self._type_next(now)
                return
            if not self.queue:
                return
            op = self.queue.pop(0)
            kind = op[0]
            if kind == "down":
                self.hid.press(op[1])
                for code in op[1]:
                    if code not in self.macro_keys:
                        self.macro_keys.append(code)
            elif kind == "up":
                codes = op[1] or tuple(self.macro_keys)
                self.hid.release(codes)
                self.macro_keys = [c for c in self.macro_keys if c not in codes]
            elif kind == "media":
                self.hid.consumer_press(op[1])
                self.hid.consumer_release()
            elif kind == "text":
                self.text = op[1]
                self.text_i = 0
            elif kind == "wait":
                if op[1]:
                    self.wait_until = ticks_add(now, op[1])
                    return
            elif kind == "end":
                if self.macro_keys:
                    # A macro never leaves keys stuck down after it finishes.
                    self.hid.release(tuple(self.macro_keys))
                    self.macro_keys = []
                run = self.runs.get(op[1])
                if run:
                    run[0] -= 1
                    if run[0] <= 0:
                        del self.runs[op[1]]

    def _type_next(self, now):
        ch = self.text[self.text_i]
        self.text_i += 1
        if self.text_i >= len(self.text):
            self.text = None
        codes = self.hid.char_codes(ch)
        if codes:
            self.hid.press(codes)
            self.hid.release(codes)
        if self.type_delay:
            self.wait_until = ticks_add(now, self.type_delay)

    def render(self, now):
        """Return (colors, level) when the LEDs need to change, else None."""
        identifying = self.identify_key is not None
        if identifying and ticks_diff(now, self.identify_start) >= IDENTIFY_MS:
            self.identify_key = None
            identifying = False
        asleep = (self.idle_ms and not identifying and not self.held and not self.busy()
                  and ticks_diff(now, self.last_activity) >= self.idle_ms)
        keys = self.layers[self.active_layer()]
        frame = []
        for i in range(NUM_KEYS):
            if identifying and i == self.identify_key:
                on = (ticks_diff(now, self.identify_start) // 125) % 2 == 0
                frame.append(WHITE if on else OFF)
            elif asleep:
                frame.append(OFF)
            elif i in self.held:
                frame.append(self.highlight)
            elif i in self.runs:
                on = (now // BLINK_MS) % 2 == 0
                frame.append(self.runs[i][1] if on else OFF)
            elif i in self.flash:
                if ticks_diff(self.flash[i], now) > 0:
                    frame.append(self.highlight)
                else:
                    del self.flash[i]
                    frame.append(keys[i][0])
            else:
                frame.append(keys[i][0])
        result = (tuple(frame), self.level)
        if result == self._last_frame:
            return None
        self._last_frame = result
        return result
