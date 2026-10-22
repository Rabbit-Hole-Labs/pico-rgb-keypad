// The configurator UI. State lives in `state`; render*() functions rebuild parts
// of the page from it. Text inputs update state without re-rendering their own
// panel, so typing never loses focus.

import {
  KEY_GROUPS, KEY_LABELS, MEDIA_LIST, comboFromEvent, comboLabel, isModifier, modifierToggles,
  keyFromDomCode,
} from './codes.js';
import {
  MAX_CONFIG_BYTES, MAX_DELAY_MS, MAX_LABEL, MAX_LAYERS, MAX_STEPS, MAX_TEXT, MAX_TYPE_DELAY_MS,
  NUM_KEYS, actionOfType, blankConfig, blankLayer, cellToKey, configBytes, describeAction,
  layerWarnings, moveLayer, parsePath, printedLabel, removeLayer, untypeable, validate,
} from './config.js';
import { PORT_FILTERS, closeKeypad, openKeypad, serialSupported } from './device.js';
import { compareVersions, installFirmware, loadBundle } from './firmware.js';

const STORAGE_KEY = 'pico-rgb-keypad:draft';
const FIRMWARE_BASE = new URL('../../firmware/', import.meta.url);
const PREVIEW_DELAY_MS = 250;
const BOARD_NAMES = {
  raspberry_pi_pico: 'Raspberry Pi Pico (RP2040)',
  raspberry_pi_pico_w: 'Raspberry Pi Pico W (RP2040)',
  raspberry_pi_pico2: 'Raspberry Pi Pico 2 (RP2350)',
  raspberry_pi_pico2_w: 'Raspberry Pi Pico 2 W (RP2350)',
};
const SWATCHES = ['#ff3d6e', '#ff6a00', '#ffc400', '#3ddc84', '#00b39b', '#2f6bff', '#8b5cf6',
  '#ff4fd8', '#ffffff'];
const ACTION_TYPES = [['none', 'None'], ['keys', 'Shortcut'], ['text', 'Type text'],
  ['media', 'Media'], ['macro', 'Macro'], ['layer', 'Layer']];
const STEP_TYPES = [['tap', 'Press shortcut'], ['down', 'Hold keys down'], ['up', 'Release keys'],
  ['text', 'Type text'], ['media', 'Media key'], ['delay', 'Wait']];
const IDLE_CHOICES = [[0, 'Never'], [30, 'After 30 seconds'], [60, 'After 1 minute'],
  [300, 'After 5 minutes'], [900, 'After 15 minutes'], [1800, 'After 30 minutes'],
  [3600, 'After 1 hour']];
const ROTATION_CHOICES = [[0, 'Left'], [90, 'Top'], [180, 'Right'], [270, 'Bottom']];
const PLATFORM_CHOICES = [['mac', 'Mac'], ['windows', 'Windows']];
// Shortcut modifiers that get toggle buttons; other keys are picked from the list.
const TOGGLED = modifierToggles('mac').map((m) => m.name);
const detectPlatform = () => (/win/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '')
  ? 'windows' : 'mac');

const state = {
  config: blankConfig(),
  saved: null, // JSON of the config the keypad has saved
  previewed: null, // JSON of the config the keypad is currently running
  check: null, // validate(state.config), refreshed on every change
  layer: 0,
  key: 0,
  tab: 'key',
  conn: null,
  info: null, // the keypad's hello reply
  deviceLayer: null,
  pressed: new Set(),
  pick: false,
  connecting: false,
  userDisconnected: false, // clicked Disconnect: don't reconnect on our own until Connect
  restarting: false,
  notice: null,
  recording: null, // { id, apply, mods } while capturing a shortcut
  clipboard: null,
  bundle: null,
  bundleError: null,
  update: null,
};

// DOM helpers

const $ = (selector) => document.querySelector(selector);

/** h('button', {class: 'btn', onclick}, 'Label'). Props apply after children so a
 *  select's value can pick one of its options. Event props are on<event>. */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) {
      el.append(child instanceof Node ? child : String(child));
    }
  }
  for (const [name, value] of Object.entries(props || {})) {
    if (value === null || value === undefined) continue;
    if (value === false && !(name in el)) continue;
    if (name === 'class') el.className = value;
    else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
    else if (name in el && !name.includes('-')) el[name] = value;
    else el.setAttribute(name, value === true ? '' : value);
  }
  return el;
}

function toast(text, bad = false) {
  const el = h('div', { class: `toast${bad ? ' bad' : ''}`, role: bad ? 'alert' : 'status' }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3000);
}

const field = (label, ...body) => h('div', { class: 'field' }, h('div', { class: 'label' }, label), ...body);
const hint = (...text) => h('div', { class: 'hint' }, ...text);
const button = (label, onclick, props = {}) => h('button',
  { type: 'button', class: 'btn', onclick, ...props }, label);

function selectOf(options, value, onchange, props = {}) {
  return h('select', { onchange: (e) => onchange(e.target.value), value: String(value), ...props },
    options.map(([v, label]) => h('option', { value: String(v) }, label)));
}

function segmented(options, value, onpick, label) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label },
    options.map(([v, text]) => h('button', {
      type: 'button', 'aria-pressed': String(v === value), onclick: () => onpick(v),
    }, text)));
}

// Config state

const layerAt = (i = state.layer) => state.config.layers[i];
const keyAt = (i = state.key) => layerAt().keys[i];
const canTalk = () => Boolean(state.conn && state.info && !state.info.recovery);
const configJSON = () => (state.check.valid ? JSON.stringify(state.check.config) : null);
const isDirty = () => configJSON() !== state.saved;

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ config: state.config, saved: state.saved }));
  } catch { /* storage unavailable; the draft just won't survive a reload */ }
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (draft && Array.isArray(draft.config?.layers) && draft.config.layers.length) {
      state.config = draft.config;
      state.saved = typeof draft.saved === 'string' ? draft.saved : null;
      return true;
    }
  } catch { /* no usable draft */ }
  return false;
}

