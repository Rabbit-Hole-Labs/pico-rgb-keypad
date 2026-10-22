// Keypad config: the same validation rules as firmware/lib/rgbkeypad/config.py,
// so the web app can explain a problem before the keypad refuses it, plus the
// editing helpers the UI needs. tests/fixtures/config-cases.json runs against both.

import { KEYS, MEDIA, MEDIA_LABELS, comboLabel } from './codes.js';

export const NUM_KEYS = 16;
export const MAX_LAYERS = 8;
export const MAX_STEPS = 64;
export const MAX_TEXT = 1000;
export const MAX_DELAY_MS = 10000;
export const MAX_LABEL = 24;
export const MAX_COMBO = 8;
export const MAX_IDLE_S = 3600;
export const MAX_TYPE_DELAY_MS = 200;
export const LAYER_MODES = ['to', 'hold', 'next'];
export const BLINK_CHOICES = ['key', 'off']; // or a '#rrggbb' color
export const STEP_OPS = ['tap', 'down', 'up', 'text', 'media', 'delay'];
export const ROTATIONS = [0, 90, 180, 270];

export class ConfigError extends Error {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.path = path;
    this.detail = message;
  }
}

const fail = (where, message) => { throw new ConfigError(where, message); };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chars = (s) => [...s].length;

function int(value, where, lo, hi) {
  if (!Number.isInteger(value)) fail(where, 'must be a whole number');
  if (value < lo || value > hi) fail(where, `must be between ${lo} and ${hi}`);
  return value;
}

function str(value, where, maxLen, allowEmpty = true) {
  if (typeof value !== 'string') fail(where, 'must be text');
  if (chars(value) > maxLen) fail(where, `is longer than ${maxLen} characters`);
  if (!allowEmpty && !value) fail(where, 'must not be empty');
  return value;
}

/** First character a US keyboard layout can't type, or null. */
export function untypeable(text) {
  for (const ch of text) {
    const o = ch.codePointAt(0);
    if (!((o >= 32 && o <= 126) || ch === '\n' || ch === '\t')) return ch;
  }
  return null;
}

function typeable(value, where) {
  str(value, where, MAX_TEXT, false);
  const bad = untypeable(value);
  if (bad !== null) fail(where, `contains ${JSON.stringify(bad)}, which a US keyboard layout can't type`);
  return value;
}

function color(value, where) {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(where, 'must be a color like #ff8800');
  }
  return value.toLowerCase();
}

// What a key shows while its macro runs: 'key' blinks its own color, 'off'
// doesn't blink, and a color blinks that color.
function blink(value, where) {
  if (BLINK_CHOICES.includes(value)) return value;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    fail(where, 'must be "key", "off" or a color like #ff8800');
  }
  return value.toLowerCase();
}

function keyList(value, where, allowEmpty) {
  if (!Array.isArray(value)) fail(where, 'must be a list of key names');
  if (!value.length && !allowEmpty) fail(where, 'needs at least one key');
  if (value.length > MAX_COMBO) fail(where, `has more than ${MAX_COMBO} keys`);
  let regular = 0;
  for (const name of value) {
    if (!Object.hasOwn(KEYS, name)) fail(where, `unknown key ${JSON.stringify(name)}`);
    if (KEYS[name] < 0xe0) regular += 1;
  }
  if (regular > 6) fail(where, 'USB keyboards can only hold 6 non-modifier keys at once');
  return [...value];
}

function mediaCode(value, where) {
  if (!Object.hasOwn(MEDIA, value)) fail(where, `unknown media key ${JSON.stringify(value)}`);
  return value;
}

