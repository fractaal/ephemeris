// The app's icon (icon.svg) as PNGs, drawn by its Electron: its gradients are dithered, where librsvg's band.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../tools/browser.mjs';

const SVG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'icon.svg');

/** Draws the icon at each of `sizes` (px), into file(size). */
export async function renderIcons(sizes, file) {
  const svg = fs.readFileSync(SVG, 'utf8');
  const br = await openBrowser();
  try {
    for (const s of sizes) {
      const p = await br.newPage({ viewport: { width: s, height: s }, transparent: true });
      await p.setContent(`<body style="margin:0;background:transparent">${svg.replace('width="1024" height="1024"', `width="${s}" height="${s}"`)}</body>`);
      fs.mkdirSync(path.dirname(file(s)), { recursive: true });
      await p.screenshot({ path: file(s), omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } });
      await p.close();
    }
  } finally { await br.close(); }
}
