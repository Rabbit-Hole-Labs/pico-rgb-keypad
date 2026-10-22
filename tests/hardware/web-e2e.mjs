// Drives the web app's own modules (device.js, config.js, firmware.js) against a
// real keypad from Node, standing in for the browser's Web Serial plumbing. Not
// part of `npm test`.
//
//   node tests/hardware/web-e2e.mjs /dev/cu.usbmodemXXXX [--install] [--save] [--size] [--listen]
//
// With no flags it only reads, previews (unsaved) and restores.
//   --install  installs firmware/ over serial and restarts, as the Firmware tab does
//   --save     saves a changed color, restarts, checks it survived, saves the original back
//   --size     previews ever larger configs to find what fits in the keypad's memory
//   --listen   prints key and layer events for 150 seconds while you press keys

import { openSync, readdirSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import tty from 'node:tty';
import assert from 'node:assert/strict';

import { Connection } from '../../web/js/device.js';
import { normalize } from '../../web/js/config.js';
import { installFirmware, loadBundle } from '../../web/js/firmware.js';

const [path, ...flags] = process.argv.slice(2);
const has = (flag) => flags.includes(flag);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function open(portPath) {
  const fd = openSync(portPath, 'r+');
  const input = new tty.ReadStream(fd);
  input.setRawMode(true);
  const output = new tty.WriteStream(fd);
  const conn = new Connection(Readable.toWeb(input), Writable.toWeb(output));
  conn.done = () => { input.destroy(); output.destroy(); };
  return conn;
}

async function hello(conn) {
  await conn.write('\n');
  return conn.call('hello', {}, 2000);
}

// fetch() stand-in that reads the repo's firmware folder from disk.
const fileFetch = async (url) => {
  const bytes = readFileSync(new URL(url));
  return { ok: true, status: 200, json: async () => JSON.parse(bytes), arrayBuffer: async () => bytes };
};

/** Restart the keypad and return a connection to whichever port answers afterwards. */
async function restart(conn) {
  await conn.call('reboot', { mode: 'normal' });
  await sleep(500);
  conn.done();
  let ports = [];
  for (let i = 0; i < 20 && !ports.length; i += 1) {
    await sleep(500);
    ports = readdirSync('/dev').filter((n) => n.startsWith('cu.usbmodem'));
  }
  await sleep(2500); // let code.py start
  for (const name of ports) {
    const candidate = open(`/dev/${name}`);
    try {
      const info = await hello(candidate);
      assert.ok(!info.recovery, info.recovery);
      console.log('  restarted keypad answers on', name, `(ports: ${ports.join(', ')})`);
      return candidate;
    } catch (error) {
      candidate.done();
      if (error instanceof assert.AssertionError) throw error;
    }
  }
  throw new Error('the restarted keypad did not answer');
}

let conn = open(path);
const info = await hello(conn);
console.log('hello', info);
assert.ok(!info.recovery, info.recovery);

// Install first, so a keypad whose old firmware misbehaves can still be fixed.
if (has('--install')) {
  const bundle = await loadBundle(new URL('../../firmware/', import.meta.url), fileFetch);
  const result = await installFirmware(conn, bundle, ({ sent, total, file }) => {
    if (file) process.stdout.write(`\r  ${sent}/${total} bytes  ${file.padEnd(40)}`);
  });
  console.log(`\nPASS installed ${result.updated.length} file(s), ${result.unchanged} unchanged:`, result.updated);
  if (result.updated.length) conn = await restart(conn);
  const paused = await conn.call('set_paused', { paused: true });
  assert.equal(paused.paused, true);
  await conn.call('set_paused', { paused: false });
  const starter = await conn.call('get_default_config');
  assert.deepEqual(normalize(starter.config), starter.config);
  console.log('PASS set_paused, get_default_config');
}

const { config } = await conn.call('get_config');
assert.deepEqual(normalize(config), config, 'web validator accepts the keypad config unchanged');
console.log('PASS web validator agrees with the keypad config');

const preview = structuredClone(config);
preview.layers[0].keys[5].color = '#ff00ff';
await conn.call('set_config', { config: normalize(preview), save: false });
assert.equal((await conn.call('get_config')).config.layers[0].keys[5].color, '#ff00ff');
await conn.call('set_config', { config, save: false });
console.log('PASS preview round trip');

if (has('--save')) {
  const original = (await conn.call('get_config')).config;
  const changed = structuredClone(original);
  changed.layers[0].keys[5].color = '#123456';
  changed.layers[0].keys[5].label = 'saved-test';
  assert.equal((await conn.call('set_config', { config: changed, save: true })).saved, true);
  conn = await restart(conn);
  const after = (await conn.call('get_config')).config;
  assert.equal(after.layers[0].keys[5].color, '#123456');
  assert.equal(after.layers[0].keys[5].label, 'saved-test');
  console.log('PASS saved config survived a restart');
  assert.equal((await conn.call('set_config', { config: original, save: true })).saved, true);
  const names = (await conn.call('fs_list')).entries.map((e) => e.name);
  assert.ok(names.includes('config.json'), names);
  assert.ok(!names.some((n) => n.endsWith('.tmp') || n.endsWith('.new')), names);
  assert.deepEqual((await conn.call('get_config')).config, original);
  console.log('PASS original config saved back; no temp files left:', names.join(' '));
}

if (has('--size')) {
  // Two shapes: long typed text (few objects per byte) and macros made of many
  // small steps (the most objects per byte, so the worst case for RAM).
  const layout = (layers, action) => ({
    layers: Array.from({ length: layers }, (_, li) => ({
      name: `L${li}`,
      keys: Array.from({ length: 16 }, (_, ki) => ({ label: `k${ki}`, color: '#336699', action: action() })),
    })),
  });
  const shapes = {
    text: (n) => layout(4, () => ({ type: 'text', text: 'x'.repeat(n * 25) })),
    steps: (n) => layout(8, () => ({ type: 'macro', steps: Array.from({ length: n }, () => ({ op: 'tap', keys: ['LEFT_GUI', 'A'] })) })),
  };
  for (const [shape, make] of Object.entries(shapes)) {
    for (let n = 1; n <= 12; n += 1) {
      const candidate = normalize(make(n));
      const kb = (JSON.stringify(candidate).length / 1024).toFixed(1);
      try {
        await conn.call('set_config', { config: candidate, save: false }, 10000);
        const mem = (await conn.call('hello')).mem_free;
        console.log(`  ok    ${shape} ${kb} KB, ${mem} bytes free after`);
      } catch (error) {
        console.log(`  FAIL  ${shape} ${kb} KB: ${error.message}`);
        break;
      }
    }
    await conn.call('set_config', { config, save: false }); // the keypad must still answer
  }
  console.log('PASS keypad still answers after the largest attempts');
}

if (has('--listen')) {
  console.log('Listening for 150 s. Press keys on the keypad.');
  conn.addEventListener('key', (e) => console.log('  key', e.detail.key, e.detail.down ? 'down' : 'up'));
  conn.addEventListener('layer', (e) => console.log('  layer', e.detail.layer));
  conn.addEventListener('error', (e) => console.log('  error', e.detail.message));
  await sleep(150000);
}

await conn.close();
conn.done();
console.log('done');
process.exit(0);
