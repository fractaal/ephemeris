// Builds the app for this machine (npm run dist), into dist/: on Linux an AppImage, on Windows an unsigned x64 NSIS
// installer, on macOS a .dmg (Apple silicon) signed ad hoc for your own Macs, not for distribution. The studio goes in as
// files (its tools run as Node, its files are served), with its runtime dependencies, its version (version.json: a
// build is not a checkout), its icon (icon.svg), and this machine's builds of the plugin host and Vial, the studio's
// synth (bin/: tools/plugins.mjs looks there first), with their licences; on Linux with our Electron
// (EPHEMERIS_ELECTRON_DIST), the shared frames' helper and addon too (bin/: app/frames.cjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'electron-builder';
import { renderIcons } from './icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const git = (...a) => execFileSync('git', a, { cwd: ROOT }).toString().trim();
const sha = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '+' : '');   // (+: with changes not committed)
fs.writeFileSync(path.join(ROOT, 'version.json'), JSON.stringify({ version: sha }) + '\n');

// the icon: the app's own PNGs (its launcher entry on Linux: runtime.mjs), electron-builder's, and macOS's .icns
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
await renderIcons(sizes, (s) => path.join(ROOT, 'app', 'icons', `${s}.png`));
fs.mkdirSync(path.join(ROOT, 'build', 'icons'), { recursive: true });
for (const s of sizes) fs.copyFileSync(path.join(ROOT, 'app', 'icons', `${s}.png`), path.join(ROOT, 'build', 'icons', `${s}x${s}.png`));
if (MAC) {
  const set = path.join(ROOT, 'build', 'icon.iconset');
  fs.mkdirSync(set, { recursive: true });
  for (const [s, names] of Object.entries({ 16: ['16x16'], 32: ['16x16@2x', '32x32'], 64: ['32x32@2x'], 128: ['128x128'], 256: ['128x128@2x', '256x256'], 512: ['256x256@2x', '512x512'], 1024: ['512x512@2x'] })) {
    for (const n of names) fs.copyFileSync(path.join(ROOT, 'app', 'icons', `${s}.png`), path.join(set, `icon_${n}.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(ROOT, 'build', 'icon.icns')]);
}

// the plugin host and Vial, as their build scripts left them in the cache (built now where they are not), and what the
// app must say of them: their licences, and where Vial's source is (bin/NOTICE.md)
const cache = process.env.EPHEMERIS_CACHE || path.join(os.homedir(), '.cache', 'ephemeris');
const hostName = WIN ? 'plughost.exe' : 'plughost';
const hostDir = path.join(cache, 'plughost'), host = path.join(hostDir, hostName), vial = path.join(cache, 'plugins', 'Vial.vst3');
const native = (name) => execFileSync(WIN ? 'powershell.exe' : 'sh', [
  ...(WIN ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] : []), path.join(ROOT, 'native', name, WIN ? 'build.ps1' : 'build.sh'),
], { stdio: 'inherit' });
if (![hostName, 'vst3sdk-LICENSE.txt', 'json-LICENSE.txt'].every((f) => fs.existsSync(path.join(hostDir, f)))) native('plughost');
if (!fs.existsSync(vial)) native('vial');
// (the shared frames, native/frames: the images the viewport's render process draws into and the editor's window shows,
// which need our Electron's patches, experiments/native-renderer/zero-copy)
const framesDir = path.join(cache, 'frames'), FRAMES = ['ephemeris-frames', 'getfd.node'];
const withFrames = process.platform === 'linux' && !!process.env.EPHEMERIS_ELECTRON_DIST;
if (withFrames && !FRAMES.every((f) => fs.existsSync(path.join(framesDir, f)))) native('frames');
const notices = path.join(ROOT, 'build', 'notices');
fs.rmSync(notices, { recursive: true, force: true });
fs.mkdirSync(notices, { recursive: true });
for (const f of ['vst3sdk-LICENSE.txt', 'json-LICENSE.txt']) fs.copyFileSync(path.join(hostDir, f), path.join(notices, f));
fs.copyFileSync(path.join(cache, 'vital-src', 'LICENSE'), path.join(notices, 'Vial-LICENSE.txt'));
const commit = /^commit=([0-9a-f]+)/m.exec(fs.readFileSync(path.join(ROOT, 'native', 'vial', 'build.sh'), 'utf8'))[1];
fs.writeFileSync(path.join(notices, 'NOTICE.md'), `# What bin/ holds

- \`plughost\`: Ephemeris's plugin host (\`native/plughost\`), built with the VST3 SDK (MIT, Steinberg Media
  Technologies: \`vst3sdk-LICENSE.txt\`) and nlohmann/json (MIT: \`json-LICENSE.txt\`).
- \`plugins/Vial.vst3\`: Vial, the open-source build of Vital, by Matt Tytel, under the GNU GPLv3
  (\`Vial-LICENSE.txt\`). Its source: https://github.com/mtytel/vital at commit ${commit}, with Ephemeris's
  \`native/vial/vital.patch\` applied, built by \`native/vial/build.${WIN ? 'ps1' : 'sh'}\` (without Vital's online sign-in).
`);

// (a link in the studio's folders is this machine's, not the studio's: a sound library linked into assets/, say, which
// the build would otherwise copy in whole)
const packed = ['app', 'engine', 'elements', 'tools', 'nle', 'templates', 'assets', 'docs', '.agents'];
const links = packed.flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).map((f) => path.join(d, f)))
  .filter((f) => fs.lstatSync(path.join(ROOT, f)).isSymbolicLink()).map((f) => f.split(path.sep).join('/'));
if (links.length) console.log(`leaving out links: ${links.join(', ')}`);

console.log(`building Ephemeris ${sha} for ${process.platform}…`);
await build({
  projectDir: ROOT,
  config: {
    appId: 'dev.ephemeris.studio', productName: 'Ephemeris', asar: false,
    // (an Electron built with experiments/native-renderer/dawn-rays' patches, unpacked here, in place of the stock one)
    ...(process.env.EPHEMERIS_ELECTRON_DIST ? { electronDist: process.env.EPHEMERIS_ELECTRON_DIST } : {}),
    directories: { output: 'dist', buildResources: 'build' },
    files: ['app/**/*', '!app/build.mjs', 'engine/**/*', 'elements/**/*', 'tools/**/*', 'nle/**/*', 'templates/**/*', 'assets/**/*', 'docs/**/*', '.agents/**/*', 'AGENTS.md', 'vite.config.js', 'version.json', 'package.json',
      // (onnxruntime-web, for tools/models.mjs: only what it loads — Node's entry and WebAssembly, the GPU page's WebGPU build
      // and its WebAssembly — not the rest of the browser builds)
      '!node_modules/onnxruntime-web/{lib,docs}/**', '!node_modules/onnxruntime-web/dist/*.{js,map}', '!node_modules/onnxruntime-web/dist/ort.{all,webgl,webgpu,jspi,wasm,bundle}*', '!node_modules/onnxruntime-web/dist/ort.mjs', '!node_modules/onnxruntime-web/dist/ort.min.mjs', '!node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{jsep,jspi}.*',
      'node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs', ...links.flatMap((l) => [`!${l}`, `!${l}/**`])],
    extraResources: [{ from: host, to: `app/bin/${hostName}` }, { from: vial, to: 'app/bin/plugins/Vial.vst3' }, { from: notices, to: 'app/bin' },
      ...(withFrames ? FRAMES.map((f) => ({ from: path.join(framesDir, f), to: `app/bin/${f}` })) : [])],
    linux: { target: 'AppImage', icon: 'build/icons', category: 'Graphics', executableName: 'ephemeris', artifactName: 'Ephemeris-${version}-${arch}.AppImage' },
    win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'build/icons/256x256.png', artifactName: 'Ephemeris-${version}-${arch}-Setup.exe' },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: false },
    mac: { target: [{ target: 'dmg', arch: ['arm64'] }], icon: 'build/icon.icns', category: 'public.app-category.video', identity: '-', hardenedRuntime: false, artifactName: 'Ephemeris-${version}-${arch}.dmg' },
  },
});
console.log(`dist/: ${fs.readdirSync(path.join(ROOT, 'dist')).filter((f) => /\.(AppImage|dmg|exe)$/.test(f)).join(', ')}`);