function clampSelection() {
  state.layer = Math.min(state.layer, state.config.layers.length - 1);
  state.key = Math.min(Math.max(state.key, 0), NUM_KEYS - 1);
}

/** Call after any edit. panel: also rebuild the editor (for structural edits). */
function changed({ panel = false } = {}) {
  state.check = validate(state.config);
  clampSelection();
  persist();
  schedulePreview();
  renderLayerTabs();
  renderPad();
  renderSaveBar();
  renderBanners();
  if (panel) renderPanel();
}

function describeError(error) {
  if (error.path === 'config') return error.detail;
  const { layer, key, field: path } = parsePath(error.path);
  const parts = [];
  if (layer !== null) parts.push(state.config.layers[layer]?.name || `Layer ${layer + 1}`);
  if (key !== null) parts.push(`key ${printedLabel(key)}`);
  const step = /steps\[(\d+)\]/.exec(path || '');
  if (step) parts.push(`macro step ${Number(step[1]) + 1}`);
  else if (path && !path.startsWith('action')) parts.push(path.replace(/_/g, ' '));
  return `${parts.join(' · ')}${parts.length ? ': ' : ''}${error.detail}`;
}

function showError(error) {
  const { layer, key, field: path } = parsePath(error.path);
  if (layer !== null) state.layer = layer;
  if (key !== null) {
    state.key = key;
    state.tab = 'key';
  } else if (path === 'name') {
    state.tab = 'layer';
  } else if (layer === null) {
    state.tab = 'settings';
  }
  renderAll();
}

// Talking to the keypad

let previewTimer = null;

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(sendPreview, PREVIEW_DELAY_MS);
}

async function sendPreview() {
  if (!canTalk() || !state.check.valid) return;
  const json = configJSON();
  if (json === state.previewed) return;
  try {
    await state.conn.call('set_config', { config: state.check.config, save: false }, 6000);
    state.previewed = json;
  } catch (error) {
    toast(`Preview failed: ${error.message}`, true);
  }
}

async function save() {
  if (!state.check.valid) {
    showError(state.check.error);
    return;
  }
  const json = configJSON();
  try {
    await state.conn.call('set_config', { config: state.check.config, save: true }, 8000);
    state.saved = json;
    state.previewed = json;
    state.config = JSON.parse(json);
    toast('Saved to the keypad');
  } catch (error) {
    if (error.reply?.applied) state.previewed = json;
    toast(error.message, true);
  }
  changed({ panel: true });
}

function revert() {
  if (state.saved === null) return;
  state.config = JSON.parse(state.saved);
  changed({ panel: true });
}

async function connectPort(port, { quiet = false } = {}) {
  if (state.conn || state.connecting) return false;
  state.connecting = true;
  renderTop();
  try {
    const { conn, hello } = await openKeypad(port);
    await attach(conn, hello);
    return true;
  } catch (error) {
    if (!quiet) toast(error.message, true);
    return false;
  } finally {
    state.connecting = false;
    renderAll();
  }
}

/** A port that just appeared may still be booting, so give it a few tries. */
async function connectSoon(port) {
  for (let attempt = 0; attempt < 6 && !state.conn && !state.userDisconnected; attempt += 1) {
    if (await connectPort(port, { quiet: true })) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function connectGranted() {
  if (!serialSupported()) return;
  for (const port of await navigator.serial.getPorts()) {
    if (await connectPort(port, { quiet: true })) return;
  }
}

async function onConnectButton() {
  if (state.conn) {
    await disconnect();
    return;
  }
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: PORT_FILTERS });
  } catch {
    return; // picker closed
  }
  state.userDisconnected = false;
  await connectPort(port);
}

async function disconnect() {
  const { conn } = state;
  if (!conn) return;
  state.userDisconnected = true;
  if (state.pick) await conn.call('set_paused', { paused: false }).catch(() => {});
  await closeKeypad(conn);
}

async function attach(conn, hello) {
  state.conn = conn;
  state.info = hello;
  state.deviceLayer = hello.layer ?? null;
  state.restarting = false;
  state.notice = null;
  conn.addEventListener('key', onKeyEvent);
  conn.addEventListener('layer', onLayerEvent);
  conn.addEventListener('error', (e) => toast(`Keypad: ${e.detail.message}`, true));
  conn.addEventListener('close', onClose);
  if (hello.recovery) return;
  const { config } = await conn.call('get_config');
  adoptKeypadConfig(config);
  if (state.pick) await conn.call('set_paused', { paused: true });
}

function adoptKeypadConfig(config) {
  // The keypad doesn't keep JSON keys in order, so compare in normalized form.
  const canonical = validate(config);
  if (canonical.valid) config = canonical.config;
  const keypadJSON = JSON.stringify(config);
  state.check = validate(state.config);
  const local = configJSON();
  const keepLocal = isDirty() && local !== keypadJSON && window.confirm(
    'You have unsaved changes from earlier.\n\n'
    + 'OK: keep them and preview them on the keypad (Save to make them permanent).\n'
    + 'Cancel: load the layout saved on the keypad instead.');
  state.saved = keypadJSON;
  state.previewed = keypadJSON;
  if (!keepLocal) {
    state.config = config;
    state.layer = state.deviceLayer ?? 0;
  }
  changed({ panel: true });
}

function onClose(event) {
  const conn = event.target;
  if (conn !== state.conn) return;
  state.conn = null;
  state.info = null;
  state.deviceLayer = null;
  state.pressed.clear();
  state.previewed = null;
  cancelRecording();
  if (!event.detail.expected) {
    closeKeypad(conn);
    if (state.restarting) state.notice = 'The keypad is restarting. It reconnects on its own.';
    else toast('Keypad disconnected', true);
  }
  renderAll();
}

function onKeyEvent(event) {
  const { key, down } = event.detail;
  if (down) state.pressed.add(key);
  else state.pressed.delete(key);
  if (down && state.pick) {
    if (state.deviceLayer !== null) state.layer = state.deviceLayer;
    state.key = key;
    state.tab = 'key';
    renderAll();
    return;
  }
  renderPad();
}

