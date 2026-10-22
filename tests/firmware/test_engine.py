import unittest

from _path import FIRMWARE  # noqa: F401  (puts firmware/lib on sys.path)

from rgbkeypad.codes import KEYS, MEDIA
from rgbkeypad.config import compile_config, normalize
from rgbkeypad.engine import (
    BLINK_MS, FLASH_MS, IDENTIFY_MS, OFF, TICKS_PERIOD, WHITE, Engine, ticks_add, ticks_diff)

A, B, SHIFT, GUI = KEYS["A"], KEYS["B"], KEYS["LEFT_SHIFT"], KEYS["LEFT_GUI"]


class FakeHid:
    def __init__(self):
        self.log = []

    def press(self, codes):
        self.log.append(("press", tuple(codes)))

    def release(self, codes):
        self.log.append(("release", tuple(codes)))

    def release_all(self):
        self.log.append(("release_all",))

    def consumer_press(self, code):
        self.log.append(("cpress", code))

    def consumer_release(self):
        self.log.append(("crelease",))

    def char_codes(self, ch):
        if ch == "!":
            return None  # stands in for a character the layout can't type
        return (SHIFT, A) if ch == "A" else (A,)


def blank():
    return [{"label": "", "color": "#000000", "action": {"type": "none"}} for _ in range(16)]


def make(keys0, keys1=None, **settings):
    layers = [{"name": "Zero", "keys": keys0}]
    if keys1 is not None:
        layers.append({"name": "One", "keys": keys1})
    cfg = {"version": 1, "layers": layers}
    cfg.update(settings)
    hid, events = FakeHid(), []
    engine = Engine(hid, events.append)
    engine.load(compile_config(normalize(cfg)), 0)
    hid.log.clear()
    events.clear()
    return engine, hid, events


def run_ticks(engine, start, count, step=1):
    for t in range(start, start + count * step, step):
        engine.tick(t)


class Ticks(unittest.TestCase):
    def test_diff_across_wrap(self):
        end = ticks_add(TICKS_PERIOD - 5, 10)
        self.assertEqual(end, 5)
        self.assertEqual(ticks_diff(end, TICKS_PERIOD - 5), 10)
        self.assertEqual(ticks_diff(TICKS_PERIOD - 5, end), -10)


class KeyActions(unittest.TestCase):
    def test_combo_held_while_key_is_down(self):
        keys = blank()
        keys[0]["action"] = {"type": "keys", "keys": ["LEFT_GUI", "C"]}
        engine, hid, events = make(keys)
        engine.key_event(0, True, 0)
        engine.key_event(0, False, 50)
        codes = (GUI, KEYS["C"])
        self.assertEqual(hid.log, [("press", codes), ("release", codes)])
        self.assertEqual(events, [{"event": "key", "key": 0, "down": True},
                                  {"event": "key", "key": 0, "down": False}])

    def test_media_key(self):
        keys = blank()
        keys[1]["action"] = {"type": "media", "code": "PLAY_PAUSE"}
        engine, hid, _ = make(keys)
        engine.key_event(1, True, 0)
        engine.key_event(1, False, 10)
        self.assertEqual(hid.log, [("cpress", MEDIA["PLAY_PAUSE"]), ("crelease",)])

    def test_paused_reports_presses_but_runs_nothing(self):
        keys = blank()
        keys[0]["action"] = {"type": "keys", "keys": ["A"]}
        engine, hid, events = make(keys)
        engine.paused = True
        engine.key_event(0, True, 0)
        engine.paused = False  # unpausing mid-press must not release a key never pressed
        engine.key_event(0, False, 5)
        self.assertEqual(hid.log, [])
        self.assertEqual([e["down"] for e in events], [True, False])

    def test_unassigned_key_sends_nothing(self):
        engine, hid, events = make(blank())
        engine.key_event(3, True, 0)
        engine.key_event(3, False, 5)
        self.assertEqual(hid.log, [])
        self.assertEqual(len(events), 2)

    def test_release_uses_action_from_press_time(self):
        keys0, keys1 = blank(), blank()
        keys0[0]["action"] = {"type": "keys", "keys": ["A"]}
        keys0[1]["action"] = {"type": "layer", "mode": "to", "layer": 1}
        keys1[0]["action"] = {"type": "keys", "keys": ["B"]}
        engine, hid, _ = make(keys0, keys1)
        engine.key_event(0, True, 0)
        engine.key_event(1, True, 1)
        engine.key_event(0, False, 2)
        self.assertEqual(hid.log, [("press", (A,)), ("release", (A,))])


