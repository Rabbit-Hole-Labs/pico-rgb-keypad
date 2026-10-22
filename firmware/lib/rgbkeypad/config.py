"""Config validation and compilation.

Pure Python with no hardware imports, so tests run it under CPython unchanged.
web/js/config.js applies the same rules before it sends a config; this module
is the device's own check and must never trust the host.
"""

from .codes import KEYS, MEDIA

NUM_KEYS = 16
MAX_LAYERS = 8
MAX_STEPS = 64
MAX_TEXT = 1000
MAX_DELAY_MS = 10000
MAX_LABEL = 24
MAX_COMBO = 8
MAX_IDLE_S = 3600
MAX_TYPE_DELAY_MS = 200
LAYER_MODES = ("to", "hold", "next")
BLINK_CHOICES = ("key", "off")  # or a "#rrggbb" color
STEP_OPS = ("tap", "down", "up", "text", "media", "delay")
ROTATIONS = (0, 90, 180, 270)


class ConfigError(ValueError):
    pass


def _key(label, color, action):
    return {"label": label, "color": color, "action": action}


def _combo(label, color, *keys):
    return _key(label, color, {"type": "keys", "keys": list(keys)})


def _media(label, color, code):
    return _key(label, color, {"type": "media", "code": code})


def _next_layer(color):
    return _key("Next layer", color, {"type": "layer", "mode": "next", "layer": 0})


def default_config():
    """A starter layout for macOS. Built fresh each call so callers may mutate it."""
    blue, teal, amber, rose, violet, white = (
        "#2f6bff", "#00b39b", "#ff9d00", "#ff3d6e", "#8b5cf6", "#9aa4b2")
    main = [
        _combo("Copy", blue, "LEFT_GUI", "C"),
        _combo("Paste", blue, "LEFT_GUI", "V"),
        _combo("Undo", blue, "LEFT_GUI", "Z"),
        _combo("Redo", blue, "LEFT_GUI", "LEFT_SHIFT", "Z"),
        _media("Previous", teal, "SCAN_PREVIOUS_TRACK"),
        _media("Play/Pause", teal, "PLAY_PAUSE"),
        _media("Next", teal, "SCAN_NEXT_TRACK"),
        _media("Mute", teal, "MUTE"),
        _media("Volume -", amber, "VOLUME_DECREMENT"),
        _media("Volume +", amber, "VOLUME_INCREMENT"),
        _media("Bright -", amber, "BRIGHTNESS_DECREMENT"),
        _media("Bright +", amber, "BRIGHTNESS_INCREMENT"),
        _combo("Screenshot", rose, "LEFT_GUI", "LEFT_SHIFT", "FOUR"),
        _combo("Spotlight", rose, "LEFT_GUI", "SPACEBAR"),
        _combo("Mission Ctl", rose, "LEFT_CONTROL", "UP_ARROW"),
        _next_layer(white),
    ]
    numbers = [
        _combo("7", violet, "SEVEN"), _combo("8", violet, "EIGHT"),
        _combo("9", violet, "NINE"), _combo("Delete", rose, "BACKSPACE"),
        _combo("4", violet, "FOUR"), _combo("5", violet, "FIVE"),
        _combo("6", violet, "SIX"), _combo("Tab", amber, "TAB"),
        _combo("1", violet, "ONE"), _combo("2", violet, "TWO"),
        _combo("3", violet, "THREE"), _combo("Enter", teal, "ENTER"),
        _combo("0", violet, "ZERO"), _combo(".", violet, "PERIOD"),
        _key("Sign-off", blue, {"type": "macro", "steps": [
            {"op": "text", "text": "Best regards,"},
            {"op": "tap", "keys": ["ENTER"]},
            {"op": "delay", "ms": 50},
            {"op": "text", "text": "Your Name"},
        ], "blink": "key"}),
        _next_layer(white),
    ]
    return {
        "version": 1,
        "brightness": 0.4,
        "highlight": "#ffffff",
        "idle_timeout": 0,
        "type_delay": 0,
        "rotation": 0,
        "layers": [
            {"name": "Main", "keys": main},
            {"name": "Numbers", "keys": numbers},
        ],
    }


def _fail(where, message):
    raise ConfigError(where + ": " + message)


def _int(value, where, lo, hi):
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(where, "must be a whole number")
    if value < lo or value > hi:
        _fail(where, "must be between %d and %d" % (lo, hi))
    return value


