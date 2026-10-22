import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Connection, DeviceError, PORT_BUSY, openKeypad } from '../../web/js/device.js';

/**
 * A Connection wired to a scripted fake keypad. respond(msg) returns the reply
 * object (or null for silence); the test can also push raw lines with send().
 */
function harness(respond) {
  const toHost = new TransformStream();
  const toDevice = new TransformStream();
  const deviceWriter = toHost.writable.getWriter();
  const send = (text) => deviceWriter.write(new TextEncoder().encode(text));
  const received = [];
  (async () => {
    const reader = toDevice.readable.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        received.push(msg);
        const reply = respond(msg);
        if (reply) await send(`${JSON.stringify({ id: msg.id, ...reply })}\n`);
      }
    }
  })();
  const conn = new Connection(toHost.readable, toDevice.writable);
  return { conn, send, received, end: () => deviceWriter.close() };
}

test('call resolves with the reply that has the same id', async () => {
  const { conn } = harness((msg) => ({ ok: true, echo: msg.cmd }));
  const [a, b] = await Promise.all([conn.call('hello'), conn.call('get_config')]);
  assert.equal(a.echo, 'hello');
  assert.equal(b.echo, 'get_config');
  await conn.close();
});

test('a refusal rejects with the keypad’s message and reply', async () => {
  const { conn } = harness(() => ({ ok: false, error: 'layers: needs at least one layer', applied: true }));
  await assert.rejects(conn.call('set_config'), (error) => {
    assert.ok(error instanceof DeviceError);
    assert.equal(error.message, 'layers: needs at least one layer');
    assert.equal(error.reply.applied, true);
    return true;
  });
  await conn.close();
});

test('events, split lines and noise', async () => {
  const { conn, send } = harness(() => null);
  const keys = [];
  const noise = [];
  conn.addEventListener('key', (e) => keys.push(e.detail));
  conn.addEventListener('noise', (e) => noise.push(e.detail));
  await send('{"event": "key", "key": 3, "do');
  await send('wn": true}\r\n>>> \n{"event": "key", "key": 3, "down": false}\n');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(keys, [{ event: 'key', key: 3, down: true }, { event: 'key', key: 3, down: false }]);
  assert.deepEqual(noise, ['>>>']);
  await conn.close();
});

test('silence times out', async () => {
  const { conn } = harness(() => null);
  await assert.rejects(conn.call('hello', {}, 20), (error) => error.reply?.timeout === true);
  await conn.close();
});

test('the device going away rejects pending calls and reports close', async () => {
  const { conn, end } = harness(() => null);
  let closed = null;
  conn.addEventListener('close', (e) => { closed = e.detail; });
  const pending = conn.call('hello', {}, 5000);
  await end();
  await assert.rejects(pending, /disconnected/);
  assert.deepEqual(closed, { expected: false });
  await assert.rejects(conn.call('hello'), /not connected/);
});

test('close() is reported as expected', async () => {
  const { conn } = harness(() => null);
  let closed = null;
  conn.addEventListener('close', (e) => { closed = e.detail; });
  await conn.close();
  assert.deepEqual(closed, { expected: true });
});

test('a port held by another tab or app gets a clear message', async () => {
  const busy = { open: async () => { throw new DOMException('Failed to open serial port.', 'NetworkError'); } };
  await assert.rejects(openKeypad(busy), (error) => error instanceof DeviceError && error.message === PORT_BUSY);
});