function onLayerEvent(event) {
  state.deviceLayer = event.detail.layer;
  if (state.deviceLayer < state.config.layers.length && state.layer !== state.deviceLayer) {
    state.layer = state.deviceLayer;
    renderPanel();
  }
  renderLayerTabs();
  renderPad();
}

async function setPick(on) {
  state.pick = on;
  if (canTalk()) {
    try {
      await state.conn.call('set_paused', { paused: on });
    } catch (error) {
      toast(error.message, true);
    }
  }
  renderSaveBar();
}

async function reboot(mode) {
  if (!state.conn) return;
  state.restarting = mode !== 'bootloader';
  try {
    await state.conn.call('reboot', { mode });
    if (mode === 'bootloader') {
      state.notice = 'The keypad is in bootloader mode. Drag a CircuitPython .uf2 onto the drive that '
        + 'appeared, or unplug and replug the keypad to cancel.';
    }
  } catch (error) {
    state.restarting = false;
    toast(error.message, true);
  }
  renderAll();
}

// Shortcut recording

function startRecording(id, apply) {
  if (state.recording?.id === id) {
    cancelRecording();
    renderPanel();
    return;
  }
  state.recording = { id, apply, mods: [] };
  renderPanel();
}

function cancelRecording() {
  state.recording = null;
}

function finishRecording(keys) {
  const { apply } = state.recording;
  state.recording = null;
  if (keys.length) apply(keys);
  else renderPanel();
}

window.addEventListener('keydown', (event) => {
  if (!state.recording) return;
  event.preventDefault();
  event.stopPropagation();
  const key = keyFromDomCode(event.code);
  if (key && !isModifier(key)) finishRecording(comboFromEvent(event));
  else state.recording.mods = comboFromEvent(event);
}, true);

window.addEventListener('keyup', (event) => {
  if (!state.recording) return;
  event.preventDefault();
  // Releasing a lone modifier records just the modifiers (a key that holds Shift, say).
  const key = keyFromDomCode(event.code);
  if (key && isModifier(key) && state.recording.mods.length) finishRecording(state.recording.mods);
}, true);

window.addEventListener('blur', () => {
  if (state.recording) {
    cancelRecording();
    renderPanel();
  }
});

// Rendering

function renderAll() {
  state.check = validate(state.config);
  clampSelection();
  renderTop();
  renderBanners();
  renderLayerTabs();
  renderPad();
  renderSaveBar();
  renderTabs();
  renderPanel();
}

function renderTop() {
  const status = $('#status');
  const btn = $('#connect');
  const { info } = state;
  let text = 'Not connected';
  let mode = 'off';
  if (!serialSupported()) {
    text = 'Web Serial unavailable';
    mode = 'bad';
  } else if (state.connecting) {
    text = 'Connecting…';
    mode = 'busy';
  } else if (state.conn && info?.recovery) {
    text = 'Connected · firmware error';
    mode = 'bad';
  } else if (state.conn) {
    const board = BOARD_NAMES[info.board]?.replace(/ \(.*\)/, '') ?? info.board;
    text = `${board} · firmware ${info.fw}${info.writable ? '' : ' · USB drive mode'}`;
    mode = info.writable ? 'on' : 'busy';
  } else if (state.restarting) {
    text = 'Restarting…';
    mode = 'busy';
  }
  status.textContent = text;
  status.dataset.state = mode;
  btn.textContent = state.conn ? 'Disconnect' : 'Connect keypad';
  btn.classList.toggle('primary', !state.conn);
  btn.disabled = !serialSupported() || state.connecting;
}

function banner(kind, text, ...actions) {
  return h('div', { class: `banner ${kind}` }, h('div', {}, text), actions.length ? h('div', { class: 'row' }, actions) : null);
}

function renderBanners() {
  const list = [];
  const { info } = state;
  if (!serialSupported()) {
    list.push(banner('danger', 'This browser can’t talk to USB serial devices. Open this page in '
      + 'Chrome or Edge on a desktop computer.'));
  }
  if (location.protocol === 'file:') {
    list.push(banner('warn', 'This page was opened as a file, so it can’t load firmware updates. '
      + 'Run “npm run serve” in the project folder and open http://localhost:8000/web/ instead.'));
  }
  if (state.notice) list.push(banner('info', state.notice));
  if (state.conn && info?.recovery) {
    list.push(banner('danger', `The keypad’s firmware failed to start: ${info.recovery}. Reinstall the `
      + 'firmware to repair it.', button('Open Firmware tab', () => { state.tab = 'firmware'; renderAll(); })));
  }
  if (state.conn && info && info.writable === false) {
    list.push(banner('warn', 'USB drive mode: the CIRCUITPY drive is open on your computer, so the keypad '
      + 'can’t save changes or install updates. Edits still preview live.',
    button('Restart normally', () => reboot('normal'))));
  }
  if (state.conn && info?.config_error) {
    list.push(banner('warn', `${info.config_error}. The keypad is running its starter layout until you save.`));
  }
  if (canTalk() && state.bundle && info.writable
      && compareVersions(state.bundle.version, info.fw) > 0) {
    list.push(banner('info', `Firmware ${state.bundle.version} is available. The keypad has ${info.fw}.`,
      button('Update', () => { state.tab = 'firmware'; renderAll(); })));
  }
  $('#banners').replaceChildren(...list);
}

function renderLayerTabs() {
  const tabs = state.config.layers.map((layer, i) => h('button', {
    type: 'button',
    class: 'layer-tab',
    role: 'tab',
    'aria-selected': String(i === state.layer),
    title: i === state.deviceLayer ? 'The keypad is on this layer' : undefined,
    onclick: () => {
      state.layer = i;
      renderAll();
    },
  }, i === state.deviceLayer ? h('span', { class: 'live', 'aria-label': 'active on keypad' }) : null, layer.name || `Layer ${i + 1}`));
  if (state.config.layers.length < MAX_LAYERS) {
    tabs.push(h('button', { type: 'button', class: 'layer-tab add', onclick: addLayer, title: 'Add a layer' }, '+ Layer'));
  }
  $('#layer-tabs').replaceChildren(...tabs);
}

