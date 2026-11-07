// What the packaged app brings the studio that a checkout gets from the machine it is on: Node (Electron runs as Node),
// ffmpeg and ffprobe (its own, pinned: ffmpeg-static, @ffprobe-installer), a login shell's PATH (an app opened from the
// Dock or a launcher gets a bare one, without Homebrew's or nvm's tools), and the studio's shared folders kept where a
// workspace can link to them (an AppImage is mounted somewhere new each time it runs): engine/, elements/, assets/,
// nle/, docs/ (the manual), the skills, AGENTS.md, and an ephemeris command line that runs this
// app's. On Linux, the app's entry in the app launcher, made where it runs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
import { version } from '../tools/workspace.mjs';
import { batchScript, shellQuote } from '../tools/launchers.mjs';

const WIN = process.platform === 'win32';
const batchPath = (p) => p.replaceAll('%', '%%');

/** The studio's environment in a packaged app (root: its code, data: the app's own folder, exe: how to start the app). */
export async function runtime({ root, data, exe }) {
  // Node: this app's Electron, run as Node (each run its own, as an AppImage is mounted afresh); ffmpeg and ffprobe: the
  // app's, ahead of any the machine has
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ephemeris-'));
  // Both shell families on Windows: agents use Git Bash, while people also use PowerShell and Command Prompt.
  // Our own subprocesses use process.execPath, never a shell shim.
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
  if (WIN) fs.writeFileSync(path.join(bin, 'node.cmd'), batchScript(`set "ELECTRON_RUN_AS_NODE=1"\n"${batchPath(process.execPath)}" %*`));
  process.on('exit', () => fs.rmSync(bin, { recursive: true, force: true }));
  const shared = await sharedCopy(root, data, exe);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_') && k !== 'CHROME_DESKTOP' && k.toUpperCase() !== 'PATH'));
  env.PATH = [bin, path.dirname(ffmpeg), path.dirname(ffprobe.path), loginPath() ?? process.env.PATH].filter(Boolean).join(path.delimiter);
  env.EPHEMERIS_SHARED = shared;
  if (WIN) env.ELECTRON_RUN_AS_NODE = '1';
  return { node: WIN ? process.execPath : path.join(bin, 'node'), env };
}

// the PATH a terminal would have (a login shell's): where git and a project's own tools are found
function loginPath() {
  if (WIN) return null;   // Windows apps inherit the user's environment; there is no POSIX login shell.
  const r = spawnSync(process.env.SHELL || '/bin/sh', ['-ilc', 'printf "\\n@@%s@@" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
  return /@@(.*)@@/.exec(r.stdout ?? '')?.[1] || null;
}

// this version's shared folders, copied once into the app's own folder (others' removed), its command line written anew
async function sharedCopy(root, data, exe) {
  const all = path.join(data, 'studio'), dir = path.join(all, version() ?? 'studio');
  if (!fs.existsSync(dir)) {
    const tmp = `${dir}.part`;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const name of ['engine', 'elements', 'assets', 'nle', 'docs', '.agents', 'AGENTS.md']) {
      // The async copy preserves Unicode paths on Windows (Node 22's native cpSync can reinterpret them as ANSI).
      await fs.promises.cp(path.join(root, name), path.join(tmp, name), { recursive: true, dereference: true });
    }
    if (WIN) fs.copyFileSync(path.join(tmp, 'AGENTS.md'), path.join(tmp, 'CLAUDE.md'));
    else fs.symlinkSync('AGENTS.md', path.join(tmp, 'CLAUDE.md'));
    fs.renameSync(tmp, dir);
  }
  for (const other of fs.readdirSync(all)) if (path.join(all, other) !== dir) fs.rmSync(path.join(all, other), { recursive: true, force: true });
  // (run as the app, even from the studio's own children, Claude's panel and its MCP server among them: they have the
  // studio's ELECTRON_RUN_AS_NODE, which would start the app as Node)
  if (WIN) fs.writeFileSync(path.join(dir, 'ephemeris.cmd'), batchScript(`set "ELECTRON_RUN_AS_NODE="\n"${batchPath(exe)}" --cli %*`));
  fs.writeFileSync(path.join(dir, 'ephemeris'), `#!/bin/sh\n# Ephemeris's command line: this app's (see app/runtime.mjs)\nunset ELECTRON_RUN_AS_NODE\nexec ${shellQuote(exe)} --cli "$@"\n`, { mode: 0o755 });
  return dir;
}

/** Linux: the app's entry in the app launcher, and its icon in the icon theme, made where the app runs (an AppImage). */
export function integrate({ root, exe }) {
  const share = path.join(os.homedir(), '.local', 'share'), icons = path.join(root, 'app', 'icons');
  if (!fs.existsSync(icons)) return;
  for (const f of fs.readdirSync(icons)) {
    const s = f.replace('.png', ''), to = path.join(share, 'icons', 'hicolor', `${s}x${s}`, 'apps', 'ephemeris.png');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(icons, f), to);
  }
  const entry = path.join(share, 'applications', 'ephemeris.desktop');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `[Desktop Entry]
Type=Application
Name=Ephemeris
GenericName=Motion design studio
Comment=Films authored as HTML, composited in WebGPU, timed against music
Exec="${exe}"
Icon=ephemeris
Terminal=false
StartupNotify=true
StartupWMClass=ephemeris
Categories=Graphics;Video;AudioVideo;
`);
  spawnSync('update-desktop-database', [path.dirname(entry)], { stdio: 'ignore' });
}