class Layers(unittest.TestCase):
    def setUp(self):
        self.keys0, self.keys1 = blank(), blank()
        self.keys1[0]["action"] = {"type": "keys", "keys": ["B"]}

    def test_next_cycles_and_reports(self):
        self.keys0[15]["action"] = {"type": "layer", "mode": "next", "layer": 0}
        self.keys1[15]["action"] = {"type": "layer", "mode": "next", "layer": 0}
        engine, _, events = make(self.keys0, self.keys1)
        engine.key_event(15, True, 0)
        self.assertEqual(engine.active_layer(), 1)
        engine.key_event(15, False, 1)
        engine.key_event(15, True, 2)
        self.assertEqual(engine.active_layer(), 0)
        layer_events = [e["layer"] for e in events if e["event"] == "layer"]
        self.assertEqual(layer_events, [1, 0])

    def test_hold_is_momentary(self):
        self.keys0[12]["action"] = {"type": "layer", "mode": "hold", "layer": 1}
        engine, hid, _ = make(self.keys0, self.keys1)
        engine.key_event(12, True, 0)
        engine.key_event(0, True, 1)
        engine.key_event(0, False, 2)
        engine.key_event(12, False, 3)
        self.assertEqual(engine.active_layer(), 0)
        self.assertEqual(hid.log, [("press", (B,)), ("release", (B,))])

    def test_set_layer_validates(self):
        engine, _, events = make(self.keys0, self.keys1)
        engine.set_layer(1, 0)
        self.assertEqual(engine.active_layer(), 1)
        self.assertEqual(events[-1], {"event": "layer", "layer": 1})
        with self.assertRaises(ValueError):
            engine.set_layer(2, 0)

    def test_reload_with_fewer_layers_falls_back_to_zero(self):
        engine, _, events = make(self.keys0, self.keys1)
        engine.set_layer(1, 0)
        events.clear()
        engine.load(compile_config(normalize(
            {"layers": [{"name": "Only", "keys": blank()}]})), 5)
        self.assertEqual(engine.active_layer(), 0)
        self.assertEqual(events, [{"event": "layer", "layer": 0}])


class Macros(unittest.TestCase):
    def test_text_types_one_character_per_tick(self):
        keys = blank()
        keys[0]["action"] = {"type": "text", "text": "aA!"}
        engine, hid, _ = make(keys)
        engine.key_event(0, True, 0)
        self.assertEqual(hid.log, [])  # nothing until the loop ticks
        engine.tick(1)
        self.assertEqual(hid.log, [("press", (A,)), ("release", (A,))])
        engine.tick(2)
        engine.tick(3)  # "!" has no keycodes and is skipped
        engine.tick(4)
        self.assertEqual(hid.log[2:], [("press", (SHIFT, A)), ("release", (SHIFT, A))])
        self.assertFalse(engine.busy())

    def test_type_delay_spaces_characters(self):
        keys = blank()
        keys[0]["action"] = {"type": "text", "text": "aa"}
        engine, hid, _ = make(keys, type_delay=20)
        engine.key_event(0, True, 0)
        engine.tick(0)
        engine.tick(10)
        self.assertEqual(len(hid.log), 2)
        engine.tick(20)
        self.assertEqual(len(hid.log), 4)

    def test_steps_and_delays(self):
        keys = blank()
        keys[0]["action"] = {"type": "macro", "steps": [
            {"op": "tap", "keys": ["LEFT_GUI", "SPACEBAR"]},
            {"op": "delay", "ms": 100},
            {"op": "media", "code": "MUTE"},
        ]}
        engine, hid, _ = make(keys)
        engine.key_event(0, True, 0)
        engine.tick(0)
        combo = (GUI, KEYS["SPACEBAR"])
        self.assertEqual(hid.log, [("press", combo), ("release", combo)])
        engine.tick(99)
        self.assertEqual(len(hid.log), 2)
        engine.tick(100)
        self.assertEqual(hid.log[2:], [("cpress", MEDIA["MUTE"]), ("crelease",)])
        self.assertFalse(engine.busy())

    def test_keys_held_by_a_macro_are_released_when_it_ends(self):
        keys = blank()
        keys[0]["action"] = {"type": "macro", "steps": [
            {"op": "down", "keys": ["LEFT_SHIFT"]}, {"op": "tap", "keys": ["A"]}]}
        engine, hid, _ = make(keys)
        engine.key_event(0, True, 0)
        engine.tick(0)
        self.assertEqual(hid.log[-1], ("release", (SHIFT,)))

    def test_up_with_no_keys_releases_what_the_macro_holds(self):
        keys = blank()
        keys[0]["action"] = {"type": "macro", "steps": [
            {"op": "down", "keys": ["LEFT_SHIFT", "A"]}, {"op": "up", "keys": []}]}
        engine, hid, _ = make(keys)
        engine.key_event(0, True, 0)
        engine.tick(0)
        self.assertEqual(hid.log, [("press", (SHIFT, A)), ("release", (SHIFT, A))])

    def test_presses_queue_behind_a_running_macro(self):
        keys = blank()
        keys[0]["action"] = {"type": "text", "text": "aa"}
        engine, hid, _ = make(keys)
        engine.key_event(0, True, 0)
        engine.key_event(0, False, 1)
        engine.key_event(0, True, 2)
        run_ticks(engine, 3, 10)
        self.assertEqual(hid.log.count(("press", (A,))), 4)

    def test_load_cancels_running_macro(self):
        keys = blank()
        keys[0]["action"] = {"type": "text", "text": "aaaa"}
        engine, hid, _ = make(keys)
        engine.key_event(0, True, 0)
        engine.tick(1)
        engine.load(compile_config(normalize({"layers": [{"name": "x", "keys": blank()}]})), 2)
        self.assertFalse(engine.busy())
        self.assertIn(("release_all",), hid.log)


