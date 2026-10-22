"""Pimoroni Pico RGB Keypad Base: 16 keys on a TCA9555 and 16 APA102 LEDs.

Pins and framing follow Pimoroni's C driver (libraries/pico_rgb_keypad):
I2C0 on GP4/GP5 with the expander at 0x20, SPI0 on GP18/GP19 for the LEDs
with CS on GP17 held low only while a frame is written. Key i and LED i are
the same pad: index 0 is top-left with the Pico's USB port at the top, and
indexes run left to right, then top to bottom.
"""

import board
import busio
import digitalio
import microcontroller

NUM_KEYS = 16
EXPANDER = 0x20
DRIVE_FLAG = 0xD5  # in nvm[0]; boot.py shows the USB drive for one boot (keep in sync)


class Keypad:
    def __init__(self):
        self._i2c = busio.I2C(board.GP5, board.GP4, frequency=400000)
        while not self._i2c.try_lock():
            pass
        self._reg = bytes((0,))
        self._buf = bytearray(2)

    def read(self):
        """Bitmask of pressed keys; bit i is key i. The expander reads low when pressed."""
        self._i2c.writeto_then_readfrom(EXPANDER, self._reg, self._buf)
        return ~(self._buf[0] | (self._buf[1] << 8)) & 0xFFFF


class Leds:
    def __init__(self):
        self._spi = busio.SPI(board.GP18, MOSI=board.GP19)
        while not self._spi.try_lock():
            pass
        self._spi.configure(baudrate=4000000)
        self._cs = digitalio.DigitalInOut(board.GP17)
        self._cs.switch_to_output(value=True)
        # 4-byte start frame, 4 bytes per LED, 4-byte end frame.
        self._frame = bytearray(4 + NUM_KEYS * 4 + 4)

    def show(self, colors, level):
        """colors: 16 (r, g, b) tuples. level: APA102 global brightness, 0-31."""
        frame = self._frame
        head = 0xE0 | (level & 0x1F)
        offset = 4
        for r, g, b in colors:
            frame[offset] = head
            frame[offset + 1] = b
            frame[offset + 2] = g
            frame[offset + 3] = r
            offset += 4
        self._cs.value = False
        self._spi.write(frame)
        self._cs.value = True

    def fill(self, color, level):
        self.show([color] * NUM_KEYS, level)


def reboot(mode):
    """reload: restart code.py. normal: full reset. drive: reset with the USB drive
    shown. bootloader: reset into the UF2 bootloader to install CircuitPython."""
    import supervisor
    if mode == "reload":
        supervisor.reload()
    if mode == "drive":
        microcontroller.nvm[0] = DRIVE_FLAG
    elif mode == "bootloader":
        microcontroller.on_next_reset(microcontroller.RunMode.UF2)
    microcontroller.reset()
