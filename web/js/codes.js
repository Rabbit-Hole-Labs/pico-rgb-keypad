// HID key and media names, matching firmware/lib/rgbkeypad/codes.py (and so
// adafruit_hid 6.1.10). tests/web/codes.test.js checks the two stay in step.

const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l, i) => [l, 0x04 + i, l]);
const digitNames = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'ZERO'];
const digits = digitNames.map((n, i) => [n, 0x1e + i, String((i + 1) % 10)]);
const fKeys = Array.from({ length: 24 }, (_, i) => [
  `F${i + 1}`, i < 12 ? 0x3a + i : 0x68 + i - 12, `F${i + 1}`,
]);
const keypadDigits = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'ZERO']
  .map((n, i) => [`KEYPAD_${n}`, 0x59 + i, `Keypad ${(i + 1) % 10}`]);

// [group label, [[name, code, label], ...]]
export const KEY_GROUPS = [
  ['Letters', letters],
  ['Numbers', digits],
  ['Editing', [
    ['ENTER', 0x28, 'Return'],
    ['TAB', 0x2b, 'Tab'],
    ['SPACEBAR', 0x2c, 'Space'],
    ['BACKSPACE', 0x2a, 'Delete (Backspace)'],
    ['DELETE', 0x4c, 'Forward Delete'],
    ['ESCAPE', 0x29, 'Escape'],
    ['INSERT', 0x49, 'Insert'],
    ['CAPS_LOCK', 0x39, 'Caps Lock'],
  ]],
  ['Navigation', [
    ['UP_ARROW', 0x52, 'Up arrow'],
    ['DOWN_ARROW', 0x51, 'Down arrow'],
    ['LEFT_ARROW', 0x50, 'Left arrow'],
    ['RIGHT_ARROW', 0x4f, 'Right arrow'],
    ['HOME', 0x4a, 'Home'],
    ['END', 0x4d, 'End'],
    ['PAGE_UP', 0x4b, 'Page Up'],
    ['PAGE_DOWN', 0x4e, 'Page Down'],
  ]],
  ['Symbols', [
    ['MINUS', 0x2d, '- (minus)'],
    ['EQUALS', 0x2e, '= (equals)'],
    ['LEFT_BRACKET', 0x2f, '[ (left bracket)'],
    ['RIGHT_BRACKET', 0x30, '] (right bracket)'],
    ['BACKSLASH', 0x31, '\\ (backslash)'],
    ['SEMICOLON', 0x33, '; (semicolon)'],
    ['QUOTE', 0x34, "' (quote)"],
    ['GRAVE_ACCENT', 0x35, '` (backtick)'],
    ['COMMA', 0x36, ', (comma)'],
    ['PERIOD', 0x37, '. (period)'],
    ['FORWARD_SLASH', 0x38, '/ (slash)'],
    ['POUND', 0x32, 'Non-US #'],
    ['KEYPAD_BACKSLASH', 0x64, 'Non-US \\ (ISO key)'],
  ]],
  ['Function keys', fKeys],
  ['Keypad', [
    ...keypadDigits,
    ['KEYPAD_PERIOD', 0x63, 'Keypad .'],
    ['KEYPAD_PLUS', 0x57, 'Keypad +'],
    ['KEYPAD_MINUS', 0x56, 'Keypad -'],
    ['KEYPAD_ASTERISK', 0x55, 'Keypad *'],
    ['KEYPAD_FORWARD_SLASH', 0x54, 'Keypad /'],
    ['KEYPAD_EQUALS', 0x67, 'Keypad ='],
    ['KEYPAD_ENTER', 0x58, 'Keypad Enter'],
    ['KEYPAD_NUMLOCK', 0x53, 'Num Lock / Clear'],
  ]],
  ['System', [
    ['PRINT_SCREEN', 0x46, 'Print Screen'],
    ['SCROLL_LOCK', 0x47, 'Scroll Lock'],
    ['PAUSE', 0x48, 'Pause'],
    ['APPLICATION', 0x65, 'Menu (Application)'],
    ['POWER', 0x66, 'Power'],
  ]],
  ['Modifiers', [
    ['LEFT_CONTROL', 0xe0, 'Control'],
    ['LEFT_SHIFT', 0xe1, 'Shift'],
    ['LEFT_ALT', 0xe2, 'Option / Alt'],
    ['LEFT_GUI', 0xe3, 'Command / Windows'],
    ['RIGHT_CONTROL', 0xe4, 'Right Control'],
    ['RIGHT_SHIFT', 0xe5, 'Right Shift'],
    ['RIGHT_ALT', 0xe6, 'Right Option / Alt'],
    ['RIGHT_GUI', 0xe7, 'Right Command / Windows'],
  ]],
];

