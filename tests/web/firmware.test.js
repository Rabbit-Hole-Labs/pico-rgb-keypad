import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CHUNK, compareVersions, crc32, installFirmware, toBase64 } from '../../web/js/firmware.js';
import { DeviceError } from '../../web/js/device.js';

const enc = (s) => new TextEncoder().encode(s);

test('crc32 matches binascii.crc32 on the keypad', () => {
  assert.equal(crc32(enc('hello')), 907060870); // printed by CircuitPython 10.3.0
  assert.equal(crc32(new Uint8Array()), 0);
});

test('toBase64 handles large binary input', () => {
  const bytes = new Uint8Array(100000).map((_, i) => i * 7);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('compareVersions', () => {
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
});

/** In-memory stand-in for the keypad's fs_* commands (firmware/lib/rgbkeypad/fs.py). */
function fakeKeypad(files = {}, { failWriteOn = null, corrupt = null } = {}) {
  const disk = new Map(Object.entries(files).map(([p, s]) => [p, enc(s)]));
  const calls = [];
  const conn = {
    async call(cmd, args) {
      calls.push([cmd, args.path ?? args.paths]);
      const staged = `${args.path}.new`;
      switch (cmd) {
        case 'fs_crc': {
          const bytes = disk.get(args.staged ? staged : args.path);
          if (!bytes) throw new DeviceError('missing');
          return { crc: crc32(bytes), size: bytes.length };
        }
        case 'fs_write': {
          if (args.path === failWriteOn) throw new DeviceError('disk full');
          const have = args.offset === 0 ? new Uint8Array() : disk.get(staged);
          assert.equal(have.length, args.offset);
          let data = Uint8Array.from(Buffer.from(args.data, 'base64'));
          if (args.path === corrupt) data = data.map((b) => b ^ 1);
          const next = new Uint8Array(have.length + data.length);
          next.set(have);
          next.set(data, have.length);
          disk.set(staged, next);
          return { size: next.length };
        }
        case 'fs_commit':
          for (const p of args.paths) {
            disk.set(p, disk.get(`${p}.new`));
            disk.delete(`${p}.new`);
          }
          return {};
        case 'fs_discard':
          for (const p of args.paths) disk.delete(`${p}.new`);
          return {};
        default:
          throw new Error(`unexpected ${cmd}`);
      }
    },
  };
  return { conn, disk, calls };
}

const bundle = (files) => ({
  version: '1.0.0',
  files: Object.entries(files).map(([path, s]) => ({ path, bytes: enc(s) })),
});

test('installFirmware uploads changed files in chunks and skips identical ones', async () => {
  const big = 'x'.repeat(CHUNK * 2 + 10);
  const { conn, disk, calls } = fakeKeypad({ 'boot.py': 'same', 'code.py': 'old' });
  const progress = [];
  const result = await installFirmware(conn,
    bundle({ 'boot.py': 'same', 'code.py': big, 'lib/new.py': '' }), (p) => progress.push(p));
  assert.deepEqual(result, { updated: ['code.py', 'lib/new.py'], unchanged: 1 });
  assert.equal(new TextDecoder().decode(disk.get('code.py')), big);
  assert.equal(disk.get('lib/new.py').length, 0);
  assert.equal(calls.filter(([c, p]) => c === 'fs_write' && p === 'code.py').length, 3);
  assert.ok(![...disk.keys()].some((p) => p.endsWith('.new')));
  assert.deepEqual(progress.at(-1), { sent: big.length, total: big.length, file: 'lib/new.py' });
});

test('installFirmware discards everything when an upload fails', async () => {
  const { conn, disk } = fakeKeypad({ 'code.py': 'old' }, { failWriteOn: 'b.py' });
  await assert.rejects(installFirmware(conn, bundle({ 'a.py': 'a', 'b.py': 'b', 'code.py': 'new' })),
    /disk full/);
  assert.equal(new TextDecoder().decode(disk.get('code.py')), 'old');
  assert.deepEqual([...disk.keys()], ['code.py']);
});

test('installFirmware refuses a file that arrives damaged', async () => {
  const { conn, disk } = fakeKeypad({ 'code.py': 'old' }, { corrupt: 'code.py' });
  await assert.rejects(installFirmware(conn, bundle({ 'code.py': 'new' })), /damaged/);
  assert.equal(new TextDecoder().decode(disk.get('code.py')), 'old');
});