function renderPad() {
  const layer = layerAt();
  const rotation = state.config.rotation ?? 0;
  const bad = state.check.valid ? null : parsePath(state.check.error.path);
  const live = state.deviceLayer === null || state.deviceLayer === state.layer;
  const cells = [];
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const i = cellToKey(x, y, rotation);
      const key = layer.keys[i];
      const color = /^#[0-9a-f]{6}$/i.test(key.color) ? key.color : '#000000';
      const lit = color.toLowerCase() !== '#000000';
      const classes = ['key'];
      if (lit) classes.push('lit');
      if (i === state.key) classes.push('selected');
      if (live && state.pressed.has(i)) classes.push('down');
      if (bad && bad.layer === state.layer && bad.key === i) classes.push('invalid');
      const desc = describeAction(key.action, state.config.layers, state.config.platform);
      cells.push(h('button', {
        type: 'button',
        class: classes.join(' '),
        style: `--led: ${color}`,
        'aria-label': `Key ${printedLabel(i)}${key.label ? `, ${key.label}` : ''}${desc ? `, ${desc}` : ''}`,
        'aria-pressed': String(i === state.key),
        onclick: () => {
          cancelRecording();
          state.key = i;
          state.tab = 'key';
          renderPad();
          renderTabs();
          renderPanel();
        },
      },
      h('span', { class: 'key-num', 'aria-hidden': 'true', title: 'Printed on the keypad' }, printedLabel(i)),
      key.label ? h('span', { class: 'key-label' }, key.label) : null,
      desc ? h('span', { class: 'key-desc' }, desc) : null));
    }
  }
  $('#pad').replaceChildren(...cells);
}

function renderSaveBar() {
  const dirty = isDirty();
  const stateEl = $('#save-state');
  let text;
  if (state.conn && state.info?.recovery) text = 'Firmware needs repair';
  else if (!state.conn) text = dirty ? 'Unsaved changes · connect to save' : 'Not connected';
  else if (dirty) text = state.check.valid ? 'Unsaved · previewing on keypad' : 'Unsaved changes';
  else text = 'Saved on keypad';
  stateEl.textContent = text;
  stateEl.classList.toggle('dirty', dirty && Boolean(state.conn));
  $('#save').disabled = !canTalk() || !dirty || state.info?.writable === false;
  $('#revert').disabled = !dirty || state.saved === null;
  const pick = $('#pick');
  pick.checked = state.pick;
  pick.disabled = !canTalk();
  pick.closest('label').classList.toggle('disabled', !canTalk());
  const message = $('#validation');
  message.hidden = state.check.valid;
  if (!state.check.valid) message.textContent = describeError(state.check.error);
}

function renderTabs() {
  for (const tab of document.querySelectorAll('.tabs [data-tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
  }
}

function renderPanel() {
  const panels = { key: keyPanel, layer: layerPanel, settings: settingsPanel, firmware: firmwarePanel };
  $('#panel-body').replaceChildren(panels[state.tab]());
}

// Key panel

function positionText(i) {
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      if (cellToKey(x, y, state.config.rotation ?? 0) === i) return `row ${y + 1}, column ${x + 1}`;
    }
  }
  return '';
}

function keyPanel() {
  const key = keyAt();
  const action = key.action ?? { type: 'none' };
  const colorInput = h('input', {
    type: 'color',
    value: /^#[0-9a-f]{6}$/i.test(key.color) ? key.color : '#000000',
    'aria-label': 'Key color',
    oninput: (e) => {
      key.color = e.target.value;
      changed();
    },
    onchange: () => renderPanel(),
  });
  const swatches = h('div', { class: 'swatches' }, colorInput,
    SWATCHES.map((c) => h('button', {
      type: 'button',
      class: 'swatch',
      style: `background: ${c}`,
      title: c,
      'aria-label': `Color ${c}`,
      'aria-pressed': String(key.color === c),
      onclick: () => { key.color = c; changed({ panel: true }); },
    })),
    h('button', {
      type: 'button',
      class: 'swatch off',
      title: 'LED off',
      'aria-label': 'LED off',
      'aria-pressed': String(key.color === '#000000'),
      onclick: () => { key.color = '#000000'; changed({ panel: true }); },
    }));

  return h('div', {},
    h('div', { class: 'panel-head' },
      h('div', {},
        h('h2', {}, `Key ${printedLabel(state.key)}`),
        hint(`${layerAt().name} layer · ${positionText(state.key)} with the USB port at the `
          + `${ROTATION_CHOICES.find(([r]) => r === (state.config.rotation ?? 0))[1].toLowerCase()}`)),
      h('div', { class: 'row' },
        button('Blink on keypad', () => state.conn.call('identify', { key: state.key }).catch((e) => toast(e.message, true)),
          { class: 'btn small', disabled: !canTalk(), title: 'Flash this key so you can find it' }),
        button('Copy', () => { state.clipboard = structuredClone(key); renderPanel(); }, { class: 'btn small' }),
        button('Paste', () => {
          layerAt().keys[state.key] = structuredClone(state.clipboard);
          changed({ panel: true });
        }, { class: 'btn small', disabled: !state.clipboard }),
        button('Clear', () => {
          layerAt().keys[state.key] = { label: '', color: '#000000', action: { type: 'none' } };
          changed({ panel: true });
        }, { class: 'btn small danger' }))),
    field('Label',
      h('input', {
        type: 'text',
        value: key.label ?? '',
        maxLength: MAX_LABEL,
        placeholder: 'e.g. Copy',
        'aria-label': 'Label',
        oninput: (e) => { key.label = e.target.value; changed(); },
      }),
      hint('Shown on this page only. The keypad itself has no display.')),
    field('Color', swatches),
    field('When pressed',
      segmented(ACTION_TYPES, action.type, (type) => {
        cancelRecording();
        key.action = actionOfType(type, action);
        if (type === 'layer' && state.config.layers.length > 1) {
          key.action.layer = state.layer === 0 ? 1 : 0;
        }
        changed({ panel: true });
      }, 'Action type'),
      actionEditor(key, action)));
}

