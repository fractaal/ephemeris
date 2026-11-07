// A frame drawn now crosses from a render browser to the studio's window as a file the system holds in memory, not over
// the sockets: 8 MB through them cost more than making a JPEG of it, and the JPEG was only there to get through them.
// The render browser's process writes each frame to the next of a page's slots and says which (app/renderer.cjs), the
// window's process reads it (app/main.mjs). In /dev/shm where the system has it (RAM alone); elsewhere a temporary file:
// the write lands in the system's file cache and the read comes from there, the disk being written later, behind them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR = path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(), `ephemeris-frames-${process.getuid?.() ?? os.userInfo().username}`);
const NAME = /^(\d+)-\d+-\d+$/;
// (a page's frames are read as soon as they are said: its slots are not used again for several frames, by which time
// the last are read)
const SLOTS = 4;

/** Where page `id` of this browser writes: write(bytes) → the file they are in now; close(): its files gone. */
function writer(id) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const open = new Map(), fileOf = (slot) => path.join(DIR, `${process.pid}-${id}-${slot}`);
  let n = 0;
  return {
    write(bytes) {
      const slot = n++ % SLOTS;
      if (!open.has(slot)) open.set(slot, fs.openSync(fileOf(slot), 'w', 0o600));
      fs.writeSync(open.get(slot), bytes, 0, bytes.length, 0);
      return fileOf(slot);
    },
    close() {
      for (const [slot, fd] of open) { fs.closeSync(fd); fs.rmSync(fileOf(slot), { force: true }); }
      open.clear();
    },
  };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** The files of browsers that ended without taking theirs away. */
function sweep() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return; }
  for (const name of names) {
    const m = NAME.exec(name);
    if (m && !alive(+m[1])) fs.rmSync(path.join(DIR, name), { force: true });
  }
}

/** The n bytes of the frame in `file`, which a page names: nothing but a frame's file is read. */
async function read(file, n) {
  if (path.dirname(file) !== DIR || !NAME.test(path.basename(file))) throw new Error('not a frame');
  const f = await fs.promises.open(file, 'r');
  try {
    const px = Buffer.allocUnsafeSlow(n), { bytesRead } = await f.read(px, 0, n, 0);
    if (bytesRead < n) throw new Error('a frame cut short');
    return px;
  } finally { await f.close(); }
}

/** As read, for a frame nothing else will read: the memory its file held goes back to the system. */
async function take(file, n) {
  const px = await read(file, n);
  await fs.promises.truncate(file);
  return px;
}

module.exports = { writer, sweep, read, take };