function step(s, where) {
  if (!isObject(s)) fail(where, 'must be an object');
  const { op } = s;
  if (!STEP_OPS.includes(op)) fail(`${where}.op`, `must be one of ${STEP_OPS.join(', ')}`);
  if (op === 'tap' || op === 'down') return { op, keys: keyList(s.keys, `${where}.keys`, false) };
  if (op === 'up') return { op, keys: keyList(s.keys ?? [], `${where}.keys`, true) };
  if (op === 'text') return { op, text: typeable(s.text, `${where}.text`) };
  if (op === 'media') return { op, code: mediaCode(s.code, `${where}.code`) };
  return { op, ms: int(s.ms, `${where}.ms`, 0, MAX_DELAY_MS) };
}

function action(a, where, layerCount) {
  if (a === null || a === undefined) return { type: 'none' };
  if (!isObject(a)) fail(where, 'must be an object');
  const type = a.type ?? 'none';
  if (type === 'none') return { type };
  if (type === 'keys') return { type, keys: keyList(a.keys, `${where}.keys`, false) };
  if (type === 'text') return { type, text: typeable(a.text, `${where}.text`) };
  if (type === 'media') return { type, code: mediaCode(a.code, `${where}.code`) };
  if (type === 'macro') {
    if (!Array.isArray(a.steps) || !a.steps.length) fail(`${where}.steps`, 'needs at least one step');
    if (a.steps.length > MAX_STEPS) fail(`${where}.steps`, `has more than ${MAX_STEPS} steps`);
    const steps = a.steps.map((s, i) => step(s, `${where}.steps[${i}]`));
    return { type, steps, blink: blink(a.blink ?? 'key', `${where}.blink`) };
  }
  if (type === 'layer') {
    if (!LAYER_MODES.includes(a.mode)) fail(`${where}.mode`, `must be one of ${LAYER_MODES.join(', ')}`);
    const layer = a.mode === 'next' ? 0 : int(a.layer, `${where}.layer`, 0, layerCount - 1);
    return { type, mode: a.mode, layer };
  }
  return fail(`${where}.type`, `unknown action type ${JSON.stringify(type)}`);
}

/** A clean copy of cfg, or throws ConfigError naming the bad field. */
export function normalize(cfg) {
  if (!isObject(cfg)) fail('config', 'must be an object');
  if ((cfg.version ?? 1) !== 1) fail('version', 'this firmware reads config version 1');
  const brightness = cfg.brightness ?? 0.4;
  if (typeof brightness !== 'number' || !(brightness >= 0 && brightness <= 1)) {
    fail('brightness', 'must be between 0 and 1');
  }
  const rotation = cfg.rotation ?? 0;
  if (!ROTATIONS.includes(rotation)) fail('rotation', 'must be 0, 90, 180 or 270');
  const { layers } = cfg;
  if (!Array.isArray(layers) || !layers.length) fail('layers', 'needs at least one layer');
  if (layers.length > MAX_LAYERS) fail('layers', `has more than ${MAX_LAYERS} layers`);
  const outLayers = layers.map((layer, li) => {
    const where = `layers[${li}]`;
    if (!isObject(layer)) fail(where, 'must be an object');
    if (!Array.isArray(layer.keys) || layer.keys.length !== NUM_KEYS) {
      fail(`${where}.keys`, `must list exactly ${NUM_KEYS} keys`);
    }
    const keys = layer.keys.map((key, ki) => {
      const kw = `${where}.keys[${ki}]`;
      if (!isObject(key)) fail(kw, 'must be an object');
      return {
        label: str(key.label ?? '', `${kw}.label`, MAX_LABEL),
        color: color(key.color ?? '#000000', `${kw}.color`),
        action: action(key.action, `${kw}.action`, layers.length),
      };
    });
    return { name: str(layer.name ?? `Layer ${li + 1}`, `${where}.name`, MAX_LABEL, false), keys };
  });
  return {
    version: 1,
    brightness,
    highlight: color(cfg.highlight ?? '#ffffff', 'highlight'),
    idle_timeout: int(cfg.idle_timeout ?? 0, 'idle_timeout', 0, MAX_IDLE_S),
    type_delay: int(cfg.type_delay ?? 0, 'type_delay', 0, MAX_TYPE_DELAY_MS),
    rotation,
    layers: outLayers,
  };
}

