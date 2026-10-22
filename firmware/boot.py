"""Runs once at power-up, before USB starts.

Normal boot hides the CIRCUITPY drive and makes it writable to the firmware,
so the web app can save config.json and install updates over serial. The only
serial port is the data port the web app talks to.

USB drive mode shows CIRCUITPY to the computer, writable from there instead,
and adds the CircuitPython console (REPL) as a second serial port.
It lasts one boot and is entered by holding key 0 (top-left with the USB port
on the left) while plugging the keypad in, by "Restart as USB drive" in the web
app, or when the keypad base doesn't answer (so a bare Pico never hides its
drive).
"""

import board
import busio
import microcontroller
import storage
import supervisor
import usb_cdc

DRIVE_FLAG = 0xD5  # same value as rgbkeypad.hardware.DRIVE_FLAG


def drive_mode():
    if microcontroller.nvm[0] == DRIVE_FLAG:
        microcontroller.nvm[0] = 0
        return True
    try:
        i2c = busio.I2C(board.GP5, board.GP4)
    except Exception:  # no pull-ups: the keypad base isn't attached
        return True
    try:
        while not i2c.try_lock():
            pass
        state = bytearray(2)
        i2c.writeto_then_readfrom(0x20, bytes((0,)), state)
        return not state[0] & 1  # key 0 reads low while held
    except OSError:
        return True
    finally:
        i2c.deinit()


supervisor.set_usb_identification(product="Pico RGB Keypad")
if drive_mode():
    # Maintenance: the drive plus the Python console (REPL) for debugging.
    usb_cdc.enable(console=True, data=True)
else:
    # One serial port only, so the browser's port picker has nothing to confuse.
    usb_cdc.enable(console=False, data=True)
    storage.disable_usb_drive()
    storage.remount("/", readonly=False)