function actionEditor(key, action) {
  switch (action.type) {
    case 'keys':
      return h('div', { class: 'editor' },
        field('Shortcut', comboEditor('action', action.keys, (keys) => {
          action.keys = keys;
          changed({ panel: true });
        })),
        hint('The keys stay down for as long as you hold the keypad key. '
          + (state.config.platform === 'windows'
            ? 'Some shortcuts (Alt+Tab, Ctrl+W, anything with Win) are taken by Windows or the browser '
            : 'Some shortcuts (⌘Tab, ⌘Space, ⌘W) are taken by macOS or the browser ')
          + 'before Record sees them, so pick those from the list instead.'));
    case 'text':
      return h('div', { class: 'editor' }, textField(action, 'text', 5));
    case 'media':
      return h('div', { class: 'editor' },
        field('Media key', selectOf(MEDIA_LIST.map(([n, , label]) => [n, label]), action.code, (code) => {
          action.code = code;
          changed();
        })));
    case 'macro':
      return h('div', { class: 'editor' }, macroEditor(action));
    case 'layer':
      return h('div', { class: 'editor' }, layerActionEditor(action));
    default:
      return h('div', { class: 'editor' }, hint('This key does nothing. It still lights up when pressed.'));
  }
}

/** Text area with a live count and a warning for characters a US layout can't type. */
function textField(target, prop, rows) {
  const status = h('div', { class: 'hint' });
  const update = () => {
    const text = target[prop] ?? '';
    const bad = untypeable(text);
    status.className = bad ? 'error-text' : 'hint';
    status.textContent = bad
      ? `“${bad}” can’t be typed with a US keyboard layout. Use plain ASCII, Return and Tab.`
      : `${[...text].length} / ${MAX_TEXT} · typed with a US keyboard layout; Return and Tab work`;
  };
  update();
  return h('div', { class: 'field' },
    h('textarea', {
      rows,
      value: target[prop] ?? '',
      maxLength: MAX_TEXT,
      placeholder: 'Text to type',
      spellcheck: false,
      oninput: (e) => {
        target[prop] = e.target.value;
        update();
        changed();
      },
    }),
    status);
}

function keyOptions(placeholder) {
  const groups = KEY_GROUPS.map(([label, keys]) => h('optgroup', { label },
    keys.filter(([name]) => !TOGGLED.includes(name))
      .map(([name, , text]) => h('option', { value: name }, text))));
  return [h('option', { value: '' }, placeholder), ...groups];
}

/** Modifier toggles, chips for the other keys, a key picker and Record. */
function comboEditor(id, keys, apply, { allowEmpty = false } = {}) {
  const set = (next) => apply(next);
  const recording = state.recording?.id === id;
  const platform = state.config.platform;
  const others = keys.filter((k) => !TOGGLED.includes(k));
  const mods = modifierToggles(platform).map((m) => h('button', {
    type: 'button',
    class: 'btn small',
    'aria-pressed': String(keys.includes(m.name)),
    onclick: () => set(keys.includes(m.name) ? keys.filter((k) => k !== m.name) : [...keys, m.name]),
  }, m.text));
  const chips = others.map((k) => h('span', { class: 'chip' }, KEY_LABELS[k] ?? k,
    h('button', { type: 'button', 'aria-label': `Remove ${KEY_LABELS[k] ?? k}`, onclick: () => set(keys.filter((x) => x !== k)) }, '×')));
  const picker = h('select', {
    'aria-label': 'Add a key',
    onchange: (e) => { if (e.target.value) set([...keys, e.target.value]); },
  }, keyOptions(others.length ? 'Add another key…' : 'Choose a key…'));
  const record = h('button', {
    type: 'button',
    class: `btn small${recording ? ' recording' : ''}`,
    onclick: () => startRecording(id, set),
  }, recording ? 'Press the shortcut… (click to cancel)' : '● Record');
  const summary = keys.length
    ? h('span', { class: 'combo-preview', title: keys.join(' + ') }, comboLabel(keys, platform))
    : h('span', { class: 'hint' }, allowEmpty ? 'No keys: releases everything this macro is holding.' : 'No keys yet.');
  return h('div', { class: 'step-body' },
    h('div', { class: 'row' }, mods),
    h('div', { class: 'combo' }, chips, picker, record),
    h('div', { class: 'row' }, summary));
}

function newStep(op, old = {}) {
  switch (op) {
    case 'tap':
    case 'down':
      return { op, keys: old.keys ?? [] };
    case 'up': return { op, keys: [] };
    case 'text': return { op, text: '' };
    case 'media': return { op, code: 'PLAY_PAUSE' };
    default: return { op: 'delay', ms: 100 };
  }
}

