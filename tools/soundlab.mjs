// The sound lab: a page to play with the sound engine (engine/sound) by hand while it is built: effects and edits
// chained on any sound, a sampler on the keyboard, each sound drawn as a waveform and a spectrogram. A developer's
// window, not the editor: its parts (knobs, the spectrogram) are for the editor's panels later.
//   node tools/soundlab.mjs [--port 5660] [--lib name=/path ...]
// Samples come from ~/Stock (read-only) and any --lib folders, served at /files/<lib>/…; /import and /kit make instruments.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSfz, folderKit, namedInstruments } from './instruments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const PORT = +opt('port', 5660);
const LIBS = { stock: path.join(os.homedir(), 'Stock') };
args.forEach((a, i) => { if (a === '--lib') { const [k, v] = args[i + 1].split('='); LIBS[k] = path.resolve(v); } });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff',
  '.sfz': 'text/plain', '.txt': 'text/plain', '.png': 'image/png', '.svg': 'image/svg+xml' };
const AUDIO = /\.(wav|mp3|flac|ogg|aiff?|sfz|txt)$/i;

// a path inside base, or null (no climbing out of it)
const inside = (base, rel) => { const p = path.resolve(base, '.' + path.sep + decodeURIComponent(rel)); return p === base || p.startsWith(base + path.sep) ? p : null; };
function send(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-length': st.size });
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (p === '/') return send(res, path.join(ROOT, 'tools', 'soundlab', 'index.html'));
  if (p.startsWith('/lab/')) { const f = inside(path.join(ROOT, 'tools', 'soundlab'), p.slice(5)); return f ? send(res, f) : (res.writeHead(403), res.end()); }
  if (p.startsWith('/engine/')) { const f = inside(path.join(ROOT, 'engine'), p.slice(8)); return f ? send(res, f) : (res.writeHead(403), res.end()); }
  // samples: /files/<lib>/<path> (audio and sample maps only); /ls/<lib>/<dir>: what a folder holds
  const m = /^\/(files|ls)\/([^/]+)\/?(.*)$/.exec(p);
  if (m && LIBS[m[2]]) {
    const f = inside(LIBS[m[2]], m[3]);
    if (!f) { res.writeHead(403); return res.end(); }
    if (m[1] === 'files') return AUDIO.test(f) ? send(res, f) : (res.writeHead(403), res.end());
    return fs.readdir(f, { withFileTypes: true }, (err, list) => {
      if (err) { res.writeHead(404); return res.end('[]'); }
      const dirs = list.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
      const files = list.filter((e) => e.isFile() && AUDIO.test(e.name)).map((e) => e.name).sort();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ dirs, files }));
    });
  }
  // instruments: /import/<lib>/<file.sfz> (an SFZ as the sampler's own instrument), /kit/<lib>/<folder> (a drum kit
  // from a folder of one-shots) and /named/<lib>/<folder>?octave=12 (samples named by note: one instrument per family),
  // each { instruments, dir }: their samples are named relative to dir (lib-relative)
  const im = /^\/(import|kit|named)\/([^/]+)\/(.+)$/.exec(p);
  if (im && LIBS[im[2]]) {
    const f = inside(LIBS[im[2]], im[3]);
    if (!f) { res.writeHead(403); return res.end(); }
    const dir = im[1] === 'import' ? path.dirname(f) : f;
    const made = im[1] === 'import' ? importSfz(f, { root: dir }).then((i) => [i]) : im[1] === 'kit' ? folderKit(f, { root: f }).then((i) => [i])
      : namedInstruments(f, { octave: +(url.searchParams.get('octave') ?? 0) }).then((r) => r.instruments);
    made.then((instruments) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ instruments, dir: path.relative(LIBS[im[2]], dir).split(path.sep).join('/') })); },
        (e) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (p === '/libs') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(Object.keys(LIBS))); }
  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(`sound lab: http://localhost:${PORT}/  (libraries: ${Object.entries(LIBS).map(([k, v]) => `${k} → ${v}`).join(', ')})`));
