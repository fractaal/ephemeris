// A worker of tools/mix.mjs renderAll: renders each timeline it is given from the sources it shares (workerData: what
// sources() gave, its sounds in shared memory), and sends back its sound (and how far it is, when asked).
import { parentPort, workerData } from 'node:worker_threads';
import { render } from './mix.mjs';

parentPort.on('message', ({ id, tl, opts, progress }) => {
  const [L, R] = render(tl, workerData, progress ? { ...opts, progress: (at) => parentPort.postMessage({ id, at }) } : opts);
  parentPort.postMessage({ id, L, R }, [L.buffer, R.buffer]);
});
