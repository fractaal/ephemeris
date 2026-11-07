// Sounds in and out of files for the sound engine (engine/sound), in Node: decoded and written by ffmpeg, and seen as a
// spectrogram (an image: what a sound is made of, over time, for an agent that cannot hear it).
//   import { loadSound, writeSound, spectrogram } from './soundio.mjs';
import { spawn } from 'node:child_process';
import { SR } from '../engine/sound/core.js';

const run = (cmd, args, input) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }), out = [], err = [];
  p.stdout.on('data', (d) => out.push(d)); p.stderr.on('data', (d) => err.push(d));
  p.on('close', (code) => (code ? reject(new Error(`${cmd} failed: ${Buffer.concat(err).toString().slice(-500)}`)) : resolve(Buffer.concat(out))));
  p.stdin.end(input);
});

/** A file (anything ffmpeg reads) as a stereo sound at `sr`. */
export async function loadSound(file, sr = SR) {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(sr), '-']);
  const x = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)), n = x.length >> 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = x[2 * i]; R[i] = x[2 * i + 1]; }
  return { sr, ch: [L, R] };
}

/** Writes a sound to a file (by its extension: .wav as 24-bit PCM, or 32-bit float with { float: true }, .flac, .mp3, …). */
export async function writeSound(file, s, { float = false } = {}) {
  const [L, R] = s.ch, x = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { x[2 * i] = L[i]; x[2 * i + 1] = R[i]; }
  const codec = file.endsWith('.wav') ? ['-c:a', float ? 'pcm_f32le' : 'pcm_s24le'] : [];
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(s.sr), '-ac', '2', '-i', '-', ...codec, file], Buffer.from(x.buffer));
}

/** A sound file's spectrogram as a PNG (log frequency up the side, time across, level as colour): harmonics as lines,
 *  noise as bands, a hit's attack as a vertical edge, a decay as it fades. */
export async function spectrogram(file, png, { width = 1200, height = 1024, from = 20, to = 16000 } = {}) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-lavfi',
    `aformat=channel_layouts=mono,showspectrumpic=s=${width}x${height}:mode=combined:color=intensity:scale=log:fscale=log:start=${from}:stop=${to}:legend=1`,
    '-frames:v', '1', png]);
}
