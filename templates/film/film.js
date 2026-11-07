// The film. The engine's reference is .agents/skills/engine, and docs/manual/.
import { createFilm, timeline } from '../../engine/runtime.js';
import { cam } from '../../engine/camera.js';

const TL = await timeline(import.meta.url);
const F = createFilm();

F.run({
  duration: 10,
  scene: (t) => ({ camera: cam(), environment: { backdrop: '#000000' }, nodes: [] }),
});