// The keypad parses a whole layout in RAM (about 90 KB free on a Pico). Measured on
// a Pico with CircuitPython 10.3, replacing a loaded layout with a same-size one (as
// live preview does): the worst shape, every key a one-step macro, worked at 13.6 KB
// and failed at 14.3 KB; long typed text worked up to 18 KB. The firmware refuses
// messages over 16 KB (MAX_LINE in firmware/lib/rgbkeypad/protocol.py).
export const MAX_CONFIG_BYTES = 12 * 1024;

export const configBytes = (cfg) => new TextEncoder().encode(JSON.stringify(cfg)).length;

/** {valid, config, error, bytes} without throwing; error carries .path for the UI. */
export function validate(cfg) {
  try {
    const config = normalize(cfg);
    const bytes = configBytes(config);
    if (bytes > MAX_CONFIG_BYTES) {
      throw new ConfigError('config', `The layout is ${(bytes / 1024).toFixed(1)} KB, more than the `
        + `${MAX_CONFIG_BYTES / 1024} KB the keypad has room for. Shorten long text or remove layers.`);
    }
    return { valid: true, config, error: null, bytes };
  } catch (error) {
    if (error instanceof ConfigError) return { valid: false, config: null, error, bytes: null };
    throw error;
  }
}

/** "layers[1].keys[3].action.text" -> {layer: 1, key: 3, field: "action.text"} */
export function parsePath(path) {
  const m = /^layers\[(\d+)\](?:\.keys\[(\d+)\])?\.?(.*)$/.exec(path || '');
  if (!m) return { layer: null, key: null, field: path };
  return { layer: Number(m[1]), key: m[2] === undefined ? null : Number(m[2]), field: m[3] };
}

// Editing helpers

export const blankKey = () => ({ label: '', color: '#000000', action: { type: 'none' } });
export const blankLayer = (name) => ({ name, keys: Array.from({ length: NUM_KEYS }, blankKey) });
export const blankConfig = () => ({
  version: 1, brightness: 0.4, highlight: '#ffffff', idle_timeout: 0, type_delay: 0,
  rotation: 0, layers: [blankLayer('Main')],
});

function remapLayerRefs(cfg, map) {
  for (const layer of cfg.layers) {
    for (const key of layer.keys) {
      const a = key.action;
      if (a && a.type === 'layer' && a.mode !== 'next') {
        const to = map(a.layer);
        if (to === null) key.action = { type: 'none' };
        else a.layer = to;
      }
    }
  }
}

/** Remove a layer; keys that switched to it lose their action, later targets shift down. */
export function removeLayer(cfg, index) {
  cfg.layers.splice(index, 1);
  remapLayerRefs(cfg, (l) => (l === index ? null : l > index ? l - 1 : l));
}

/** Move layer `from` to position `to`, keeping layer actions pointing at the same layers. */
export function moveLayer(cfg, from, to) {
  const [layer] = cfg.layers.splice(from, 1);
  cfg.layers.splice(to, 0, layer);
  // Apply the same move to the old indexes, then invert: newIndex[old] = new.
  const oldAt = cfg.layers.map((_, i) => i);
  oldAt.splice(to, 0, ...oldAt.splice(from, 1));
  const newIndex = [];
  oldAt.forEach((oldIndex, i) => { newIndex[oldIndex] = i; });
  remapLayerRefs(cfg, (l) => newIndex[l]);
}

/**
 * Layer navigation problems. The keypad starts on layer 0; "to" and "next" change
 * the base layer, "hold" only borrows a layer while held.
 * unreachable: no sequence of key presses gets there.
 * stuck: can become the base layer but has no key that switches base again,
 *        so the only way out is unplugging the keypad.
 */
