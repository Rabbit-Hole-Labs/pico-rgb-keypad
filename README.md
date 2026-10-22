# Pico RGB Keypad

Firmware and a browser-based configurator for the
[Pimoroni Pico RGB Keypad Base](https://shop.pimoroni.com/products/pico-rgb-keypad-base)
with a Raspberry Pi Pico or Pico 2.

- **Hotkeys and macros.** Each of the 16 keys can send a shortcut (held while you hold the key),
  type text, press a media key, run a multi-step macro (shortcuts, text, waits, media keys,
  hold/release), or switch layers. There can be up to 8 layers.
- **Running macros blink.** While a macro runs, its key blinks in its own color or a color you
  pick for that macro, so you can tell it's still going.
- **Colors.** Each key has its own LED color. You also set the brightness, the color a key shows
  while pressed, and an optional idle timeout that turns the LEDs off.
- **Mac or Windows.** A setting shows shortcuts the way your computer names them (⌘C or
  Ctrl+C) and picks the matching starter layout. The keypad itself works the same on both.
- **No software to install.** The keypad is a standard USB keyboard and media controller. The
  configurator is a web page that talks to the keypad over Web Serial in Chrome or Edge.
- **Live editing.** Edits preview on the keypad as you make them and are saved when you click
  Save. Pick mode lets you select a key by pressing it.
- **Updates from the browser.** The Firmware tab installs new firmware over USB serial. It sends
  only the files that changed and checks each one by CRC before switching over.

## Quick start

1. **Install CircuitPython 10** on the Pico. Hold BOOTSEL while plugging it in, then drag the
   `.uf2` for your board onto the drive that appears:
   [Pico](https://circuitpython.org/board/raspberry_pi_pico/) ·
   [Pico 2](https://circuitpython.org/board/raspberry_pi_pico2/).
2. **Copy the firmware.** Copy everything inside [`firmware/`](firmware/) onto the `CIRCUITPY`
   drive, replacing `code.py`. Skip `manifest.json`; it's only for the web updater.
3. **Unplug the keypad and plug it back in.** It starts with a starter layout for macOS (copy,
   paste, media keys, and so on) and hides the `CIRCUITPY` drive (see [Modes](#modes)). On
   Windows, set **Your computer** to Windows in Settings and click **Load starter layout**.
4. **Open the configurator** in Chrome or Edge:

   ```bash
   npm run serve
   ```

   Then open <http://localhost:8000/web/>, click **Connect keypad**, and pick
   "Pico RGB Keypad". Once you've allowed the port, the page reconnects by itself, including
   after the keypad restarts.

The page must be served over `http://localhost` or `https://`. Opened as a file, it can't load
firmware updates. Any static host works too, for example GitHub Pages serving the repository
root.

**Using a different port.** `npm run serve` is defined in `package.json` as
`python3 -m http.server 8000 --bind 127.0.0.1`. Change `8000` there, or skip npm and run that
command yourself with another port, then open `http://localhost:<port>/web/`. The browser treats
each port as a separate site, so after a change you'll pick the keypad in the Connect dialog
again, and unsaved edits made at the old address won't appear.

**On Windows.** Use Chrome or Edge. The keypad appears in the Connect dialog as a COM port,
and in USB drive mode `CIRCUITPY` gets a drive letter. If `python3` isn't found, run the server
with `py -m http.server 8000 --bind 127.0.0.1` instead. The hardware test scripts in
`tests/hardware/` open `/dev/...` ports and only run on macOS or Linux.

## Using the configurator

| Area | What it does |
| --- | --- |
| Keypad grid | Click a key to edit it. Each key is named by the character printed beside it on the board (0–F). Keys glow in their LED color and highlight while you press them on the real keypad. |
| Key tab | Label (shown on this page only), color, and the action: **Shortcut**, **Type text**, **Media**, **Macro** or **Layer**. **● Record** captures a shortcut from your keyboard. |
| Layer tab | Rename, reorder, duplicate or delete layers. It warns about a layer you can't reach, or one you can switch to but never leave. |
| Settings tab | Mac or Windows, brightness, pressed-key color, idle LED timeout, delay between typed characters, which side the USB port is on, and export, import and reset. |
| Firmware tab | Versions, firmware updates, and restarting normally, as a USB drive, or into the bootloader. |

Every edit is sent to the keypad as a preview. **Save to keypad** (⌘S) stores it in the keypad's
`config.json`, and **Revert** goes back to the saved version. Unsaved edits also survive a page
reload in this browser.

**USB port position** in Settings turns the on-screen keypad to match your desk. The default,
USB on the left, is the way the printed characters read upright: 0123 / 4567 / 89AB / CDEF.

A layout can be up to 12 KB, and the Settings tab shows how much you're using. The keypad holds
the whole layout in about 90 KB of RAM. Long typed text is cheap; the worst case is many small
macro steps. The editor won't send a layout over the limit.

Typed text uses the US keyboard layout. It supports printable ASCII plus Return and Tab, and the
editor flags anything else. If an app drops characters, raise **Pause between typed characters**
in Settings.

## Modes

| Mode | How you get there | What you see |
| --- | --- | --- |
| Normal | Plugging in | One serial port, used by the configurator. The `CIRCUITPY` drive is hidden so the firmware can write its own files. |
| USB drive | Hold **key 0** (top-left with the USB port on the left) while plugging in, or **Restart as USB drive** in the Firmware tab | `CIRCUITPY` appears on your computer, writable, for one boot. The CircuitPython console (REPL) appears as a second serial port. Saving and updates from the page are off. |
| Recovery | Automatic if the firmware fails to start | All keys turn red. The page shows the error and can reinstall the firmware. |
| Bootloader | **Restart into bootloader** in the Firmware tab, or BOOTSEL while plugging in | An `RPI-RP2` or `RP2350` drive appears. Drag a CircuitPython `.uf2` onto it to update CircuitPython. Your files are kept. |

If `boot.py` itself breaks, CircuitPython's safe mode skips it. If the keypad base doesn't answer
at boot, the firmware starts in USB drive mode so a bare Pico never hides its drive.

## Hardware notes

Pins follow Pimoroni's C driver: a TCA9555 key expander on I2C0 (GP4 SDA, GP5 SCL, address
`0x20`) and 16 APA102 LEDs on SPI0 (GP18 SCK, GP19 MOSI) gated by CS on GP17. Key index *n*
(expander bit *n*) and LED *n* are the same pad, the one printed *n* (0–9, then A–F) on the
board. With the USB port on the left, key 0 is top-left and keys run left to right, then top to
bottom. This was checked on a real board.

## Project layout

```
firmware/                 copied to CIRCUITPY
  boot.py                 USB setup: drive vs normal mode, serial ports, device name
  code.py                 starts rgbkeypad.app, or recovery mode if that fails
  manifest.json           files and version the web updater installs
  lib/rgbkeypad/          the firmware (config, engine, protocol, fs are hardware-free)
  lib/adafruit_hid/       Adafruit CircuitPython HID 6.1.10, CircuitPython 10 .mpy build (MIT)
web/                      the configurator: plain HTML, CSS and ES modules, no build step
tests/
  firmware/               unittest for the firmware's pure modules (runs on CPython)
  web/                    node:test for the web modules
  fixtures/               config cases run against both validators
  hardware/               manual checks against a connected keypad
```

## Development

```bash
npm test                  # web (node:test) + firmware (python unittest); no dependencies to install
npm run serve             # http://localhost:8000/web/
npm run smoke -- /dev/cu.usbmodemXXXX   # protocol checks against a connected keypad
node tests/hardware/web-e2e.mjs /dev/cu.usbmodemXXXX [--install]   # the web modules against a keypad
```

When you change the firmware, bump `VERSION` in `firmware/lib/rgbkeypad/__init__.py` and
`version` in `firmware/manifest.json` together. Add any new file to the manifest, or the updater
won't send it. `firmware/lib/rgbkeypad/codes.py` and `web/js/codes.js` must list the same key
names, and the tests check that.

### Serial protocol

The protocol uses newline-delimited JSON on the keypad's data port. Each request
`{"id": n, "cmd": "...", ...}` gets one reply with the same `id`: `{"ok": true, ...}` or
`{"ok": false, "error": "..."}`. The keypad also sends `{"event": "key", "key": 3, "down": true}`,
`{"event": "layer", "layer": 1}` and `{"event": "error", "message": "..."}`.

| Command | Arguments | Reply |
| --- | --- | --- |
| `hello` | | `fw`, `board`, `circuitpython`, `writable`, `layer`, `mem_free`, `fs_free`, `config_error`, plus `recovery` in recovery mode |
| `get_config` | | `config` |
| `get_default_config` | `platform`: `mac` or `windows` | `config`, the starter layout for that computer |
| `set_config` | `config`, `save` | Applies the config at once and writes `config.json` if `save` is true |
| `set_layer` | `layer` | |
| `identify` | `key` | Blinks that key for 2 s |
| `set_paused` | `paused` | Pick mode: presses are reported but don't run actions. Clears itself when the port closes |
| `reboot` | `mode`: `reload`, `normal`, `drive`, `bootloader` | Replies, then restarts |
| `fs_write` | `path`, `offset`, `data` (base64) | Appends to `path.new`. `size` |
| `fs_crc` | `path`, `staged` | `crc` (CRC32), `size` |
| `fs_commit` / `fs_discard` | `paths` | Moves staged files into place / deletes them |
| `fs_list`, `fs_read`, `fs_delete` | `path` … | |

### Config format

`config.json` is validated by `firmware/lib/rgbkeypad/config.py` and mirrored in
`web/js/config.js`:

```json
{
  "version": 1, "brightness": 0.4, "highlight": "#ffffff",
  "idle_timeout": 0, "type_delay": 0, "rotation": 0, "platform": "mac",
  "layers": [{ "name": "Main", "keys": [
    { "label": "Copy", "color": "#2f6bff", "action": { "type": "keys", "keys": ["LEFT_GUI", "C"] } },
    { "label": "Sign-off", "color": "#00b39b", "action": { "type": "macro", "steps": [
      { "op": "text", "text": "Best regards," }, { "op": "tap", "keys": ["ENTER"] },
      { "op": "delay", "ms": 50 }, { "op": "text", "text": "Your Name" } ] } }
  ] }]
}
```

Each layer has exactly 16 keys. These are the action types:

- `none`
- `keys` with `keys`, a list of names
- `text` with `text`
- `media` with `code`
- `macro` with `steps` and `blink`. A step's `op` is `tap`, `down`, `up`, `text`, `media` or
  `delay`. `blink` sets what the key shows while the macro runs: `key` (its own color, the
  default), `off`, or a color like `#ff8800`.
- `layer` with `mode` (`to`, `hold` or `next`) and `layer`

Key and media names are the `adafruit_hid` constant names, such as `LEFT_GUI`, `F13` or
`PLAY_PAUSE`.