export const KEYS = Object.fromEntries(KEY_GROUPS.flatMap(([, keys]) => keys.map(([n, c]) => [n, c])));
export const KEY_LABELS = Object.fromEntries(KEY_GROUPS.flatMap(([, keys]) => keys.map(([n, , l]) => [n, l])));

// Modifier toggles shown in the shortcut editor, in macOS display order.
export const MODIFIERS = [
  { name: 'LEFT_CONTROL', symbol: '⌃', label: 'Control' },
  { name: 'LEFT_ALT', symbol: '⌥', label: 'Option / Alt' },
  { name: 'LEFT_SHIFT', symbol: '⇧', label: 'Shift' },
  { name: 'LEFT_GUI', symbol: '⌘', label: 'Command / Windows' },
];
const MODIFIER_SYMBOLS = {
  LEFT_CONTROL: '⌃', RIGHT_CONTROL: '⌃', LEFT_ALT: '⌥', RIGHT_ALT: '⌥',
  LEFT_SHIFT: '⇧', RIGHT_SHIFT: '⇧', LEFT_GUI: '⌘', RIGHT_GUI: '⌘',
};
export const isModifier = (name) => KEYS[name] >= 0xe0;

// Short forms for key tiles and combo chips.
const SHORT = {
  ENTER: '↩', TAB: '⇥', SPACEBAR: 'Space', BACKSPACE: '⌫', DELETE: '⌦', ESCAPE: 'Esc',
  UP_ARROW: '↑', DOWN_ARROW: '↓', LEFT_ARROW: '←', RIGHT_ARROW: '→', PAGE_UP: 'PgUp',
  PAGE_DOWN: 'PgDn', CAPS_LOCK: '⇪', MINUS: '-', EQUALS: '=', LEFT_BRACKET: '[',
  RIGHT_BRACKET: ']', BACKSLASH: '\\', SEMICOLON: ';', QUOTE: "'", GRAVE_ACCENT: '`',
  COMMA: ',', PERIOD: '.', FORWARD_SLASH: '/', PRINT_SCREEN: 'PrtSc', APPLICATION: 'Menu',
};

export function keyShort(name) {
  if (MODIFIER_SYMBOLS[name]) return MODIFIER_SYMBOLS[name];
  if (SHORT[name]) return SHORT[name];
  const label = KEY_LABELS[name];
  return label && label.length <= 3 ? label : (label || name).replace(/^Keypad /, 'KP ');
}

/** "⌘⇧Z" style label for a list of key names: modifiers first, in macOS order. */
export function comboLabel(keys) {
  const order = ['LEFT_CONTROL', 'RIGHT_CONTROL', 'LEFT_ALT', 'RIGHT_ALT', 'LEFT_SHIFT',
    'RIGHT_SHIFT', 'LEFT_GUI', 'RIGHT_GUI'];
  const mods = order.filter((m) => keys.includes(m)).map(keyShort);
  const rest = keys.filter((k) => !isModifier(k)).map(keyShort);
  return mods.join('') + rest.join(' + ');
}