def _str(value, where, max_len, allow_empty=True):
    if not isinstance(value, str):
        _fail(where, "must be text")
    if len(value) > max_len:
        _fail(where, "is longer than %d characters" % max_len)
    if not allow_empty and not value:
        _fail(where, "must not be empty")
    return value


def _typeable(value, where):
    _str(value, where, MAX_TEXT, allow_empty=False)
    for ch in value:
        o = ord(ch)
        if not (32 <= o <= 126 or ch in "\n\t"):
            _fail(where, "contains %r, which a US keyboard layout can't type" % ch)
    return value


def _color(value, where):
    if not isinstance(value, str) or len(value) != 7 or value[0] != "#":
        _fail(where, "must be a color like #ff8800")
    try:
        int(value[1:], 16)
    except ValueError:
        _fail(where, "must be a color like #ff8800")
    return value.lower()


def _blink(value, where):
    """What a key shows while its macro runs: "key" blinks its own color, "off"
    doesn't blink, and a color blinks that color."""
    if value in BLINK_CHOICES:
        return value
    if not isinstance(value, str) or len(value) != 7 or value[0] != "#":
        _fail(where, 'must be "key", "off" or a color like #ff8800')
    return _color(value, where)


def parse_color(value):
    n = int(value[1:], 16)
    return ((n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF)


def _keys(value, where, allow_empty):
    if not isinstance(value, list):
        _fail(where, "must be a list of key names")
    if not value and not allow_empty:
        _fail(where, "needs at least one key")
    if len(value) > MAX_COMBO:
        _fail(where, "has more than %d keys" % MAX_COMBO)
    regular = 0
    for name in value:
        if name not in KEYS:
            _fail(where, "unknown key %r" % (name,))
        if KEYS[name] < 0xE0:
            regular += 1
    if regular > 6:
        _fail(where, "USB keyboards can only hold 6 non-modifier keys at once")
    return list(value)


def _media_code(value, where):
    if value not in MEDIA:
        _fail(where, "unknown media key %r" % (value,))
    return value


def _step(step, where):
    if not isinstance(step, dict):
        _fail(where, "must be an object")
    op = step.get("op")
    if op not in STEP_OPS:
        _fail(where + ".op", "must be one of " + ", ".join(STEP_OPS))
    if op in ("tap", "down"):
        return {"op": op, "keys": _keys(step.get("keys"), where + ".keys", False)}
    if op == "up":
        return {"op": op, "keys": _keys(step.get("keys", []), where + ".keys", True)}
    if op == "text":
        return {"op": op, "text": _typeable(step.get("text"), where + ".text")}
    if op == "media":
        return {"op": op, "code": _media_code(step.get("code"), where + ".code")}
    return {"op": op, "ms": _int(step.get("ms"), where + ".ms", 0, MAX_DELAY_MS)}


def _action(action, where, layer_count):
    if action is None:
        return {"type": "none"}
    if not isinstance(action, dict):
        _fail(where, "must be an object")
    kind = action.get("type", "none")
    if kind == "none":
        return {"type": "none"}
    if kind == "keys":
        return {"type": kind, "keys": _keys(action.get("keys"), where + ".keys", False)}
    if kind == "text":
        return {"type": kind, "text": _typeable(action.get("text"), where + ".text")}
    if kind == "media":
        return {"type": kind, "code": _media_code(action.get("code"), where + ".code")}
    if kind == "macro":
        steps = action.get("steps")
        if not isinstance(steps, list) or not steps:
            _fail(where + ".steps", "needs at least one step")
        if len(steps) > MAX_STEPS:
            _fail(where + ".steps", "has more than %d steps" % MAX_STEPS)
        for i, s in enumerate(steps):
            steps[i] = _step(s, "%s.steps[%d]" % (where, i))
        return {"type": kind, "steps": steps,
                "blink": _blink(action.get("blink", "key"), where + ".blink")}
    if kind == "layer":
        mode = action.get("mode")
        if mode not in LAYER_MODES:
            _fail(where + ".mode", "must be one of " + ", ".join(LAYER_MODES))
        layer = 0 if mode == "next" else _int(
            action.get("layer"), where + ".layer", 0, layer_count - 1)
        return {"type": kind, "mode": mode, "layer": layer}
    _fail(where + ".type", "unknown action type %r" % (kind,))


def normalize(cfg):
    """Return the clean form of cfg, or raise ConfigError naming the bad field.

    To fit in a Pico's RAM, the result reuses cfg's lists: each key is replaced by
    its clean form as it's checked, so the raw one can be freed straight away
    instead of two whole layouts being held at once. Don't use cfg afterwards.
    """
    if not isinstance(cfg, dict):
        _fail("config", "must be an object")
    if cfg.get("version", 1) != 1:
        _fail("version", "this firmware reads config version 1")
    brightness = cfg.get("brightness", 0.4)
    if isinstance(brightness, bool) or not isinstance(brightness, (int, float)) \
            or not 0 <= brightness <= 1:
        _fail("brightness", "must be between 0 and 1")
    rotation = cfg.get("rotation", 0)
    if rotation not in ROTATIONS:
        _fail("rotation", "must be 0, 90, 180 or 270")
    layers = cfg.get("layers")
    if not isinstance(layers, list) or not layers:
        _fail("layers", "needs at least one layer")
    if len(layers) > MAX_LAYERS:
        _fail("layers", "has more than %d layers" % MAX_LAYERS)
    for li, layer in enumerate(layers):
        where = "layers[%d]" % li
        if not isinstance(layer, dict):
            _fail(where, "must be an object")
        keys = layer.get("keys")
        if not isinstance(keys, list) or len(keys) != NUM_KEYS:
            _fail(where + ".keys", "must list exactly %d keys" % NUM_KEYS)
        for ki, key in enumerate(keys):
            kw = "%s.keys[%d]" % (where, ki)
            if not isinstance(key, dict):
                _fail(kw, "must be an object")
            keys[ki] = {
                "label": _str(key.get("label", ""), kw + ".label", MAX_LABEL),
                "color": _color(key.get("color", "#000000"), kw + ".color"),
                "action": _action(key.get("action"), kw + ".action", len(layers)),
            }
        layers[li] = {
            "name": _str(layer.get("name", "Layer %d" % (li + 1)), where + ".name",
                         MAX_LABEL, allow_empty=False),
            "keys": keys,
        }
    return {
        "version": 1,
        "brightness": float(brightness),
        "highlight": _color(cfg.get("highlight", "#ffffff"), "highlight"),
        "idle_timeout": _int(cfg.get("idle_timeout", 0), "idle_timeout", 0, MAX_IDLE_S),
        "type_delay": _int(cfg.get("type_delay", 0), "type_delay", 0, MAX_TYPE_DELAY_MS),
        "rotation": rotation,
        "layers": layers,
    }


def _codes(names):
    return tuple(KEYS[n] for n in names)


def _compile_steps(steps):
    ops = []
    for s in steps:
        op = s["op"]
        if op == "tap":
            codes = _codes(s["keys"])
            ops.append(("down", codes))
            ops.append(("up", codes))
        elif op == "down":
            ops.append(("down", _codes(s["keys"])))
        elif op == "up":
            ops.append(("up", _codes(s["keys"])))
        elif op == "text":
            ops.append(("text", s["text"]))
        elif op == "media":
            ops.append(("media", MEDIA[s["code"]]))
        else:
            ops.append(("wait", s["ms"]))
    return tuple(ops)


def compile_action(action):
    """Turn a normalized action into the tuple the engine runs."""
    kind = action["type"]
    if kind == "keys":
        return ("keys", _codes(action["keys"]))
    if kind == "media":
        return ("media", MEDIA[action["code"]])
    if kind == "text":
        return ("seq", (("text", action["text"]),), None)
    if kind == "macro":
        blink = action["blink"]
        if blink not in BLINK_CHOICES:
            blink = parse_color(blink)
        elif blink == "off":
            blink = None
        return ("seq", _compile_steps(action["steps"]), blink)
    if kind == "layer":
        return ("layer", action["mode"], action["layer"])
    return None


def compile_config(cfg):
    """Compile a normalized config into the engine's runtime form."""
    brightness = cfg["brightness"]
    level = int(brightness * 31 + 0.5)
    if brightness > 0 and level == 0:
        level = 1
    return {
        "layers": [
            [(parse_color(k["color"]), compile_action(k["action"])) for k in layer["keys"]]
            for layer in cfg["layers"]
        ],
        "level": level,
        "highlight": parse_color(cfg["highlight"]),
        "idle_ms": cfg["idle_timeout"] * 1000,
        "type_delay": cfg["type_delay"],
    }