export function layerWarnings(cfg) {
  const n = cfg.layers.length;
  const edges = (li, modes) => cfg.layers[li].keys.flatMap(({ action: a }) => {
    if (a?.type !== 'layer' || !modes.includes(a.mode)) return [];
    return [a.mode === 'next' ? (li + 1) % n : a.layer];
  }).filter((t) => t >= 0 && t < n);
  const walk = (starts, modes) => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length) {
      for (const t of edges(queue.shift(), modes)) {
        if (!seen.has(t)) { seen.add(t); queue.push(t); }
      }
    }
    return seen;
  };
  const base = walk([0], ['to', 'next']);
  const any = walk([...base], ['to', 'next', 'hold']);
  const unreachable = new Set();
  const stuck = new Set();
  for (let li = 0; li < n; li += 1) {
    if (!any.has(li)) unreachable.add(li);
    if (n > 1 && base.has(li) && !edges(li, ['to', 'next']).some((t) => t !== li)) stuck.add(li);
  }
  return { unreachable, stuck };
}

// Characters printed beside the keys on the keypad base, used as key names so a
// key on screen and on the desk have the same name. Key i is printed PRINTED[i]:
// with the USB port on the left they read 0123 / 4567 / 89AB / CDEF.
const PRINTED = '0123456789ABCDEF';
export const printedLabel = (index) => PRINTED[index];

/**
 * Key index shown at grid cell (x, y) when the keypad sits with its USB port
 * on the given side. rotation 0 = USB on the left, where key 0 is top-left and
 * the printed characters read upright; each step turns the keypad clockwise.
 */
export function cellToKey(x, y, rotation) {
  switch (rotation) {
    case 90: return (3 - x) * 4 + y; // USB at the top
    case 180: return (3 - y) * 4 + (3 - x); // USB on the right
    case 270: return x * 4 + (3 - y); // USB at the bottom
    default: return y * 4 + x;
  }
}

const quote = (text, max = 18) => {
  const flat = text.replace(/\n/g, '↵').replace(/\t/g, '⇥');
  return `“${chars(flat) > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat}”`;
};

/** One-line description of an action for tiles and lists. */
export function describeAction(a, layers = []) {
  if (!a || a.type === 'none') return '';
  const layerName = (i) => layers[i]?.name ?? `Layer ${i + 1}`;
  switch (a.type) {
    case 'keys': return a.keys?.length ? comboLabel(a.keys) : 'Shortcut';
    case 'text': return a.text ? `Type ${quote(a.text)}` : 'Type text';
    case 'media': return MEDIA_LABELS[a.code] ?? 'Media key';
    case 'macro': {
      const n = a.steps?.length ?? 0;
      return `Macro · ${n} step${n === 1 ? '' : 's'}`;
    }
    case 'layer':
      if (a.mode === 'next') return 'Next layer';
      return `${a.mode === 'hold' ? 'Hold for' : 'Go to'} ${layerName(a.layer)}`;
    default: return '';
  }
}

/** A sensible empty action of the given type, reusing what fits from the old one. */
export function actionOfType(type, previous = {}) {
  switch (type) {
    case 'keys': return { type, keys: previous.type === 'keys' ? previous.keys : [] };
    case 'text': return { type, text: previous.type === 'text' ? previous.text : '' };
    case 'media': return { type, code: previous.type === 'media' ? previous.code : 'PLAY_PAUSE' };
    case 'macro': {
      // Turning a shortcut or text into a macro keeps it as the first step.
      if (previous.type === 'macro') return { type, steps: previous.steps, blink: previous.blink ?? 'key' };
      if (previous.type === 'keys' && previous.keys?.length) return { type, steps: [{ op: 'tap', keys: previous.keys }], blink: 'key' };
      if (previous.type === 'text' && previous.text) return { type, steps: [{ op: 'text', text: previous.text }], blink: 'key' };
      return { type, steps: [], blink: 'key' };
    }
    case 'layer': return { type, mode: 'to', layer: 0 };
    default: return { type: 'none' };
  }
}
