// Firmware updates over the data port: fetch the files listed in
// firmware/manifest.json, upload only the ones that differ, verify each by
// CRC32, then commit them all at once (see firmware/lib/rgbkeypad/fs.py).

export const CHUNK = 768;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** <0 if a is older than b, 0 if equal, >0 if newer. Missing parts count as 0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Fetch the manifest and every file it lists. base is the firmware folder's URL. */
export async function loadBundle(base, fetchImpl = fetch) {
  const get = async (path) => {
    const res = await fetchImpl(new URL(path, base), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Couldn’t load firmware/${path} (${res.status})`);
    return res;
  };
  const manifest = await (await get('manifest.json')).json();
  const files = await Promise.all(manifest.files.map(async (path) => ({
    path, bytes: new Uint8Array(await (await get(path)).arrayBuffer()),
  })));
  return { version: manifest.version, files };
}

/**
 * Install a bundle on the keypad. Files already identical on the keypad are
 * skipped. If anything fails, staged files are discarded and the keypad keeps
 * the firmware it had. The caller reboots the keypad afterwards.
 */
export async function installFirmware(conn, bundle, onProgress = () => {}) {
  const todo = [];
  for (const file of bundle.files) {
    const crc = crc32(file.bytes);
    let same = false;
    try {
      const have = await conn.call('fs_crc', { path: file.path });
      same = have.crc === crc && have.size === file.bytes.length;
    } catch { /* not on the keypad yet */ }
    if (!same) todo.push({ ...file, crc });
  }
  const total = todo.reduce((n, f) => n + f.bytes.length, 0);
  let sent = 0;
  onProgress({ sent, total, file: null });
  try {
    for (const file of todo) {
      let offset = 0;
      do {
        const chunk = file.bytes.subarray(offset, offset + CHUNK);
        const reply = await conn.call('fs_write',
          { path: file.path, offset, data: toBase64(chunk) }, 8000);
        offset = reply.size;
        sent += chunk.length;
        onProgress({ sent, total, file: file.path });
      } while (offset < file.bytes.length);
      const check = await conn.call('fs_crc', { path: file.path, staged: true });
      if (check.crc !== file.crc || check.size !== file.bytes.length) {
        throw new Error(`${file.path} arrived damaged, so nothing was changed`);
      }
    }
    if (todo.length) await conn.call('fs_commit', { paths: todo.map((f) => f.path) }, 15000);
  } catch (error) {
    await conn.call('fs_discard', { paths: todo.map((f) => f.path) }).catch(() => {});
    throw error;
  }
  return { updated: todo.map((f) => f.path), unchanged: bundle.files.length - todo.length };
}