function macroEditor(action) {
  const bad = state.check.valid ? null : state.check.error.path;
  const prefix = `layers[${state.layer}].keys[${state.key}].action.steps[`;
  const steps = action.steps.map((step, i) => {
    const invalid = bad?.startsWith(`${prefix}${i}]`);
    const move = (to) => {
      action.steps.splice(to, 0, ...action.steps.splice(i, 1));
      changed({ panel: true });
    };
    let body;
    if (step.op === 'tap' || step.op === 'down' || step.op === 'up') {
      body = comboEditor(`step-${i}`, step.keys ?? [], (keys) => {
        step.keys = keys;
        changed({ panel: true });
      }, { allowEmpty: step.op === 'up' });
    } else if (step.op === 'text') {
      body = textField(step, 'text', 2);
    } else if (step.op === 'media') {
      body = selectOf(MEDIA_LIST.map(([n, , label]) => [n, label]), step.code, (code) => {
        step.code = code;
        changed();
      });
    } else {
      body = h('div', { class: 'row' },
        h('input', {
          type: 'number', min: 0, max: MAX_DELAY_MS, step: 10, value: step.ms, style: 'width: 110px',
          'aria-label': 'Milliseconds to wait',
          oninput: (e) => { step.ms = e.target.value === '' ? NaN : Number(e.target.value); changed(); },
        }), h('span', { class: 'hint' }, 'milliseconds'));
    }
    return h('li', { class: `step${invalid ? ' invalid' : ''}` },
      h('span', { class: 'step-num' }, i + 1),
      h('div', { class: 'step-body' },
        selectOf(STEP_TYPES, step.op, (op) => {
          action.steps[i] = newStep(op, step);
          changed({ panel: true });
        }, { 'aria-label': `Step ${i + 1} type` }),
        body),
      h('div', { class: 'step-tools' },
        button('↑', () => move(i - 1), { class: 'btn small', disabled: i === 0, 'aria-label': 'Move up' }),
        button('↓', () => move(i + 1), { class: 'btn small', disabled: i === action.steps.length - 1, 'aria-label': 'Move down' }),
        button('×', () => { action.steps.splice(i, 1); changed({ panel: true }); }, { class: 'btn small', 'aria-label': 'Remove step' })));
  });
  const add = (op) => {
    if (action.steps.length >= MAX_STEPS) return;
    action.steps.push(newStep(op));
    changed({ panel: true });
  };
  return h('div', {},
    action.steps.length ? h('ol', { class: 'steps' }, steps) : h('p', { class: 'hint' }, 'Add the first step.'),
    h('div', { class: 'row', style: 'margin-top: 10px' },
      button('+ Shortcut', () => add('tap'), { class: 'btn small' }),
      button('+ Text', () => add('text'), { class: 'btn small' }),
      button('+ Wait', () => add('delay'), { class: 'btn small' }),
      button('+ Media key', () => add('media'), { class: 'btn small' }),
      button('+ Hold / release', () => add('down'), { class: 'btn small' })),
    h('p', { class: 'hint', style: 'margin-top: 10px' },
      'Steps run in order each time the key is pressed. Keys still held down when the macro ends are released.'),
    blinkField(action));
}

/** What the key shows while its macro runs: its own color, a chosen color, or nothing. */
function blinkField(action) {
  const blink = action.blink ?? 'key';
  const mode = blink === 'key' || blink === 'off' ? blink : 'color';
  return h('div', { class: 'field', style: 'margin-top: 14px' },
    h('div', { class: 'label' }, 'While it runs'),
    segmented([['key', 'Blink its color'], ['color', 'Blink another color'], ['off', 'Don’t blink']], mode, (next) => {
      action.blink = next === 'color' ? (mode === 'color' ? blink : '#ff3d6e') : next;
      changed({ panel: true });
    }, 'While the macro runs'),
    mode === 'color' ? h('div', { class: 'swatches' },
      h('input', {
        type: 'color', value: blink, 'aria-label': 'Blink color',
        oninput: (e) => { action.blink = e.target.value; changed(); },
      }),
      SWATCHES.map((c) => h('button', {
        type: 'button', class: 'swatch', style: `background: ${c}`, title: c, 'aria-label': `Blink ${c}`,
        'aria-pressed': String(blink === c),
        onclick: () => { action.blink = c; changed({ panel: true }); },
      }))) : null,
    hint(mode === 'off' ? 'The key shows its usual color while the macro runs.'
      : 'The key blinks until the macro finishes, so you can tell it’s still running.'));
}

function layerActionEditor(action) {
  const layers = state.config.layers;
  const modeHints = {
    to: 'Switches the keypad to that layer until a key switches it again.',
    hold: 'Uses that layer only while this key is held, then goes back.',
    next: 'Moves to the next layer, wrapping around after the last one.',
  };
  return h('div', {},
    field('Mode', segmented([['to', 'Go to layer'], ['hold', 'Hold for layer'], ['next', 'Next layer']],
      action.mode, (mode) => {
        action.mode = mode;
        if (mode === 'next') action.layer = 0;
        changed({ panel: true });
      }, 'Layer mode'), hint(modeHints[action.mode] ?? '')),
    action.mode === 'next' ? null : field('Layer',
      selectOf(layers.map((l, i) => [i, l.name || `Layer ${i + 1}`]), action.layer, (v) => {
        action.layer = Number(v);
        changed();
      })),
    layers.length === 1 ? hint('There’s only one layer so far. Add another with “+ Layer” above the keypad.') : null);
}

// Layer panel

function addLayer() {
  if (state.config.layers.length >= MAX_LAYERS) return;
  state.config.layers.push(blankLayer(`Layer ${state.config.layers.length + 1}`));
  state.layer = state.config.layers.length - 1;
  state.tab = 'layer';
  changed({ panel: true });
  renderTabs();
}

function layerPanel() {
  const layers = state.config.layers;
  const i = state.layer;
  const layer = layerAt();
  const warnings = layerWarnings(state.config);
  const assigned = layer.keys.filter((k) => k.action && k.action.type !== 'none').length;
  const move = (to) => {
    moveLayer(state.config, i, to);
    state.layer = to;
    changed({ panel: true });
  };
  return h('div', {},
    h('div', { class: 'panel-head' },
      h('div', {}, h('h2', {}, `Layer ${i + 1} of ${layers.length}`),
        hint(`${assigned} of ${NUM_KEYS} keys do something${i === 0 ? ' · the keypad starts on this layer' : ''}`))),
    field('Name', h('input', {
      type: 'text', value: layer.name, maxLength: MAX_LABEL, 'aria-label': 'Layer name',
      oninput: (e) => { layer.name = e.target.value; changed(); },
    })),
    warnings.stuck.has(i) ? h('p', { class: 'banner warn' }, 'Once the keypad switches to this layer it can’t '
      + 'leave: no key here switches layers. Give one key a Layer action, such as Next layer.') : null,
    warnings.unreachable.has(i) ? h('p', { class: 'banner warn' }, 'No key switches to this layer yet, so you '
      + 'can’t reach it from the keypad. Add a Layer action on another layer.') : null,
    h('h3', {}, 'Arrange'),
    h('div', { class: 'row' },
      button('← Move left', () => move(i - 1), { disabled: i === 0 }),
      button('Move right →', () => move(i + 1), { disabled: i === layers.length - 1 }),
      button('Duplicate', () => {
        const copy = structuredClone(layer);
        copy.name = `${layer.name} copy`.slice(0, MAX_LABEL);
        layers.splice(i + 1, 0, copy);
        state.layer = i + 1;
        changed({ panel: true });
      }, { disabled: layers.length >= MAX_LAYERS }),
      button('Add blank layer', addLayer, { disabled: layers.length >= MAX_LAYERS }),
      button('Delete layer', () => {
        if (!window.confirm(`Delete the “${layer.name}” layer? Keys that switch to it will be cleared.`)) return;
        removeLayer(state.config, i);
        state.layer = Math.max(0, i - 1);
        changed({ panel: true });
      }, { class: 'btn danger', disabled: layers.length === 1 })),
    h('p', { class: 'hint', style: 'margin-top: 12px' },
      `Up to ${MAX_LAYERS} layers. To move between layers, give a key a Layer action on every layer you can `
      + 'switch to, or use “Hold for layer” for a function-key style layer.'));
}

