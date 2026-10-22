"""Put firmware/lib on sys.path so the tests import rgbkeypad as the board does."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIRMWARE = os.path.join(ROOT, "firmware")
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
sys.path.insert(0, os.path.join(FIRMWARE, "lib"))
