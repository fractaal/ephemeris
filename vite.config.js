// Dev server for projects that need nothing but Ephemeris: http://localhost:5320/projects/<name>/, the workspace's films
// (run in the workspace: see tools/workspace.mjs). Its engine/, elements/, assets/ and nle/ may be links into the
// studio, whose real files are served too, and watched (outside the workspace, Vite would not see them change, and
// would serve each as it first read it).
// (A project that needs another app's code — a product film styled by the product's own CSS — brings its own server;
// see the product-ui skill.)
import fs from 'node:fs';
import path from 'node:path';

const studio = (() => { try { return path.dirname(fs.realpathSync('engine')); } catch { return '.'; } })();
const shared = studio === path.resolve('.') ? [] : ['engine', 'elements', 'assets', 'nle'].map((d) => path.join(studio, d));
export default {
  root: '.', server: { port: 5320, strictPort: true, hmr: false, fs: { allow: ['.', studio] } }, logLevel: 'warn',
  plugins: [{ name: 'studio-files', configureServer(server) { server.watcher.add(shared); } }],
};