// Settings panel

function downloadJSON(data, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function settingsPanel() {
  const cfg = state.config;
  const pct = Math.round((cfg.brightness ?? 0.4) * 100);
  const pctLabel = h('span', { class: 'hint' }, `${pct}%`);
  return h('div', {},
    field('LED brightness',
      h('div', { class: 'row' },
        h('input', {
          type: 'range', min: 0, max: 100, step: 1, value: pct, class: 'grow', 'aria-label': 'LED brightness',
          oninput: (e) => {
            cfg.brightness = Number(e.target.value) / 100;
            pctLabel.textContent = `${e.target.value}%`;
            changed();
          },
        }), pctLabel)),
    field('Pressed key color',
      h('div', { class: 'row' },
        h('input', {
          type: 'color', value: cfg.highlight ?? '#ffffff', 'aria-label': 'Pressed key color',
          oninput: (e) => { cfg.highlight = e.target.value; changed(); },
        }),
        hint('A key shows this color while it’s held down.'))),
    field('Turn the LEDs off when idle',
      selectOf(IDLE_CHOICES, cfg.idle_timeout ?? 0, (v) => { cfg.idle_timeout = Number(v); changed(); })),
    field('Pause between typed characters',
      h('div', { class: 'row' },
        h('input', {
          type: 'number', min: 0, max: MAX_TYPE_DELAY_MS, step: 5, value: cfg.type_delay ?? 0, style: 'width: 100px',
          oninput: (e) => { cfg.type_delay = e.target.value === '' ? NaN : Number(e.target.value); changed(); },
        }), h('span', { class: 'hint' }, 'ms · raise this if an app drops letters from typed text'))),
    field('Your computer',
      segmented(PLATFORM_CHOICES, cfg.platform ?? 'mac', (p) => { cfg.platform = p; changed({ panel: true }); }, 'Your computer'),
      hint('Shows shortcuts the way your computer names them (⌘ and ⌥ on a Mac, Win and Alt on '
        + 'Windows) and picks the matching starter layout. Shortcuts you’ve set aren’t converted: '
        + 'the keypad sends the same keys either way, so ⌘C shows as Win+C.')),
    field('USB port position',
      segmented(ROTATION_CHOICES, cfg.rotation ?? 0, (r) => { cfg.rotation = r; changed({ panel: true }); }, 'USB port position'),
      hint('Turn the on-screen keypad to match how yours sits on the desk.')),
    field('Layout size', h('div', { class: 'progress', title: 'How much of the keypad’s room for a layout this uses' },
      h('div', { style: `width: ${Math.min(100, Math.round(((state.check.bytes ?? configBytes(cfg)) / MAX_CONFIG_BYTES) * 100))}%` })),
    hint(`${((state.check.bytes ?? configBytes(cfg)) / 1024).toFixed(1)} KB of ${MAX_CONFIG_BYTES / 1024} KB. `
      + 'Long typed text takes the most room.')),
    h('h3', {}, 'Backup'),
    h('div', { class: 'row' },
      button('Export config…', () => downloadJSON(state.check.valid ? state.check.config : cfg, 'keypad-config.json')),
      button('Import config…', () => $('#import-file').click()),
      button('Load starter layout', async () => {
        if (!window.confirm('Replace every layer with the starter layout? You can Revert until you save.')) return;
        try {
          const { config } = await state.conn.call('get_default_config', { platform: cfg.platform ?? 'mac' });
          state.config = config;
          state.layer = 0;
          changed({ panel: true });
        } catch (error) {
          toast(error.message, true);
        }
      }, { disabled: !canTalk(), title: canTalk() ? undefined : 'Connect the keypad first' }),
      button('Start blank', () => {
        if (!window.confirm('Clear every key and layer? You can Revert until you save.')) return;
        state.config = {
          ...blankConfig(), brightness: cfg.brightness, highlight: cfg.highlight, rotation: cfg.rotation, platform: cfg.platform,
        };
        state.layer = 0;
        changed({ panel: true });
      })),
    hint('Exported files can be imported here later, or onto another keypad.'));
}

async function importFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file isn’t JSON.', true);
    return;
  }
  const result = validate(data);
  if (!result.valid) {
    toast(`That file isn’t a usable keypad config: ${result.error.message}`, true);
    return;
  }
  state.config = result.config;
  state.layer = 0;
  state.key = 0;
  changed({ panel: true });
  toast(state.conn ? 'Imported and previewing on the keypad. Save to keep it.' : 'Imported. Connect the keypad to save it.');
}

// Firmware panel

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

async function updateFirmware() {
  state.update = { text: 'Loading firmware files…', sent: 0, total: 0 };
  renderPanel();
  try {
    const bundle = state.bundle ?? await loadBundle(FIRMWARE_BASE);
    state.bundle = bundle;
    const result = await installFirmware(state.conn, bundle, ({ sent, total, file }) => {
      state.update = { text: file ? `Uploading ${file}…` : 'Comparing files with the keypad…', sent, total };
      renderPanel();
    });
    if (!result.updated.length) {
      state.update = { done: true, text: 'The keypad already has these files. Nothing changed.' };
      renderPanel();
      return;
    }
    state.update = {
      done: true,
      text: `Installed ${result.updated.length} file${result.updated.length === 1 ? '' : 's'} `
        + `(${result.unchanged} already current). Restarting the keypad…`,
    };
    await reboot('normal');
  } catch (error) {
    state.update = { error: `Update failed: ${error.message}. The keypad keeps the firmware it had.` };
    renderPanel();
  }
}

