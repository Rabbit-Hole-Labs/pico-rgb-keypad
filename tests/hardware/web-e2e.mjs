// Drives the web app's own modules (device.js, config.js, firmware.js) against a
// real keypad from Node, standing in for the browser's Web Serial plumbing. Not
// part of `npm test`.
//
//   node tests/hardware/web-e2e.mjs /dev/cu.usbmodemXXXX3 [--install]
//
// Without --install it only reads, previews (unsaved) and restores. With
// --install it also installs firmware/ over serial, restarts the keypad and
// checks the new firmware answers, the same way the Firmware tab does.

import { openSync, readdirSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import tty from 'node:tty';
import assert from 'node:assert/strict';

import { Connection } from '../../web/js/device.js';
import { normalize } from '../../web/js/config.js';
import { installFirmware, loadBundle } from '../../web/js/firmware.js';

const [path, flag] = process.argv.slice(2);
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

let conn = open(path);
const info = await hello(conn);
console.log('hello', info);
assert.ok(!info.recovery, info.recovery);

const { config } = await conn.call('get_config');
assert.deepEqual(normalize(config), config, 'web validator accepts the keypad config unchanged');
console.log('PASS web validator agrees with the keypad config');

const preview = structuredClone(config);
preview.layers[0].keys[5].color = '#ff00ff';
await conn.call('set_config', { config: normalize(preview), save: false });
assert.equal((await conn.call('get_config')).config.layers[0].keys[5].color, '#ff00ff');
await conn.call('set_config', { config, save: false });
console.log('PASS preview round trip');

if (flag === '--install') {
  const bundle = await loadBundle(new URL('../../firmware/', import.meta.url), fileFetch);
  const result = await installFirmware(conn, bundle, ({ sent, total, file }) => {
    if (file) process.stdout.write(`\r  ${sent}/${total} bytes  ${file.padEnd(40)}`);
  });
  console.log(`\nPASS installed ${result.updated.length} file(s), ${result.unchanged} unchanged:`, result.updated);
  if (result.updated.length) {
    const before = new Set(readdirSync('/dev').filter((n) => n.startsWith('cu.usbmodem')));
    await conn.call('reboot', { mode: 'normal' });
    await sleep(500);
    conn.done();
    let ports = [];
    for (let i = 0; i < 20 && !ports.length; i += 1) {
      await sleep(500);
      ports = readdirSync('/dev').filter((n) => n.startsWith('cu.usbmodem'));
    }
    console.log('ports before restart', [...before], 'after', ports);
    await sleep(2500); // let code.py start
    let answered = null;
    for (const name of ports) {
      const candidate = open(`/dev/${name}`);
      try {
        answered = { conn: candidate, info: await hello(candidate), name };
        break;
      } catch {
        candidate.done();
      }
    }
    assert.ok(answered, 'the restarted keypad answers on one of its ports');
    conn = answered.conn;
    console.log('PASS restarted keypad answers on', answered.name, answered.info);
    assert.ok(!answered.info.recovery, answered.info.recovery);
  }
  const paused = await conn.call('set_paused', { paused: true });
  assert.equal(paused.paused, true);
  await conn.call('set_paused', { paused: false });
  const starter = await conn.call('get_default_config');
  assert.deepEqual(normalize(starter.config), starter.config);
  console.log('PASS new commands: set_paused, get_default_config');
}

await conn.close();
conn.done();
console.log('done');
process.exit(0);
