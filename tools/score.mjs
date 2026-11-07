// A project's sound code (its sound.js: engine/score.js), run in Node against a timeline, as renders play it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { score } from '../engine/score.js';

/** What project `dir`'s sound.js does against timeline tl (engine/score.js score()), or null where it has none. Throws
 *  where it cannot be run, saying so. */
export async function scoreOf(dir, tl) {
  const real = fs.realpathSync(dir), f = path.join(real, 'sound.js');   // (named as Node names a module: its real path)
  let st;
  try { st = fs.statSync(f); } catch { return null; }
  try {
    const fn = (await import(`${pathToFileURL(f).href}?v=${st.mtimeMs}`)).default;   // (as it is now: imported again once changed)
    if (typeof fn !== 'function') throw new Error('its default export is not a function of the timeline');
    return score(fn, tl, pathToFileURL(real + path.sep).href);
  } catch (e) { throw new Error(`sound.js: ${e.message}`); }
}