function firmwarePanel() {
  const { info, bundle } = state;
  const parts = [];
  if (!state.conn || !info) {
    parts.push(h('p', { class: 'empty' }, 'Connect the keypad to see and update its firmware.'));
  } else {
    const newer = bundle && info.fw ? compareVersions(bundle.version, info.fw) : 0;
    const versionPill = !bundle ? null
      : newer > 0 ? h('span', { class: 'pill warn' }, 'Update available')
        : h('span', { class: 'pill ok' }, 'Up to date');
    const rows = [
      ['Firmware', h('span', {}, `${info.fw ?? '?'} `, versionPill)],
      ['Available', bundle ? bundle.version : (state.bundleError ?? 'Loading…')],
      ['CircuitPython', info.circuitpython ?? '?'],
      ['Board', BOARD_NAMES[info.board] ?? info.board ?? '?'],
      ['Storage', info.writable ? 'Normal: the keypad saves its own files' : 'USB drive mode: files edited from the computer'],
      ['Free memory', info.mem_free ? formatBytes(info.mem_free) : '?'],
      ['Free storage', info.fs_free ? formatBytes(info.fs_free) : '?'],
    ];
    if (info.recovery) rows.unshift(['Problem', h('span', { class: 'error-text' }, info.recovery)]);
    parts.push(h('table', { class: 'info-table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))));

    const busy = state.update && !state.update.done && !state.update.error;
    parts.push(h('h3', {}, 'Update'));
    parts.push(h('div', { class: 'row' },
      button(newer > 0 || info.recovery ? `Install firmware ${bundle?.version ?? ''}` : 'Reinstall firmware', updateFirmware, {
        class: 'btn primary',
        disabled: busy || !bundle || info.writable === false,
        title: info.writable === false ? 'Restart the keypad normally first' : undefined,
      }),
      hint('Only changed files are sent. Your keys and settings are kept.')));
    if (state.update) {
      const u = state.update;
      parts.push(h('div', {},
        u.total ? h('div', { class: 'progress' }, h('div', { style: `width: ${Math.round((u.sent / u.total) * 100)}%` })) : null,
        h('div', { class: u.error ? 'error-text' : 'hint' }, u.error ?? u.text)));
    }

    parts.push(h('h3', {}, 'Restart'));
    parts.push(h('div', { class: 'actions-list' },
      h('div', { class: 'action-row' },
        button('Restart keypad', () => reboot('normal')),
        hint('Starts the firmware fresh. Unsaved previews are dropped.')),
      h('div', { class: 'action-row' },
        button('Restart as USB drive', () => reboot('drive'), { disabled: info.writable === false }),
        hint('Shows the CIRCUITPY drive on your computer for one boot, to edit files by hand. '
          + 'Holding key 0 while plugging in does the same.')),
      h('div', { class: 'action-row' },
        button('Restart into bootloader', () => {
          if (window.confirm('Restart into the bootloader to install CircuitPython? The keypad stops working '
            + 'until you drag a .uf2 file onto it or unplug it.')) reboot('bootloader');
        }),
        hint('For installing or updating CircuitPython itself. Your files and settings are kept.'))));
  }
  parts.push(h('details', {},
    h('summary', {}, 'Setting up a new keypad'),
    h('ol', {},
      h('li', {}, 'Hold the Pico’s BOOTSEL button while plugging it in. A drive named RPI-RP2 (Pico) or RP2350 (Pico 2) appears.'),
      h('li', {}, 'Download CircuitPython 10 for ',
        h('a', { href: 'https://circuitpython.org/board/raspberry_pi_pico/', target: '_blank', rel: 'noopener' }, 'Pico'),
        ' or ',
        h('a', { href: 'https://circuitpython.org/board/raspberry_pi_pico2/', target: '_blank', rel: 'noopener' }, 'Pico 2'),
        ' and drag the .uf2 file onto that drive. It restarts as CIRCUITPY.'),
      h('li', {}, 'Copy everything inside this project’s firmware folder onto CIRCUITPY, replacing code.py.'),
      h('li', {}, 'Unplug the keypad and plug it back in, then click Connect keypad.'))));
  return h('div', {}, parts);
}

// Wiring

function init() {
  if (!restoreDraft()) state.config.platform = detectPlatform();
  state.check = validate(state.config);
  if (state.saved === null && state.check.valid) state.saved = configJSON();

  $('#connect').addEventListener('click', onConnectButton);
  $('#save').addEventListener('click', save);
  $('#revert').addEventListener('click', revert);
  $('#pick').addEventListener('change', (e) => setPick(e.target.checked));
  $('#import-file').addEventListener('change', (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    if (file) importFile(file);
  });
  for (const tab of document.querySelectorAll('.tabs [data-tab]')) {
    tab.addEventListener('click', () => {
      cancelRecording();
      state.tab = tab.dataset.tab;
      renderTabs();
      renderPanel();
    });
  }
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (!$('#save').disabled) save();
    }
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.conn && isDirty()) e.preventDefault();
  });

  if (serialSupported()) {
    navigator.serial.addEventListener('connect', (e) => {
      if (!state.conn && !state.userDisconnected) connectSoon(e.target);
    });
    connectGranted();
  }
  if (location.protocol !== 'file:') {
    loadBundle(FIRMWARE_BASE)
      .then((bundle) => { state.bundle = bundle; })
      .catch((error) => { state.bundleError = error.message; })
      .finally(() => { renderBanners(); if (state.tab === 'firmware') renderPanel(); });
  } else {
    state.bundleError = 'Unavailable when the page is opened as a file';
  }
  renderAll();
}

init();
