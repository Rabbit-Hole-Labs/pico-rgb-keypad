import json
import os
import unittest

from _path import FIXTURES

from rgbkeypad.codes import KEYS, MEDIA
from rgbkeypad.config import (
    ConfigError, compile_action, compile_config, default_config, normalize, parse_color)


def load_cases():
    with open(os.path.join(FIXTURES, "config-cases.json")) as f:
        return json.load(f)


class SharedCases(unittest.TestCase):
    """tests/fixtures/config-cases.json is also run against web/js/config.js."""

    def test_cases(self):
        for case in load_cases():
            with self.subTest(case["name"]):
                if case["error"] is None:
                    self.assertEqual(normalize(case["config"]), case["normalized"])
                else:
                    with self.assertRaises(ConfigError) as ctx:
                        normalize(case["config"])
                    self.assertEqual(str(ctx.exception).split(":")[0], case["error"])


class Defaults(unittest.TestCase):
    def test_default_config_is_valid_and_stable(self):
        self.assertEqual(normalize(default_config()), default_config())

    def test_default_config_is_fresh_each_call(self):
        a = default_config()
        a["layers"][0]["keys"][0]["label"] = "changed"
        self.assertEqual(default_config()["layers"][0]["keys"][0]["label"], "Copy")

    def test_normalized_config_survives_json(self):
        cfg = normalize(default_config())
        self.assertEqual(normalize(json.loads(json.dumps(cfg))), cfg)


class Compile(unittest.TestCase):
    def test_parse_color(self):
        self.assertEqual(parse_color("#ff8000"), (255, 128, 0))

    def test_brightness_maps_to_apa102_level(self):
        cfg = normalize(default_config())
        for brightness, level in ((0, 0), (0.01, 1), (0.5, 16), (1, 31)):
            cfg["brightness"] = brightness
            self.assertEqual(compile_config(cfg)["level"], level)

    def test_compile_actions(self):
        self.assertIsNone(compile_action({"type": "none"}))
        self.assertEqual(compile_action({"type": "keys", "keys": ["LEFT_GUI", "C"]}),
                         ("keys", (KEYS["LEFT_GUI"], KEYS["C"])))
        self.assertEqual(compile_action({"type": "media", "code": "MUTE"}),
                         ("media", MEDIA["MUTE"]))
        self.assertEqual(compile_action({"type": "text", "text": "hi"}),
                         ("seq", (("text", "hi"),), None))
        self.assertEqual(compile_action({"type": "layer", "mode": "hold", "layer": 1}),
                         ("layer", "hold", 1))

    def test_macro_tap_becomes_down_then_up(self):
        action = {"type": "macro", "blink": "key", "steps": [
            {"op": "tap", "keys": ["A"]}, {"op": "delay", "ms": 10},
            {"op": "up", "keys": []}, {"op": "media", "code": "MUTE"}]}
        self.assertEqual(compile_action(action), ("seq", (
            ("down", (KEYS["A"],)), ("up", (KEYS["A"],)), ("wait", 10),
            ("up", ()), ("media", MEDIA["MUTE"])), "key"))

    def test_macro_blink_compiles_to_none_key_or_rgb(self):
        steps = [{"op": "delay", "ms": 1}]
        for blink, want in (("off", None), ("key", "key"), ("#00ff80", (0, 255, 128))):
            action = {"type": "macro", "steps": steps, "blink": blink}
            self.assertEqual(compile_action(action)[2], want)

    def test_compiled_layers_hold_colors_and_actions(self):
        compiled = compile_config(normalize(default_config()))
        self.assertEqual(len(compiled["layers"]), 2)
        color, action = compiled["layers"][0][0]
        self.assertEqual(color, (0x2F, 0x6B, 0xFF))
        self.assertEqual(action[0], "keys")


if __name__ == "__main__":
    unittest.main()
