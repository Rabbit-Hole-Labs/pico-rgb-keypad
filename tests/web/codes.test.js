import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  KEYS, MEDIA, comboFromEvent, comboLabel, keyFromDomCode, keyShort,
} from '../../web/js/codes.js';

function pythonTable(name) {
  const src = readFileSync(new URL('../../firmware/lib/rgbkeypad/codes.py', import.meta.url), 'utf8');
  const body = new RegExp(`^${name} = \\{([\\s\\S]*?)^\\}`, 'm').exec(src)[1];
  return Object.fromEntries([...body.matchAll(/"(\w+)": (0x[0-9A-F]+)/g)].map((m) => [m[1], Number(m[2])]));
}

test('web key table matches the firmware', () => {
  assert.deepEqual(KEYS, pythonTable('KEYS'));
});

test('web media table matches the firmware', () => {
  assert.deepEqual(MEDIA, pythonTable('MEDIA'));
});

test('keyFromDomCode maps browser key codes', () => {
  assert.equal(keyFromDomCode('KeyQ'), 'Q');
  assert.equal(keyFromDomCode('Digit1'), 'ONE');
  assert.equal(keyFromDomCode('Digit0'), 'ZERO');
  assert.equal(keyFromDomCode('Numpad7'), 'KEYPAD_SEVEN');
  assert.equal(keyFromDomCode('F13'), 'F13');
  assert.equal(keyFromDomCode('F25'), null);
  assert.equal(keyFromDomCode('ArrowUp'), 'UP_ARROW');
  assert.equal(keyFromDomCode('MetaLeft'), 'LEFT_GUI');
  assert.equal(keyFromDomCode('Lang1'), null);
  for (const code of ['KeyA', 'Digit5', 'Space', 'Slash', 'NumpadEnter', 'IntlBackslash']) {
    assert.ok(KEYS[keyFromDomCode(code)] !== undefined, code);
  }
});

test('comboFromEvent records modifiers then the key', () => {
  const event = { metaKey: true, shiftKey: true, ctrlKey: false, altKey: false, code: 'KeyZ' };
  assert.deepEqual(comboFromEvent(event), ['LEFT_SHIFT', 'LEFT_GUI', 'Z']);
  assert.deepEqual(comboFromEvent({ ...event, code: 'ShiftLeft' }), ['LEFT_SHIFT', 'LEFT_GUI']);
});

test('comboLabel puts modifiers first in macOS order', () => {
  assert.equal(comboLabel(['Z', 'LEFT_GUI', 'LEFT_CONTROL']), '⌃⌘Z');
  assert.equal(comboLabel(['LEFT_GUI', 'SPACEBAR']), '⌘Space');
  assert.equal(comboLabel(['A', 'B']), 'A + B');
  assert.equal(keyShort('KEYPAD_SEVEN'), 'KP 7');
});