export const MEDIA_LIST = [
  ['PLAY_PAUSE', 0xcd, 'Play / Pause'],
  ['SCAN_NEXT_TRACK', 0xb5, 'Next track'],
  ['SCAN_PREVIOUS_TRACK', 0xb6, 'Previous track'],
  ['FAST_FORWARD', 0xb3, 'Fast forward'],
  ['REWIND', 0xb4, 'Rewind'],
  ['STOP', 0xb7, 'Stop'],
  ['RECORD', 0xb2, 'Record'],
  ['EJECT', 0xb8, 'Eject'],
  ['MUTE', 0xe2, 'Mute'],
  ['VOLUME_INCREMENT', 0xe9, 'Volume up'],
  ['VOLUME_DECREMENT', 0xea, 'Volume down'],
  ['BRIGHTNESS_INCREMENT', 0x6f, 'Display brightness up'],
  ['BRIGHTNESS_DECREMENT', 0x70, 'Display brightness down'],
];
export const MEDIA = Object.fromEntries(MEDIA_LIST.map(([n, c]) => [n, c]));
export const MEDIA_LABELS = Object.fromEntries(MEDIA_LIST.map(([n, , l]) => [n, l]));

// KeyboardEvent.code -> key name, for recording a shortcut from the keyboard.
const DOM_CODES = {
  Enter: 'ENTER', Escape: 'ESCAPE', Backspace: 'BACKSPACE', Tab: 'TAB', Space: 'SPACEBAR',
  Minus: 'MINUS', Equal: 'EQUALS', BracketLeft: 'LEFT_BRACKET', BracketRight: 'RIGHT_BRACKET',
  Backslash: 'BACKSLASH', Semicolon: 'SEMICOLON', Quote: 'QUOTE', Backquote: 'GRAVE_ACCENT',
  Comma: 'COMMA', Period: 'PERIOD', Slash: 'FORWARD_SLASH', CapsLock: 'CAPS_LOCK',
  PrintScreen: 'PRINT_SCREEN', ScrollLock: 'SCROLL_LOCK', Pause: 'PAUSE', Insert: 'INSERT',
  Home: 'HOME', PageUp: 'PAGE_UP', Delete: 'DELETE', End: 'END', PageDown: 'PAGE_DOWN',
  ArrowRight: 'RIGHT_ARROW', ArrowLeft: 'LEFT_ARROW', ArrowDown: 'DOWN_ARROW',
  ArrowUp: 'UP_ARROW', NumLock: 'KEYPAD_NUMLOCK', NumpadDivide: 'KEYPAD_FORWARD_SLASH',
  NumpadMultiply: 'KEYPAD_ASTERISK', NumpadSubtract: 'KEYPAD_MINUS', NumpadAdd: 'KEYPAD_PLUS',
  NumpadEnter: 'KEYPAD_ENTER', NumpadDecimal: 'KEYPAD_PERIOD', NumpadEqual: 'KEYPAD_EQUALS',
  IntlBackslash: 'KEYPAD_BACKSLASH', ContextMenu: 'APPLICATION', Power: 'POWER',
  ControlLeft: 'LEFT_CONTROL', ShiftLeft: 'LEFT_SHIFT', AltLeft: 'LEFT_ALT', MetaLeft: 'LEFT_GUI',
  ControlRight: 'RIGHT_CONTROL', ShiftRight: 'RIGHT_SHIFT', AltRight: 'RIGHT_ALT',
  MetaRight: 'RIGHT_GUI',
};

export function keyFromDomCode(code) {
  if (DOM_CODES[code]) return DOM_CODES[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit(\d)$/.exec(code);
  if (m) return digitNames[(Number(m[1]) + 9) % 10];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `KEYPAD_${digitNames[(Number(m[1]) + 9) % 10]}`;
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return code;
  return null;
}

/** Key names for a recorded KeyboardEvent: held modifiers, then the key itself. */
export function comboFromEvent(event) {
  const keys = [];
  if (event.ctrlKey) keys.push('LEFT_CONTROL');
  if (event.altKey) keys.push('LEFT_ALT');
  if (event.shiftKey) keys.push('LEFT_SHIFT');
  if (event.metaKey) keys.push('LEFT_GUI');
  const key = keyFromDomCode(event.code);
  if (key && !isModifier(key)) keys.push(key);
  return keys;
}