class MacroBlink(unittest.TestCase):
    """A key blinks while its macro is queued or running (BLINK_MS on, BLINK_MS off)."""

    def run_slow_macro(self, color="#ff0000", **action):
        keys = blank()
        keys[0]["color"] = color
        keys[0]["action"] = dict({"type": "macro", "steps": [{"op": "delay", "ms": 1000}]}, **action)
        engine, _, _ = make(keys, highlight="#ffffff")
        engine.key_event(0, True, 0)
        engine.key_event(0, False, 10)
        engine.tick(10)  # starts the 1000 ms wait
        return engine

    def test_blinks_the_key_color_until_the_macro_ends(self):
        engine = self.run_slow_macro()
        self.assertEqual(engine.render(20)[0][0], (255, 0, 0))
        self.assertEqual(engine.render(BLINK_MS + 10)[0][0], OFF)
        self.assertEqual(engine.render(2 * BLINK_MS + 10)[0][0], (255, 0, 0))
        self.assertEqual(engine.render(3 * BLINK_MS + 10)[0][0], OFF)
        engine.tick(1010)  # wait over, macro ends
        self.assertEqual(engine.runs, {})
        self.assertEqual(engine.render(4 * BLINK_MS + 20)[0][0], (255, 0, 0))
        self.assertIsNone(engine.render(5 * BLINK_MS + 10))  # steady, no more blinking

    def test_blinks_a_chosen_color(self):
        engine = self.run_slow_macro(blink="#00ff00")
        self.assertEqual(engine.render(20)[0][0], (0, 255, 0))

    def test_unlit_key_blinks_the_highlight_color(self):
        engine = self.run_slow_macro(color="#000000")
        self.assertEqual(engine.render(20)[0][0], WHITE)

    def test_off_means_no_blink(self):
        engine = self.run_slow_macro(blink="off")
        self.assertEqual(engine.runs, {})
        engine.render(FLASH_MS)
        self.assertIsNone(engine.render(BLINK_MS + 10))  # nothing changes while it runs

    def test_queued_presses_keep_blinking_until_the_last_run_ends(self):
        engine = self.run_slow_macro()
        engine.key_event(0, True, 20)
        engine.key_event(0, False, 30)
        engine.tick(1010)  # first run ends, second starts its wait
        self.assertIn(0, engine.runs)
        engine.tick(2010)
        self.assertEqual(engine.runs, {})

    def test_typed_text_does_not_blink(self):
        keys = blank()
        keys[0]["action"] = {"type": "text", "text": "abc"}
        engine, _, _ = make(keys)
        engine.key_event(0, True, 0)
        self.assertEqual(engine.runs, {})


class Leds(unittest.TestCase):
    def test_frame_only_returned_when_it_changes(self):
        keys = blank()
        keys[0]["color"] = "#ff0000"
        engine, _, _ = make(keys, brightness=1)
        frame, level = engine.render(0)
        self.assertEqual(frame[0], (255, 0, 0))
        self.assertEqual(frame[1], OFF)
        self.assertEqual(level, 31)
        self.assertIsNone(engine.render(1))

    def test_pressed_key_highlights_at_least_flash_ms(self):
        keys = blank()
        keys[0]["color"] = "#ff0000"
        engine, _, _ = make(keys, highlight="#00ff00")
        engine.render(0)
        engine.key_event(0, True, 10)
        engine.key_event(0, False, 15)
        self.assertEqual(engine.render(20)[0][0], (0, 255, 0))
        self.assertIsNone(engine.render(10 + FLASH_MS - 1))
        self.assertEqual(engine.render(10 + FLASH_MS)[0][0], (255, 0, 0))

    def test_idle_timeout_turns_leds_off_and_a_press_wakes(self):
        keys = blank()
        keys[0]["color"] = "#ff0000"
        engine, _, _ = make(keys, idle_timeout=1)
        engine.render(0)
        self.assertEqual(engine.render(1000)[0][0], OFF)
        engine.key_event(5, True, 1500)
        engine.key_event(5, False, 1501)
        self.assertEqual(engine.render(1500 + FLASH_MS)[0][0], (255, 0, 0))

    def test_identify_blinks_then_stops(self):
        engine, _, _ = make(blank())
        engine.identify(3, 0)
        self.assertEqual(engine.render(0)[0][3], WHITE)
        self.assertEqual(engine.render(130)[0][3], OFF)
        self.assertEqual(engine.render(260)[0][3], WHITE)
        self.assertEqual(engine.render(IDENTIFY_MS)[0][3], OFF)
        self.assertIsNone(engine.identify_key)


if __name__ == "__main__":
    unittest.main()
