// Talks to the keypad firmware over its USB data port: newline-delimited JSON,
// one reply per request matched by id, plus unsolicited {"event": ...} lines
// (see firmware/lib/rgbkeypad/protocol.py).

export class DeviceError extends Error {
  constructor(message, reply = null) {
    super(message);
    this.reply = reply;
  }
}

export const WRONG_PORT = 'That port didn’t answer. If the keypad is in USB drive mode it has '
  + 'two ports, so connect again and pick the other one. If it’s running other firmware, '
  + 'install this firmware first (see the README).';

/** Request/reply over a pair of byte streams. Events are dispatched by name. */
export class Connection extends EventTarget {
  constructor(readable, writable) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.closing = false;
    this.encoder = new TextEncoder();
    this.writer = writable.getWriter();
    this.writeChain = Promise.resolve();
    const decoder = new TextDecoderStream();
    this.pipeDone = readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    this.readDone = this.readLoop();
  }

  async readLoop() {
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += value;
        let end = buffer.indexOf('\n');
        while (end >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line) this.handleLine(line);
          end = buffer.indexOf('\n');
        }
        if (buffer.length > 1 << 20) buffer = '';
      }
    } catch {
      // The port went away; shutdown() below reports it.
    } finally {
      this.shutdown();
    }
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.dispatchEvent(new CustomEvent('noise', { detail: line }));
      return;
    }
    if (msg && typeof msg.event === 'string') {
      this.dispatchEvent(new CustomEvent(msg.event, { detail: msg }));
      return;
    }
    const waiter = this.pending.get(msg?.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg);
    else waiter.reject(new DeviceError(msg.error || 'The keypad refused the request', msg));
  }

  write(text) {
    this.writeChain = this.writeChain.then(() => this.writer.write(this.encoder.encode(text)));
    return this.writeChain;
  }

  call(cmd, args = {}, timeout = 4000) {
    if (this.closed) return Promise.reject(new DeviceError('The keypad is not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError(`The keypad didn’t answer “${cmd}”`, { timeout: true }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write(`${JSON.stringify({ ...args, id, cmd })}\n`).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DeviceError(error.message || 'Write failed'));
      });
    });
  }

  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new DeviceError('The keypad disconnected'));
    }
    this.pending.clear();
    this.dispatchEvent(new CustomEvent('close', { detail: { expected: this.closing } }));
  }

  async close() {
    this.closing = true;
    try { await this.reader.cancel(); } catch { /* already closed */ }
    await this.pipeDone;
    await this.readDone;
    try { this.writer.releaseLock(); } catch { /* write still pending */ }
  }
}

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

// CircuitPython boards use Adafruit's USB vendor ID, Pico and Pico 2 alike.
export const PORT_FILTERS = [{ usbVendorId: 0x239a }];

/** Open a Web Serial port and check the keypad firmware answers on it. */
export async function openKeypad(port) {
  await port.open({ baudRate: 115200, bufferSize: 65536 });
  try {
    await port.setSignals({ dataTerminalReady: true });
  } catch { /* not every platform supports it; the firmware copes */ }
  const conn = new Connection(port.readable, port.writable);
  conn.port = port;
  try {
    await conn.write('\n'); // ends any partial line a previous session left behind
    const hello = await conn.call('hello', {}, 1500);
    return { conn, hello };
  } catch (error) {
    await closeKeypad(conn);
    throw error.reply?.timeout ? new DeviceError(WRONG_PORT) : error;
  }
}

export async function closeKeypad(conn) {
  await conn.close();
  try { await conn.port?.close(); } catch { /* already gone */ }
}
