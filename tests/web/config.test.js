import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ConfigError, blankConfig, blankLayer, cellToKey, describeAction, layerWarnings, moveLayer, normalize,
  parsePath, printedLabel, removeLayer, untypeable, validate,
} from '../../web/js/config.js';

const cases = JSON.parse(readFileSync(new URL('../fixtures/config-cases.json', import.meta.url)));

test('shared cases match the firmware validator', async (t) => {
  for (const c of cases) {
    await t.test(c.name, () => {
      if (c.error === null) {
        assert.deepEqual(normalize(c.config), c.normalized);
      } else {
        assert.throws(() => normalize(c.config), (error) => {
          assert.ok(error instanceof ConfigError);
          assert.equal(error.path, c.error);
          return true;
        });
      }
    });
  }
});

test('validate() refuses a layout too big for the keypad', () => {
  const cfg = blankConfig();
  for (const key of cfg.layers[0].keys) key.action = { type: 'text', text: 'x'.repeat(1000) };
  const result = validate(cfg);
  assert.equal(result.valid, false);
  assert.equal(result.error.path, 'config');
  assert.match(result.error.detail, /KB the keypad has room for/);
  assert.ok(validate(blankConfig()).bytes < 2048);
});

test('blank config is valid and validate() does not throw', () => {
  assert.equal(validate(blankConfig()).valid, true);
  const bad = validate({ layers: [] });
  assert.equal(bad.valid, false);
  assert.equal(bad.error.path, 'layers');
});

test('untypeable finds the first character a US layout cannot type', () => {
  assert.equal(untypeable('Hello\tthere\n'), null);
  assert.equal(untypeable('naïve'), 'ï');
  assert.equal(untypeable('ok 👍'), '👍');
});

test('parsePath splits a validation path', () => {
  assert.deepEqual(parsePath('layers[1].keys[3].action.text'), { layer: 1, key: 3, field: 'action.text' });
  assert.deepEqual(parsePath('layers[0].name'), { layer: 0, key: null, field: 'name' });
  assert.deepEqual(parsePath('brightness'), { layer: null, key: null, field: 'brightness' });
});

test('cellToKey matches the measured layout and each rotation', () => {
  // USB at the top: key 0 top-left, key 3 top-right, key 12 bottom-left.
  assert.equal(cellToKey(0, 0, 0), 0);
  assert.equal(cellToKey(3, 0, 0), 3);
  assert.equal(cellToKey(0, 3, 0), 12);
  // USB on the right (turned clockwise): key 0 is top-right, key 12 top-left.
  assert.equal(cellToKey(3, 0, 90), 0);
  assert.equal(cellToKey(0, 0, 90), 12);
  assert.equal(cellToKey(0, 0, 180), 15);
  assert.equal(cellToKey(0, 3, 270), 0);
  for (const r of [0, 90, 180, 270]) {
    const seen = new Set();
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) seen.add(cellToKey(x, y, r));
    assert.equal(seen.size, 16, `rotation ${r} covers every key once`);
  }
});

test('printedLabel names keys by the characters printed on the board', () => {
  // Checked on a real board: with the USB port on the left, 0 is top-left and 3 is
  // top-right; with it at the top, key index 0 is top-left, beside the printed C.
  assert.equal(printedLabel(3), '0');
  assert.equal(printedLabel(15), '3');
  assert.equal(printedLabel(5), '9');
  assert.equal(printedLabel(0), 'C');
  assert.equal(printedLabel(12), 'F');
  const rowsWithUsbLeft = [0, 1, 2, 3].map((y) => [0, 1, 2, 3].map((x) => printedLabel(cellToKey(x, y, 270))).join(''));
  assert.deepEqual(rowsWithUsbLeft, ['0123', '4567', '89AB', 'CDEF']);
});

function threeLayers() {
  const cfg = blankConfig();
  cfg.layers = [blankLayer('A'), blankLayer('B'), blankLayer('C')];
  cfg.layers[0].keys[0].action = { type: 'layer', mode: 'to', layer: 1 };
  cfg.layers[0].keys[1].action = { type: 'layer', mode: 'hold', layer: 2 };
  cfg.layers[2].keys[0].action = { type: 'layer', mode: 'to', layer: 0 };
  cfg.layers[1].keys[15].action = { type: 'layer', mode: 'next', layer: 0 };
  return cfg;
}

test('removeLayer clears actions aimed at it and shifts later targets', () => {
  const cfg = threeLayers();
  removeLayer(cfg, 1);
  assert.deepEqual(cfg.layers.map((l) => l.name), ['A', 'C']);
  assert.deepEqual(cfg.layers[0].keys[0].action, { type: 'none' });
  assert.equal(cfg.layers[0].keys[1].action.layer, 1);
  assert.equal(cfg.layers[1].keys[0].action.layer, 0);
  assert.equal(validate(cfg).valid, true);
});

test('moveLayer keeps actions pointing at the same layers', () => {
  const cfg = threeLayers();
  moveLayer(cfg, 2, 0); // C, A, B
  assert.deepEqual(cfg.layers.map((l) => l.name), ['C', 'A', 'B']);
  const a = cfg.layers[1];
  assert.equal(cfg.layers[a.keys[0].action.layer].name, 'B');
  assert.equal(cfg.layers[a.keys[1].action.layer].name, 'C');
  assert.equal(cfg.layers[cfg.layers[0].keys[0].action.layer].name, 'A');
  moveLayer(cfg, 0, 2); // back to A, B, C
  assert.deepEqual(cfg, threeLayers());
});

test('layerWarnings finds unreachable and dead-end layers', () => {
  const cfg = threeLayers();
  // A -> B via "to", A holds C, C -> A via "to", B cycles with "next" (to C).
  let w = layerWarnings(cfg);
  assert.deepEqual([...w.unreachable], []);
  assert.deepEqual([...w.stuck], []);
  cfg.layers[1].keys[15].action = { type: 'none' }; // B can no longer leave
  w = layerWarnings(cfg);
  assert.deepEqual([...w.stuck], [1]);
  cfg.layers[0].keys[1].action = { type: 'none' }; // nothing reaches C now
  w = layerWarnings(cfg);
  assert.deepEqual([...w.unreachable], [2]);
  const single = blankConfig();
  assert.deepEqual(layerWarnings(single), { unreachable: new Set(), stuck: new Set() });
});

test('describeAction', () => {
  const layers = [{ name: 'Main' }, { name: 'Numbers' }];
  assert.equal(describeAction({ type: 'none' }), '');
  assert.equal(describeAction({ type: 'keys', keys: ['LEFT_GUI', 'LEFT_SHIFT', 'Z'] }), '⇧⌘Z');
  assert.equal(describeAction({ type: 'text', text: 'Hello\nthere, this is long' }),
    'Type “Hello↵there, this…”');
  assert.equal(describeAction({ type: 'media', code: 'MUTE' }), 'Mute');
  assert.equal(describeAction({ type: 'macro', steps: [{}] }), 'Macro · 1 step');
  assert.equal(describeAction({ type: 'layer', mode: 'hold', layer: 1 }, layers), 'Hold for Numbers');
  assert.equal(describeAction({ type: 'layer', mode: 'next', layer: 0 }, layers), 'Next layer');
});
